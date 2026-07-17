import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const CONFIG_VERSION = 1;
const DEFAULT_IDLE_SECONDS = 600;
const DEFAULT_MAX_SESSION_SECONDS = 3600;
const MIN_IDLE_SECONDS = 60;
const MAX_IDLE_SECONDS = 3600;
const MIN_MAX_SESSION_SECONDS = 300;
const MAX_MAX_SESSION_SECONDS = 43_200;

export class ConfigError extends Error {
  constructor(message, code = "CONFIG_ERROR") {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function defaultConfigPath() {
  if (process.env.UP_BANKING_CONFIG_PATH) {
    return path.resolve(process.env.UP_BANKING_CONFIG_PATH);
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Up Banking for Codex",
      "config.json",
    );
  }
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "up-banking-codex", "config.json");
}

function requirePlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Credential configuration must be a JSON object.");
  }
  return value;
}

export function validateConfig(input) {
  const value = requirePlainObject(input);
  const allowedKeys = new Set([
    "version",
    "provider",
    "secretRef",
    "account",
    "keychainAccount",
    "idleSeconds",
    "maxSessionSeconds",
  ]);
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new ConfigError(
      `Credential configuration contains unsupported field(s): ${unexpectedKeys.join(", ")}.`,
    );
  }
  const version = value.version ?? CONFIG_VERSION;
  if (version !== CONFIG_VERSION) {
    throw new ConfigError(`Unsupported credential configuration version: ${version}.`);
  }
  if (!["onepassword", "macos-keychain", "manual-session"].includes(value.provider)) {
    throw new ConfigError(
      "Credential provider must be onepassword, macos-keychain, or manual-session.",
    );
  }

  const idleSeconds = value.idleSeconds ?? DEFAULT_IDLE_SECONDS;
  if (
    !Number.isInteger(idleSeconds) ||
    idleSeconds < MIN_IDLE_SECONDS ||
    idleSeconds > MAX_IDLE_SECONDS
  ) {
    throw new ConfigError(
      `idleSeconds must be an integer between ${MIN_IDLE_SECONDS} and ${MAX_IDLE_SECONDS}.`,
    );
  }
  const maxSessionSeconds = value.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS;
  if (
    !Number.isInteger(maxSessionSeconds) ||
    maxSessionSeconds < MIN_MAX_SESSION_SECONDS ||
    maxSessionSeconds > MAX_MAX_SESSION_SECONDS ||
    maxSessionSeconds < idleSeconds
  ) {
    throw new ConfigError(
      `maxSessionSeconds must be an integer from ${Math.max(MIN_MAX_SESSION_SECONDS, idleSeconds)} to ${MAX_MAX_SESSION_SECONDS}.`,
    );
  }

  const config = {
    version: CONFIG_VERSION,
    provider: value.provider,
    idleSeconds,
    maxSessionSeconds,
  };
  if (value.provider === "onepassword") {
    if (
      typeof value.secretRef !== "string" ||
      !value.secretRef.startsWith("op://") ||
      value.secretRef.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(value.secretRef)
    ) {
      throw new ConfigError("1Password secretRef must be a valid op:// reference.");
    }
    config.secretRef = value.secretRef;
  } else if (value.secretRef !== undefined || value.account !== undefined) {
    throw new ConfigError("Only the 1Password provider may store a secret reference or account.");
  }
  if (value.provider === "onepassword" && value.account !== undefined) {
    if (
      typeof value.account !== "string" ||
      value.account.trim().length === 0 ||
      value.account.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(value.account)
    ) {
      throw new ConfigError("1Password account must be a non-empty shorthand or sign-in address.");
    }
    config.account = value.account.trim();
  }
  if (value.provider === "macos-keychain") {
    if (process.platform !== "darwin") {
      throw new ConfigError("macos-keychain is available only on macOS.");
    }
    if (
      typeof value.keychainAccount !== "string" ||
      value.keychainAccount.trim().length === 0 ||
      value.keychainAccount.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(value.keychainAccount)
    ) {
      throw new ConfigError("macOS Keychain requires a non-empty account name.");
    }
    config.keychainAccount = value.keychainAccount.trim();
  } else if (value.keychainAccount !== undefined) {
    throw new ConfigError("Only the macOS Keychain provider may store a Keychain account name.");
  }
  return config;
}

async function rejectSymlink(filePath) {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new ConfigError(`Refusing to use a symbolic-link configuration: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new ConfigError(`Refusing to use a non-directory configuration path: ${directory}`);
  }
  await chmod(directory, 0o700);
}

export async function readConfig(configPath = defaultConfigPath()) {
  await rejectSymlink(configPath);
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new ConfigError(`Unable to read credential configuration: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("Credential configuration is not valid JSON.");
  }
  return validateConfig(parsed);
}

export async function writeConfig(input, configPath = defaultConfigPath()) {
  const config = validateConfig(input);
  const directory = path.dirname(configPath);
  await ensurePrivateDirectory(directory);
  await rejectSymlink(configPath);

  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporaryPath = path.join(directory, `.config.json.${suffix}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return config;
}

export async function removeConfig(configPath = defaultConfigPath()) {
  await rejectSymlink(configPath);
  try {
    await unlink(configPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function executableExists(command) {
  if (command.includes(path.sep)) {
    try {
      await access(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    try {
      await access(path.join(entry, command), fsConstants.X_OK);
      return true;
    } catch {
      // Continue looking.
    }
  }
  return false;
}

export function publicConfig(config) {
  if (!config) {
    return { configured: false };
  }
  return {
    configured: true,
    provider: config.provider,
    idleSeconds: config.idleSeconds,
    maxSessionSeconds: config.maxSessionSeconds,
    secretReferenceStored: config.provider === "onepassword",
    accountSelected: config.provider === "onepassword" && config.account !== undefined,
    keychainAccountSelected: config.provider === "macos-keychain",
  };
}

export const configDefaults = Object.freeze({
  version: CONFIG_VERSION,
  idleSeconds: DEFAULT_IDLE_SECONDS,
  maxSessionSeconds: DEFAULT_MAX_SESSION_SECONDS,
  minIdleSeconds: MIN_IDLE_SECONDS,
  maxIdleSeconds: MAX_IDLE_SECONDS,
  minMaxSessionSeconds: MIN_MAX_SESSION_SECONDS,
  maxMaxSessionSeconds: MAX_MAX_SESSION_SECONDS,
});
