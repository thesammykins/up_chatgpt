#!/usr/bin/env node

import { stdout } from "node:process";

import { defaultBrokerSocketPath } from "../mcp/lib/broker-client.mjs";
import { defaultConfigPath, readConfig } from "../mcp/lib/config.mjs";
import {
  brokerRuntimeConstants,
  startBroker,
} from "../mcp/lib/broker-runtime.mjs";

async function readTokenFromPipe() {
  if (process.stdin.isTTY) {
    throw new Error("The broker requires a private token pipe.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > brokerRuntimeConstants.maxTokenBytes) {
      for (const buffered of chunks) buffered.fill(0);
      chunk.fill(0);
      throw new Error("The credential supplied to the broker is invalid.");
    }
    chunks.push(chunk);
  }
  const token = Buffer.alloc(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(token, offset);
    offset += chunk.length;
    chunk.fill(0);
  }
  return token;
}

async function main() {
  if (process.argv[2] !== "serve") {
    throw new Error("This is an internal broker command.");
  }
  const configPath = defaultConfigPath();
  const config = await readConfig(configPath);
  if (!config) {
    throw new Error("Up Banking is not configured.");
  }
  const token = await readTokenFromPipe();
  const broker = await startBroker({
    token,
    socketPath: defaultBrokerSocketPath(configPath),
    idleSeconds: config.idleSeconds,
    maxSessionSeconds: config.maxSessionSeconds,
  });
  const stop = () => void broker.close("signal");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  stdout.write("READY\n");
  await broker.closed;
}

main().catch(() => {
  process.stderr.write("The local Up Banking broker could not start.\n");
  process.exitCode = 1;
});
