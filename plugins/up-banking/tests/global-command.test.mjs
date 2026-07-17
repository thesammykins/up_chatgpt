import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = path.join(pluginRoot, "scripts", "install-global-command.mjs");

function runNode(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("global launcher is executable, relocatable, and contains no credential material", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-global-command-"));
  const target = path.join(root, "bin", "up-banking");
  const result = await runNode(installerPath, "--target", target);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Installed global Up Banking command/u);
  assert.equal((await stat(target)).mode & 0o777, 0o755);

  const wrapper = await readFile(target, "utf8");
  assert.match(wrapper, /codex plugin list/u);
  assert.match(wrapper, /scripts\/up-banking-auth\.mjs/u);
  assert.doesNotMatch(wrapper, /op:\/\//u);
  assert.doesNotMatch(wrapper, /(?:api[_-]?token|access[_-]?token|authorization|bearer)/iu);
});
