import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConfigError,
  publicConfig,
  readConfig,
  validateConfig,
  writeConfig,
} from "../mcp/lib/config.mjs";

test("public broker status exposes session policy but not credential-provider references", () => {
  const status = publicConfig({
    version: 1,
    provider: "onepassword",
    secretRef: "op://private-vault/private-item/private-field",
    account: "private-account.1password.com",
    idleSeconds: 600,
    maxSessionSeconds: 3_600,
  });

  assert.deepEqual(status, {
    configured: true,
    provider: "onepassword",
    idleSeconds: 600,
    maxSessionSeconds: 3_600,
    secretReferenceStored: true,
    accountSelected: true,
    keychainAccountSelected: false,
  });
  assert.doesNotMatch(JSON.stringify(status), /private-vault|private-item|private-field|private-account/u);
});

test("supports a manual session without storing a credential reference", () => {
  const config = validateConfig({ provider: "manual-session", idleSeconds: 300, maxSessionSeconds: 900 });
  assert.deepEqual(config, {
    version: 1,
    provider: "manual-session",
    idleSeconds: 300,
    maxSessionSeconds: 900,
  });
  assert.deepEqual(publicConfig(config), {
    configured: true,
    provider: "manual-session",
    idleSeconds: 300,
    maxSessionSeconds: 900,
    secretReferenceStored: false,
    accountSelected: false,
    keychainAccountSelected: false,
  });
});

test("accepts a macOS Keychain account without a token field", { skip: process.platform !== "darwin" }, () => {
  assert.deepEqual(validateConfig({ provider: "macos-keychain", keychainAccount: "up-banking", idleSeconds: 600, maxSessionSeconds: 3600 }), {
    version: 1,
    provider: "macos-keychain",
    keychainAccount: "up-banking",
    idleSeconds: 600,
    maxSessionSeconds: 3600,
  });
});

test("writes broker configuration atomically with restrictive permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-config-"));
  const configPath = path.join(root, "nested", "config.json");
  const secretRef = "op://vault-id/item-id/field-id";

  await writeConfig(
    {
      provider: "onepassword",
      secretRef,
      account: "my.1password.com",
      idleSeconds: 300,
      maxSessionSeconds: 1_800,
    },
    configPath,
  );

  assert.deepEqual(await readConfig(configPath), {
    version: 1,
    provider: "onepassword",
    secretRef,
    account: "my.1password.com",
    idleSeconds: 300,
    maxSessionSeconds: 1_800,
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
});

test("persists only a 1Password reference, never a token field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-config-"));
  const configPath = path.join(root, "config.json");
  const secretRef = "op://vault-id/item-id/field-id";

  await writeConfig({ provider: "onepassword", secretRef }, configPath);
  const raw = await readFile(configPath, "utf8");

  assert.match(raw, /"secretRef"/u);
  assert.doesNotMatch(raw, /"(?:apiToken|accessToken|bearerToken|password)"\s*:/u);
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    provider: "onepassword",
    secretRef,
    idleSeconds: 600,
    maxSessionSeconds: 3_600,
  });
});

test("rejects malformed or secret-bearing broker configuration", () => {
  assert.throws(() => validateConfig({ provider: "environment" }), ConfigError);
  assert.throws(() => validateConfig({ provider: "manual-session", apiToken: "must-not-be-here" }), ConfigError);
  assert.throws(() => validateConfig({ provider: "manual-session", secretRef: "op://vault/item/field" }), ConfigError);
  assert.throws(
    () => validateConfig({ provider: "onepassword", secretRef: "not-a-reference" }),
    ConfigError,
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "onepassword",
        secretRef: "op://vault/item/field",
        idleSeconds: 59,
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "onepassword",
        secretRef: "op://vault/item/field",
        idleSeconds: 1_000,
        maxSessionSeconds: 999,
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "onepassword",
        secretRef: "op://vault/item/field",
        maxSessionSeconds: 43_201,
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "onepassword",
        secretRef: "op://vault/item/field",
        cacheSeconds: 600,
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      validateConfig({
        provider: "onepassword",
        secretRef: "op://vault/item/field",
        apiToken: "must-not-be-here",
      }),
    ConfigError,
  );
});

test("refuses a symlinked configuration directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "up-banking-config-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await mkdir(target);
  await symlink(target, linked);

  await assert.rejects(
    () =>
      writeConfig(
        { provider: "onepassword", secretRef: "op://vault/item/field" },
        path.join(linked, "config.json"),
      ),
    ConfigError,
  );
});
