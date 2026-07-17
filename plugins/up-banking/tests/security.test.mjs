import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

test("plugin manifests do not embed or request a bearer token environment variable", async () => {
  const manifest = await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8");
  const mcp = await readFile(path.join(pluginRoot, ".mcp.json"), "utf8");
  const combined = `${manifest}\n${mcp}`;

  assert.doesNotMatch(combined, /UP_API_TOKEN|bearer_token_env_var|Authorization|secretRef/u);
  assert.deepEqual(JSON.parse(mcp), {
    mcpServers: {
      "up-banking": {
        command: "node",
        args: ["./mcp/server.mjs"],
        cwd: ".",
        tool_timeout_sec: 90,
      },
    },
  });
});

test("production MCP entrypoint is broker-backed and cannot load or send the token", async () => {
  const server = await readFile(path.join(pluginRoot, "mcp", "server.mjs"), "utf8");

  assert.match(server, /broker/iu);
  assert.doesNotMatch(
    server,
    /CredentialManager|credentials\.mjs|UpApiClient|up-api\.mjs|getToken|Authorization|Bearer|secretRef|UP_BANKING_OP_PATH|UP_BANKING.*API/u,
  );
});

test("interactive providers hand the credential to the broker only through stdin", async () => {
  const auth = await readFile(
    path.join(pluginRoot, "scripts", "up-banking-auth.mjs"),
    "utf8",
  );
  const broker = await readFile(
    path.join(pluginRoot, "scripts", "up-banking-broker.mjs"),
    "utf8",
  );
  const keychain = await readFile(
    path.join(pluginRoot, "scripts", "up-banking-keychain.swift"),
    "utf8",
  );

  assert.match(auth, /\["read", "--no-newline"\]/u);
  assert.match(auth, /child\.stdin\.end\(token/u);
  assert.match(auth, /manual-session/u);
  assert.match(keychain, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/u);
  assert.match(keychain, /\.userPresence/u);
  assert.match(keychain, /kSecUseAuthenticationContext/u);
  assert.match(broker, /for await \(const chunk of process\.stdin\)/u);
  assert.doesNotMatch(
    `${auth}\n${broker}\n${keychain}`,
    /UP_API_TOKEN|UP_BANKING_TOKEN|API_TOKEN|--token|Bearer \$\{|Authorization/u,
  );
});
