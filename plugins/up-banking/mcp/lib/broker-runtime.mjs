import net from "node:net";
import path from "node:path";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";

import { UpApiClient, UpApiError, upApiConstants } from "./up-api.mjs";

const MAX_TOKEN_BYTES = 4096;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 75_000;

class BrokerRuntimeError extends Error {
  constructor(message, code = "BROKER_ERROR") {
    super(message);
    this.name = "BrokerRuntimeError";
    this.code = code;
  }
}

class MemoryCredential {
  constructor(token, onCleared) {
    if (!Buffer.isBuffer(token)) {
      throw new TypeError("Broker token must be supplied as a Buffer.");
    }
    this.token = token;
    this.onCleared = onCleared;
    this.validate();
  }

  validate() {
    if (this.token.length === 0 || this.token.length > MAX_TOKEN_BYTES) {
      this.clear();
      throw new BrokerRuntimeError("The credential supplied to the broker is invalid.", "INVALID_TOKEN");
    }
    for (const byte of this.token) {
      if (byte === 0 || byte === 10 || byte === 13) {
        this.clear();
        throw new BrokerRuntimeError(
          "The credential supplied to the broker is invalid.",
          "INVALID_TOKEN",
        );
      }
    }
  }

  async getToken() {
    if (!this.token || this.token.length === 0) {
      throw new BrokerRuntimeError("The local Up Banking broker is locked.", "BROKER_LOCKED");
    }
    return this.token;
  }

  clear() {
    if (this.token) {
      this.token.fill(0);
      this.token = null;
      this.onCleared?.();
    }
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequest(message) {
  if (!plainObject(message) || typeof message.op !== "string") {
    throw new BrokerRuntimeError("Invalid broker request.", "INVALID_REQUEST");
  }
  if (["status", "shutdown"].includes(message.op)) {
    if (Object.keys(message).some((key) => !["op"].includes(key))) {
      throw new BrokerRuntimeError("Invalid broker request fields.", "INVALID_REQUEST");
    }
    return message;
  }
  if (message.op !== "request") {
    throw new BrokerRuntimeError("Unknown broker operation.", "INVALID_REQUEST");
  }
  if (
    typeof message.pathOrURL !== "string" ||
    message.pathOrURL.length === 0 ||
    message.pathOrURL.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(message.pathOrURL)
  ) {
    throw new BrokerRuntimeError("Invalid Up API path.", "INVALID_REQUEST");
  }
  const allowedTopLevel = new Set(["op", "pathOrURL", "options"]);
  if (Object.keys(message).some((key) => !allowedTopLevel.has(key))) {
    throw new BrokerRuntimeError("Invalid broker request fields.", "INVALID_REQUEST");
  }
  const options = message.options ?? {};
  if (!plainObject(options)) {
    throw new BrokerRuntimeError("Invalid Up API request options.", "INVALID_REQUEST");
  }
  const allowedOptionKeys = new Set(["method", "query", "body", "idempotent", "maxRetries"]);
  if (Object.keys(options).some((key) => !allowedOptionKeys.has(key))) {
    throw new BrokerRuntimeError("Invalid Up API request options.", "INVALID_REQUEST");
  }
  const method = options.method ?? "GET";
  if (!["GET", "PATCH", "POST", "DELETE"].includes(method)) {
    throw new BrokerRuntimeError("Unsupported Up API method.", "INVALID_REQUEST");
  }
  if (options.query !== undefined) {
    if (!plainObject(options.query) || Object.keys(options.query).length > 50) {
      throw new BrokerRuntimeError("Invalid Up API query.", "INVALID_REQUEST");
    }
    for (const value of Object.values(options.query)) {
      if (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      ) {
        throw new BrokerRuntimeError("Invalid Up API query value.", "INVALID_REQUEST");
      }
    }
  }
  if (options.idempotent !== undefined && typeof options.idempotent !== "boolean") {
    throw new BrokerRuntimeError("Invalid idempotency option.", "INVALID_REQUEST");
  }
  if (
    options.maxRetries !== undefined &&
    (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 2)
  ) {
    throw new BrokerRuntimeError("maxRetries must be between zero and two.", "INVALID_REQUEST");
  }
  if (options.body !== undefined && !plainObject(options.body)) {
    throw new BrokerRuntimeError("Invalid Up API request body.", "INVALID_REQUEST");
  }
  return { op: "request", pathOrURL: message.pathOrURL, options: { ...options, method } };
}

function safeError(error) {
  if (error instanceof UpApiError) {
    return { message: error.message, ...error.safeDetails() };
  }
  if (error instanceof BrokerRuntimeError) {
    return { message: error.message, code: error.code, status: null, errors: [] };
  }
  return {
    message: "The local Up Banking broker could not complete the request.",
    code: "BROKER_ERROR",
    status: null,
    errors: [],
  };
}

async function prepareSocket(socketPath) {
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new BrokerRuntimeError("Refusing an unsafe broker directory.", "UNSAFE_SOCKET");
  }
  await chmod(directory, 0o700);

  let socketStat;
  try {
    socketStat = await lstat(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
    throw new BrokerRuntimeError("Refusing an unsafe broker socket path.", "UNSAFE_SOCKET");
  }

  const active = await new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    probe.setTimeout(1_000, () => {
      probe.destroy();
      resolve(true);
    });
  });
  if (active) {
    throw new BrokerRuntimeError("An Up Banking broker is already running.", "BROKER_RUNNING");
  }
  await unlink(socketPath);
}

