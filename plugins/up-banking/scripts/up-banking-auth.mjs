#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

import {
  BrokerApiClient,
  BrokerError,
  BrokerSession,
  defaultBrokerSocketPath,
  sendBrokerMessage,
} from "../mcp/lib/broker-client.mjs";
import {
  ConfigError,
  defaultConfigPath,
  executableExists,
  readConfig,
  removeConfig,
  validateConfig,
  writeConfig,
} from "../mcp/lib/config.mjs";
import { UpApiError } from "../mcp/lib/up-api.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("./up-banking-broker.mjs", import.meta.url));
const KEYCHAIN_SCRIPT = fileURLToPath(new URL("./up-banking-keychain.swift", import.meta.url));
const MAX_TOKEN_BYTES = 4096;
const READY_TIMEOUT_MS = 10_000;

class AuthCliError extends Error {
  constructor(message, code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthCliError";
    this.code = code;
  }
}

const HELP = `Up Banking secure session setup

Usage:
  node scripts/up-banking-auth.mjs configure
  node scripts/up-banking-auth.mjs unlock
  node scripts/up-banking-auth.mjs status
  node scripts/up-banking-auth.mjs test
  node scripts/up-banking-auth.mjs lock
  node scripts/up-banking-auth.mjs remove-config

configure lets you choose 1Password, macOS Keychain with Touch ID/passcode, or
a no-persistence manual session. unlock must run in a real Terminal and passes
the credential through a private pipe to a bounded local broker. Never paste a
token into Codex or pass it in a command argument or environment variable.
`;

function print(value) {
  output.write(`${value}\n`);
}

function integerAnswer(answer, fallback) {
  const candidate = answer.trim();
  if (!candidate) return fallback;
  const value = Number(candidate);
  if (!Number.isInteger(value)) {
    throw new AuthCliError("Session limits must be whole seconds.", "INVALID_CONFIG");
  }
  return value;
}

async function promptConfiguration() {
  if (!input.isTTY || !output.isTTY) {
    throw new AuthCliError(
      "Run configure in a real interactive Terminal.",
      "INTERACTIVE_TERMINAL_REQUIRED",
    );
  }
  const terminal = readline.createInterface({ input, output });
  try {
    const choices = ["1. 1Password (recommended)"];
    if (process.platform === "darwin") {
      choices.push("2. macOS Keychain (Touch ID or passcode)");
    }
    choices.push(`${choices.length + 1}. Manual session (no persistent credential)`);
    print(`Choose an authentication method:\n${choices.join("\n")}`);
    const answer = (await terminal.question("Choice [1]: ")).trim() || "1";
    const manualChoice = String(choices.length);
    let provider;
    if (answer === "1") provider = "onepassword";
    else if (process.platform === "darwin" && answer === "2") provider = "macos-keychain";
    else if (answer === manualChoice) provider = "manual-session";
    else throw new AuthCliError("Choose one of the listed authentication methods.", "INVALID_CONFIG");

    const base = { provider };
    if (provider === "onepassword") {
      const secretRef = (
        await terminal.question("1Password field reference (op://vault/item/field): ")
      ).trim();
      const account = (
        await terminal.question("1Password account shorthand or sign-in address (optional): ")
      ).trim();
      base.secretRef = secretRef;
      if (account) base.account = account;
    } else if (provider === "macos-keychain") {
      const keychainAccount = (
        await terminal.question("Keychain account name [up-banking-codex]: ")
      ).trim() || "up-banking-codex";
      base.keychainAccount = keychainAccount;
    }
    const idleSeconds = integerAnswer(
      await terminal.question("Idle session limit in seconds [600]: "),
      600,
    );
    const maxSessionSeconds = integerAnswer(
      await terminal.question("Absolute session limit in seconds [3600]: "),
      3600,
    );
    return validateConfig({ ...base, idleSeconds, maxSessionSeconds });
  } finally {
    terminal.close();
  }
}

function validateToken(token, provider) {
  if (!Buffer.isBuffer(token) || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
    token?.fill?.(0);
    throw new AuthCliError(`${provider} returned an invalid credential.`, "INVALID_TOKEN");
  }
  for (const byte of token) {
    if (byte === 0 || byte === 10 || byte === 13) {
      token.fill(0);
      throw new AuthCliError(`${provider} returned an invalid credential.`, "INVALID_TOKEN");
    }
  }
  return token;
}

async function findOnePasswordCli() {
  const candidates = [
    "/opt/homebrew/bin/op",
    "/usr/local/bin/op",
    "op",
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (await executableExists(candidate)) return candidate;
  }
  return null;
}

