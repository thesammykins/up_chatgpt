import readline from "node:readline";

import { createToolHandler, toolDefinitions } from "./tools.mjs";

const SERVER_NAME = "Up Banking for Codex";
const SERVER_VERSION = "0.1.0";
const JsonRpcError = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

export function startMcpServer({
  credentials,
  client,
  input = process.stdin,
  output = process.stdout,
  installSignalHandlers = true,
} = {}) {
  if (!credentials || !client) {
    throw new TypeError("credentials and client are required");
  }
  const callTool = createToolHandler({ client, credentials });

  function send(message) {
    output.write(`${JSON.stringify(message)}\n`);
  }

  function result(id, value) {
    send({ jsonrpc: "2.0", id, result: value });
  }

  function rpcError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      rpcError(null, JsonRpcError.INVALID_REQUEST, "Invalid JSON-RPC request.");
      return;
    }
    const { id, method, params } = message;
    if (typeof method !== "string") {
      if (id !== undefined) {
        rpcError(id, JsonRpcError.INVALID_REQUEST, "JSON-RPC method is required.");
      }
      return;
    }

    switch (method) {
      case "initialize":
        result(id, {
          protocolVersion: params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Use narrow date ranges and summaries before returning transaction detail. Never ask for or accept an Up API token in chat or a tool argument; if the broker is locked, direct the user to the local Terminal unlock command. Category and tag mutations require an explicit user request and confirm=true.",
        });
        return;
      case "ping":
        result(id, {});
        return;
      case "tools/list":
        result(id, { tools: toolDefinitions });
        return;
      case "tools/call":
        if (typeof params?.name !== "string") {
          rpcError(id, JsonRpcError.INVALID_PARAMS, "Tool name is required.");
          return;
        }
        result(id, await callTool(params.name, params.arguments));
        return;
      case "shutdown":
        credentials.dispose();
        result(id, null);
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
      case "exit":
        return;
      default:
        if (id !== undefined) {
          rpcError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rpcError(null, JsonRpcError.PARSE_ERROR, "Invalid JSON.");
      return;
    }
    void handle(message).catch(() => {
      if (message?.id !== undefined) {
        rpcError(message.id, JsonRpcError.INTERNAL_ERROR, "Internal MCP server error.");
      }
    });
  });

  function disposeAndExit() {
    credentials.dispose();
    process.exit(0);
  }
  if (installSignalHandlers) {
    process.once("SIGINT", disposeAndExit);
    process.once("SIGTERM", disposeAndExit);
    process.once("exit", () => credentials.dispose());
  }
  return {
    close() {
      lines.close();
      credentials.dispose();
    },
  };
}