function writeResponse(socket, response, afterWrite) {
  let payload = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
  if (payload.length > MAX_RESPONSE_BYTES) {
    payload.fill(0);
    payload = Buffer.from(
      `${JSON.stringify({
        ok: false,
        error: {
          message: "The broker response exceeded its local size limit.",
          code: "RESPONSE_TOO_LARGE",
          status: null,
          errors: [],
        },
      })}\n`,
      "utf8",
    );
  }
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    payload.fill(0);
    afterWrite?.();
  };
  socket.once("close", complete);
  socket.end(payload, complete);
}

async function unlinkMatchingSocket(socketPath, identity) {
  try {
    const stat = await lstat(socketPath);
    if (
      stat.isSocket() &&
      !stat.isSymbolicLink() &&
      (!identity || (stat.dev === identity.dev && stat.ino === identity.ino))
    ) {
      await unlink(socketPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function startBroker({
  token,
  socketPath,
  baseURL = upApiConstants.officialBaseURL,
  fetchImpl = globalThis.fetch,
  sleep,
  timeoutMs,
  idleSeconds = 600,
  maxSessionSeconds = 3600,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onTokenCleared,
} = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    if (Buffer.isBuffer(token)) token.fill(0);
    throw new TypeError("socketPath is required");
  }
  if (!(idleSeconds > 0) || !(maxSessionSeconds >= idleSeconds)) {
    if (Buffer.isBuffer(token)) token.fill(0);
    throw new TypeError("Invalid broker session limits");
  }

  const credential = new MemoryCredential(token, onTokenCleared);
  let server;
  let socketIdentity;
  try {
    await prepareSocket(socketPath);
    const client = new UpApiClient({
      credentials: credential,
      baseURL,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let idleTimer = null;
    let maxTimer = null;
    let closePromise = null;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const connections = new Set();

    const close = (reason = "locked") => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (idleTimer !== null) clearTimer(idleTimer);
        if (maxTimer !== null) clearTimer(maxTimer);
        credential.clear();
        await new Promise((resolve) => {
          server.close(() => resolve());
          for (const connection of connections) connection.destroy();
        });
        await unlinkMatchingSocket(socketPath, socketIdentity);
        resolveClosed(reason);
      })();
      return closePromise;
    };

    const scheduleIdle = () => {
      if (idleTimer !== null) clearTimer(idleTimer);
      idleTimer = setTimer(() => void close("idle_expired"), idleSeconds * 1000);
      idleTimer?.unref?.();
    };

    async function handleMessage(socket, rawMessage) {
      let message;
      try {
        message = validateRequest(rawMessage);
        if (message.op === "status") {
          writeResponse(socket, {
            ok: true,
            result: {
              unlocked: true,
              startedAt: new Date(startedAt).toISOString(),
              lastActivityAt: new Date(lastActivityAt).toISOString(),
              idleSeconds,
              maxSessionSeconds,
            },
          });
          return;
        }
        if (message.op === "shutdown") {
          writeResponse(socket, { ok: true, result: { locked: true } }, () => {
            void close("locked");
          });
          return;
        }

        lastActivityAt = Date.now();
        scheduleIdle();
        const result = await client.request(message.pathOrURL, message.options);
        writeResponse(socket, { ok: true, result });
      } catch (error) {
        const serialized = safeError(error);
        writeResponse(socket, { ok: false, error: serialized }, () => {
          if (serialized.code === "UNAUTHORIZED" || serialized.code === "BROKER_LOCKED") {
            void close("credential_rejected");
          }
        });
      }
    }

    server = net.createServer((socket) => {
      connections.add(socket);
      socket.setTimeout(DEFAULT_SOCKET_TIMEOUT_MS, () => socket.destroy());
      let chunks = [];
      let bytes = 0;
      let handled = false;
      const reject = (message, code) => {
        handled = true;
        for (const chunk of chunks) chunk.fill(0);
        chunks = [];
        writeResponse(socket, {
          ok: false,
          error: { message, code, status: null, errors: [] },
        });
      };
      socket.on("data", (chunk) => {
        if (handled) {
          chunk.fill(0);
          return;
        }
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          reject("The broker request exceeded its local size limit.", "REQUEST_TOO_LARGE");
          return;
        }
        chunks.push(chunk);
        const combined = Buffer.concat(chunks, bytes);
        const newline = combined.indexOf(10);
        if (newline === -1) {
          combined.fill(0);
          return;
        }
        handled = true;
        const trailing = combined.subarray(newline + 1).toString("utf8").trim();
        const line = combined.subarray(0, newline).toString("utf8");
        combined.fill(0);
        for (const buffered of chunks) buffered.fill(0);
        chunks = [];
        if (trailing.length > 0) {
          writeResponse(socket, {
            ok: false,
            error: {
              message: "Only one broker request is allowed per connection.",
              code: "INVALID_REQUEST",
              status: null,
              errors: [],
            },
          });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          writeResponse(socket, {
            ok: false,
            error: {
              message: "Invalid broker JSON.",
              code: "INVALID_REQUEST",
              status: null,
              errors: [],
            },
          });
          return;
        }
        void handleMessage(socket, parsed);
      });
      socket.once("close", () => connections.delete(socket));
      socket.once("error", () => {});
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    server.removeAllListeners("error");
    server.on("error", () => void close("server_error"));
    await chmod(socketPath, 0o600);
    socketIdentity = await lstat(socketPath);
    scheduleIdle();
    maxTimer = setTimer(() => void close("session_expired"), maxSessionSeconds * 1000);
    maxTimer?.unref?.();

    return { socketPath, close, closed };
  } catch (error) {
    credential.clear();
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (socketIdentity) await unlinkMatchingSocket(socketPath, socketIdentity);
    throw error;
  }
}

export const brokerRuntimeConstants = Object.freeze({
  maxTokenBytes: MAX_TOKEN_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});