function readOnePasswordToken(command, config) {
  if (!input.isTTY) {
    throw new AuthCliError(
      "Run unlock in a real interactive Terminal so 1Password can request Touch ID.",
      "INTERACTIVE_TERMINAL_REQUIRED",
    );
  }
  const args = ["read", "--no-newline"];
  if (config.account) args.push("--account", config.account);
  args.push(config.secretRef);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });

    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      clearChunks();
      child.kill("SIGTERM");
      reject(new AuthCliError(message, code));
    };

    child.stdout.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_TOKEN_BYTES) {
        chunk.fill(0);
        fail("1Password returned an invalid credential.", "INVALID_TOKEN");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      // Deliberately discard provider output so secret metadata is not copied into logs.
      chunk.fill(0);
    });
    child.once("error", () => {
      fail("1Password CLI could not be started.", "ONEPASSWORD_START_FAILED");
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || bytes === 0) {
        fail(
          "1Password did not unlock the referenced field. Retry and approve Touch ID.",
          "ONEPASSWORD_UNLOCK_FAILED",
        );
        return;
      }
      const token = Buffer.alloc(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        chunk.copy(token, offset);
        offset += chunk.length;
        chunk.fill(0);
      }
      chunks.length = 0;
      settled = true;
      try {
        resolve(validateToken(token, "1Password"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runKeychain(action, account, token) {
  if (process.platform !== "darwin") {
    throw new AuthCliError("macOS Keychain is available only on macOS.", "UNSUPPORTED_PLATFORM");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("swift", [KEYCHAIN_SCRIPT, action, account], {
      stdio: [token ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_TOKEN_BYTES) chunks.push(chunk);
      else chunk.fill(0);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8").slice(0, 200);
      chunk.fill(0);
    });
    child.once("error", () => reject(new AuthCliError("macOS Keychain helper could not be started.", "KEYCHAIN_START_FAILED")));
    child.once("close", (code) => {
      if (code !== 0) {
        for (const chunk of chunks) chunk.fill(0);
        return reject(new AuthCliError(
          action === "read" ? "macOS Keychain authentication was not completed." : "macOS Keychain setup failed.",
          "KEYCHAIN_FAILED",
        ));
      }
      if (action !== "read") return resolve();
      const value = Buffer.concat(chunks, bytes);
      for (const chunk of chunks) chunk.fill(0);
      try { resolve(validateToken(value, "macOS Keychain")); } catch (error) { reject(error); }
    });
    if (token) child.stdin.end(token, () => token.fill(0));
  });
}

async function readManualToken() {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new AuthCliError("Run manual-session unlock in a real interactive Terminal.", "INTERACTIVE_TERMINAL_REQUIRED");
  }
  output.write("Up Banking access token (not saved): ");
  return new Promise((resolve, reject) => {
    const bytes = [];
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      output.write("\n");
      if (error) return reject(error);
      try { resolve(validateToken(Buffer.from(bytes), "Manual session")); } catch (failure) { reject(failure); }
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new AuthCliError("Manual entry cancelled.", "CANCELLED"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 127 || byte === 8) bytes.pop();
        else if (bytes.length < MAX_TOKEN_BYTES) bytes.push(byte);
      }
      if (bytes.length >= MAX_TOKEN_BYTES) finish(new AuthCliError("Manual session returned an invalid credential.", "INVALID_TOKEN"));
    };
    input.on("data", onData);
  });
}

function minimalBrokerEnvironment(configPath, socketPath) {
  return Object.fromEntries(
    Object.entries({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TMPDIR: process.env.TMPDIR,
      UP_BANKING_CONFIG_PATH: configPath,
      UP_BANKING_BROKER_SOCKET: socketPath,
    }).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function startDetachedBroker(token, configPath, socketPath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [BROKER_SCRIPT, "serve"], {
        cwd: path.dirname(BROKER_SCRIPT),
        detached: true,
        env: minimalBrokerEnvironment(configPath, socketPath),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      token.fill(0);
      reject(new AuthCliError("The local Up Banking broker could not be started.", "BROKER_START_FAILED"));
      return;
    }
    let settled = false;
    let outputBytes = 0;
    const outputChunks = [];
    const timer = setTimeout(() => {
      fail("The local Up Banking broker did not start in time.", "BROKER_START_TIMEOUT");
    }, READY_TIMEOUT_MS);
    timer.unref?.();

    const clearOutput = () => {
      for (const chunk of outputChunks) chunk.fill(0);
      outputChunks.length = 0;
    };
    const clearToken = () => token.fill(0);
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearToken();
      clearOutput();
      child.kill("SIGTERM");
      reject(new AuthCliError(message, code));
    };

    child.stdin.once("error", () => {
      fail("The credential could not be transferred to the local broker.", "BROKER_PIPE_FAILED");
    });
    child.once("error", () => {
      fail("The local Up Banking broker could not be started.", "BROKER_START_FAILED");
    });
    child.once("exit", (code) => {
      if (!settled) {
        fail(
          code === 0
            ? "The local Up Banking broker exited before it was ready."
            : "The local Up Banking broker could not be started.",
          "BROKER_START_FAILED",
        );
      }
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > 128) {
        fail("The local Up Banking broker returned invalid startup data.", "BROKER_START_FAILED");
        return;
      }
      outputChunks.push(chunk);
      const line = Buffer.concat(outputChunks, outputBytes).toString("utf8");
      if (!line.includes("\n")) return;
      if (line !== "READY\n") {
        fail("The local Up Banking broker returned invalid startup data.", "BROKER_START_FAILED");
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearOutput();
      child.stdout.destroy();
      child.unref();
      resolve();
    });

    child.stdin.end(token, clearToken);
  });
}

