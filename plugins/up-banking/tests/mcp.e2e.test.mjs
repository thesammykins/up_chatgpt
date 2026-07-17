import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startBroker } from "../mcp/lib/broker-runtime.mjs";
import { writeConfig } from "../mcp/lib/config.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const mockToken = "mock-up-token-value";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function createRpcClient(child) {
  const pending = new Map();
  const lines = [];
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    lines.push(line);
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  let id = 0;
  return {
    lines,
    request(method, params) {
      id += 1;
      const requestId = id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) {
            reject(new Error(`Timed out waiting for ${method}`));
          }
        }, 5_000);
        timer.unref();
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
        );
      });
    },
    close() {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("MCP process closed before responding."));
      }
      pending.clear();
      reader.close();
    },
  };
}

test("production MCP reaches Up only through the credential-isolating broker", async () => {
  const requests = [];
  const api = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/util/ping") {
      response.end(JSON.stringify({ meta: { statusEmoji: "test-ok" } }));
      return;
    }
    if (request.url.startsWith("/api/v1/accounts")) {
      response.end(
        JSON.stringify({
          data: [
            {
              type: "accounts",
              id: "account-1",
              attributes: {
                displayName: "Spending",
                accountType: "TRANSACTIONAL",
                ownershipType: "INDIVIDUAL",
                balance: { currencyCode: "AUD", value: "42.00", valueInBaseUnits: 4200 },
                createdAt: "2026-07-14T00:00:00+10:00",
              },
              relationships: { transactions: { links: { related: "unused-in-test" } } },
            },
          ],
          links: { prev: null, next: null },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({ errors: [{ status: "404", title: "Not found", detail: "Not found" }] }),
    );
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-e2e-"));
  const configPath = path.join(root, "config.json");
  const socketPath = path.join(root, "broker.sock");
  const secretRef = "op://test-vault/test-item/test-field";
  let broker;
  let child;
  let rpc;
  let stderr = "";

  try {
    const address = await listen(api);
    await writeConfig(
      {
        provider: "onepassword",
        secretRef,
        idleSeconds: 60,
        maxSessionSeconds: 300,
      },
      configPath,
    );
    broker = await startBroker({
      token: Buffer.from(mockToken),
      socketPath,
      baseURL: `http://127.0.0.1:${address.port}/api/v1/`,
      idleSeconds: 60,
      maxSessionSeconds: 300,
    });

    child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        UP_BANKING_CONFIG_PATH: configPath,
        UP_BANKING_BROKER_SOCKET: socketPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    rpc = createRpcClient(child);

    const initialized = await rpc.request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(initialized.result.serverInfo.name, "Up Banking for Codex");

    const listed = await rpc.request("tools/list");
    assert.ok(listed.result.tools.some((tool) => tool.name === "up_cashflow_summary"));

    const status = await rpc.request("tools/call", {
      name: "up_auth_status",
      arguments: {},
    });
    assert.equal(status.result.structuredContent.configured, true);
    assert.equal(status.result.structuredContent.unlocked, true);

    const pinged = await rpc.request("tools/call", { name: "up_ping", arguments: {} });
    assert.equal(pinged.result.structuredContent.ok, true);

    const accounts = await rpc.request("tools/call", {
      name: "up_list_accounts",
      arguments: { page_size: 20 },
    });
    assert.equal(accounts.result.structuredContent.accounts[0].balance.value, "42.00");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.authorization === `Bearer ${mockToken}`));

    const rawConfig = await readFile(configPath, "utf8");
    const protocolOutput = `${rpc.lines.join("\n")}\n${stderr}`;
    assert.doesNotMatch(rawConfig, new RegExp(mockToken, "u"));
    assert.doesNotMatch(protocolOutput, new RegExp(mockToken, "u"));
    assert.doesNotMatch(protocolOutput, /op:\/\/test-vault/u);
  } finally {
    await stopChild(child);
    rpc?.close();
    await broker?.close("test_complete");
    await closeServer(api);
  }
});
