import net from "node:net";
import path from "node:path";

import { defaultConfigPath, publicConfig, readConfig } from "./config.mjs";
import { UpApiError } from "./up-api.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_TIMEOUT_MS = 75_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class BrokerError extends Error {
  constructor(message, { code = "BROKER_ERROR", status = null, errors = [] } = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.status = status;
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

export function defaultBrokerSocketPath(configPath = defaultConfigPath()) {
  if (process.env.UP_BANKING_BROKER_SOCKET) {
    return path.resolve(process.env.UP_BANKING_BROKER_SOCKET);
  }
  return path.join(path.dirname(configPath), "broker.sock");
}

function unavailable(error) {
  if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)) {
    return new BrokerError(
      "The local Up Banking broker is locked or unavailable. Run the local unlock command in a Terminal.",
      { code: "BROKER_LOCKED" },
    );
  }
  if (error?.code === "BROKER_TIMEOUT") return error;
  return new BrokerError("The local Up Banking broker is unavailable.", {
    code: "BROKER_UNAVAILABLE",
  });
}

export function sendBrokerMessage(
  socketPath,
  message,
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      finish(
        new BrokerError("The local Up Banking broker did not respond in time.", {
          code: "BROKER_TIMEOUT",
        }),
      );
    }, timeoutMs);
    timer.unref?.();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (error) reject(error);
      else resolve(value);
    }

    socket.once("connect", () => {
      let payload;
      try {
        payload = `${JSON.stringify(message)}\n`;
      } catch {
        finish(new BrokerError("Invalid local broker request.", { code: "INVALID_REQUEST" }));
        return;
      }
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      bytes += chunk.length;
      if (bytes > maxResponseBytes) {
        finish(
          new BrokerError("The local broker response exceeded its size limit.", {
            code: "RESPONSE_TOO_LARGE",
          }),
        );
        return;
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks, bytes);
      const newline = combined.indexOf(10);
      if (newline === -1) {
        combined.fill(0);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(combined.subarray(0, newline).toString("utf8"));
      } catch {
        combined.fill(0);
        finish(
          new BrokerError("The local broker returned invalid data.", {
            code: "INVALID_RESPONSE",
          }),
        );
        return;
      }
      combined.fill(0);
      if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
        finish(
          new BrokerError("The local broker returned invalid data.", {
            code: "INVALID_RESPONSE",
          }),
        );
        return;
      }
      if (!parsed.ok) {
        const details = parsed.error ?? {};
        finish(
          new BrokerError(
            typeof details.message === "string"
              ? details.message
              : "The local broker rejected the request.",
            {
              code: typeof details.code === "string" ? details.code : "BROKER_ERROR",
              status: Number.isInteger(details.status) ? details.status : null,
              errors: Array.isArray(details.errors) ? details.errors : [],
            },
          ),
        );
        return;
      }
      finish(null, parsed.result);
    });
    socket.once("error", (error) => finish(unavailable(error)));
    socket.once("end", () => {
      if (!settled) {
        finish(
          new BrokerError("The local broker closed without a response.", {
            code: "INVALID_RESPONSE",
          }),
        );
      }
    });
  });
}

export class BrokerSession {
  constructor({
    configPath = defaultConfigPath(),
    socketPath = defaultBrokerSocketPath(configPath),
    configReader = readConfig,
  } = {}) {
    this.configPath = configPath;
    this.socketPath = socketPath;
    this.configReader = configReader;
  }

  async status() {
    const config = await this.configReader(this.configPath);
    const configured = publicConfig(config);
    if (!config) return { ...configured, unlocked: false };
    try {
      const broker = await sendBrokerMessage(this.socketPath, { op: "status" });
      return { ...configured, ...broker, unlocked: broker?.unlocked === true };
    } catch (error) {
      if (error instanceof BrokerError) {
        return { ...configured, unlocked: false, brokerStatus: error.code };
      }
      throw error;
    }
  }

  dispose() {
    // The broker intentionally outlives an individual MCP process.
  }
}

export class BrokerApiClient {
  constructor({
    socketPath = defaultBrokerSocketPath(),
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
  } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(pathOrURL, options = {}) {
    try {
      return await sendBrokerMessage(
        this.socketPath,
        {
          op: "request",
          pathOrURL,
          options,
        },
        { timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      if (error instanceof BrokerError && !error.code.startsWith("BROKER_")) {
        throw new UpApiError(error.message, {
          code: error.code,
          status: error.status,
          errors: error.errors,
        });
      }
      throw error;
    }
  }

  async paginate(pathOrURL, { query, maxPages = 1 } = {}) {
    const items = [];
    let next = pathOrURL;
    let nextQuery = query;
    let pages = 0;
    let rateLimitRemaining = null;
    while (next && pages < maxPages) {
      const response = await this.request(next, { query: nextQuery });
      const pageItems = Array.isArray(response.body?.data) ? response.body.data : [];
      items.push(...pageItems);
      pages += 1;
      rateLimitRemaining = response.rateLimitRemaining;
      next = response.body?.links?.next || null;
      nextQuery = undefined;
    }
    return {
      items,
      pages,
      nextPageAvailable: next !== null,
      rateLimitRemaining,
    };
  }
}

export const brokerClientConstants = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  defaultApiTimeoutMs: DEFAULT_API_TIMEOUT_MS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});
