import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sendBrokerMessage } from "../mcp/lib/broker-client.mjs";
import { writeConfig } from "../mcp/lib/config.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const brokerScript = path.join(pluginRoot, "scripts", "up-banking-broker.mjs");

test("broker entrypoint accepts the token only over stdin and emits a non-secret readiness line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-entrypoint-"));
  const configPath = path.join(root, "config.json");
  const socketPath = path.join(root, "broker.sock");
  const token = "entrypoint-private-token";
  await writeConfig(
    {
      provider: "onepassword",
      secretRef: "op://vault-id/item-id/field-id",
      idleSeconds: 60,
      maxSessionSeconds: 300,
    },
    configPath,
  );

  const environment = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    UP_BANKING_CONFIG_PATH: configPath,
    UP_BANKING_BROKER_SOCKET: socketPath,
  };
  const child = spawn(process.execPath, [brokerScript, "serve"], {
    cwd: pluginRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = Promise.race([
    once(lines, "line"),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for broker readiness.")), 5_000);
      timer.unref();
    }),
  ]);
  child.stdin.end(Buffer.from(token));

  try {
    assert.equal((await ready)[0], "READY");
    const status = await sendBrokerMessage(socketPath, { op: "status" });
    assert.equal(status.unlocked, true);
    await sendBrokerMessage(socketPath, { op: "shutdown" });
    const exitCode = child.exitCode ?? (await once(child, "exit"))[0];
    assert.equal(exitCode, 0);

    const persisted = await readFile(configPath, "utf8");
    const processMetadata = `${JSON.stringify(child.spawnargs)}\n${JSON.stringify(environment)}`;
    assert.doesNotMatch(persisted, new RegExp(token, "u"));
    assert.doesNotMatch(processMetadata, new RegExp(token, "u"));
    assert.doesNotMatch(stderr, new RegExp(token, "u"));
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});