async function lockBroker(socketPath, { quiet = false } = {}) {
  try {
    await sendBrokerMessage(socketPath, { op: "shutdown" });
    if (!quiet) print("Locked the local Up Banking broker and cleared its credential.");
    return true;
  } catch (error) {
    if (error instanceof BrokerError && ["BROKER_LOCKED", "BROKER_UNAVAILABLE"].includes(error.code)) {
      if (!quiet) print("The local Up Banking broker is already locked.");
      return false;
    }
    throw error;
  }
}

async function main() {
  const command = process.argv[2] || "help";
  const configPath = defaultConfigPath();
  const socketPath = defaultBrokerSocketPath(configPath);

  switch (command) {
    case "configure": {
      const config = await promptConfiguration();
      await lockBroker(socketPath, { quiet: true });
      if (config.provider === "macos-keychain") {
        const token = await readManualToken();
        await runKeychain("store", config.keychainAccount, token);
      }
      await writeConfig(config, configPath);
      if (config.provider === "macos-keychain") {
        print("Configured macOS Keychain with the token protected by Touch ID or passcode.");
      } else if (config.provider === "manual-session") {
        print("Configured manual sessions. The token will never be stored.");
      } else {
        print("Configured Up Banking with a 1Password reference only; no token was read or stored.");
      }
      return;
    }
    case "unlock": {
      const config = await readConfig(configPath);
      if (!config) {
        throw new AuthCliError("Up Banking is not configured. Run configure first.", "NOT_CONFIGURED");
      }
      const current = await new BrokerSession({ configPath, socketPath }).status();
      if (current.unlocked) {
        print("The local Up Banking broker is already unlocked.");
        return;
      }
      if (
        current.brokerStatus &&
        !["BROKER_LOCKED", "BROKER_UNAVAILABLE"].includes(current.brokerStatus)
      ) {
        throw new AuthCliError(
          "The existing local broker socket is not responding safely. Run lock and retry.",
          "BROKER_UNAVAILABLE",
        );
      }
      let token;
      if (config.provider === "onepassword") {
        const op = await findOnePasswordCli();
        if (!op) throw new AuthCliError("1Password CLI is not installed or executable.", "ONEPASSWORD_NOT_INSTALLED");
        token = await readOnePasswordToken(op, config);
      } else if (config.provider === "macos-keychain") {
        token = await runKeychain("read", config.keychainAccount);
      } else {
        token = await readManualToken();
      }
      await startDetachedBroker(token, configPath, socketPath);
      print(
        `Unlocked the local broker (${config.idleSeconds}s idle, ${config.maxSessionSeconds}s maximum).`,
      );
      return;
    }
    case "status": {
      const status = await new BrokerSession({ configPath, socketPath }).status();
      status.onePasswordCliAvailable = (await findOnePasswordCli()) !== null;
      status.macosKeychainAvailable = process.platform === "darwin" && (await executableExists("swift"));
      print(JSON.stringify(status, null, 2));
      return;
    }
    case "test": {
      const status = await new BrokerSession({ configPath, socketPath }).status();
      if (!status.unlocked) {
        throw new AuthCliError(
          "The local Up Banking broker is locked. Run unlock in a Terminal first.",
          "BROKER_LOCKED",
        );
      }
      const client = new BrokerApiClient({ socketPath });
      const response = await client.request("util/ping");
      print(`Authenticated with Up successfully (${response.body?.meta?.statusEmoji || "OK"}).`);
      return;
    }
    case "lock":
      await lockBroker(socketPath);
      return;
    case "remove-config": {
      await lockBroker(socketPath, { quiet: true });
      const config = await readConfig(configPath);
      const removed = await removeConfig(configPath);
      if (config?.provider === "macos-keychain") await runKeychain("delete", config.keychainAccount);
      print(removed ? "Removed the local credential configuration." : "No configuration existed.");
      print("Any 1Password item was left untouched; macOS Keychain entries are removed with their configuration.");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return;
    default:
      throw new AuthCliError(`Unknown command.\n\n${HELP}`, "UNKNOWN_COMMAND");
  }
}

main().catch((error) => {
  const safe =
    error instanceof AuthCliError ||
    error instanceof BrokerError ||
    error instanceof ConfigError ||
    error instanceof UpApiError;
  process.stderr.write(
    `Up Banking setup failed: ${safe ? error.message : "The command could not be completed."}\n`,
  );
  process.exitCode = 1;
});
