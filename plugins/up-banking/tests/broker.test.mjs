import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrokerError, sendBrokerMessage } from "../mcp/lib/broker-client.mjs";
import {
  brokerRuntimeConstants,
  startBroker,
} from "../mcp/lib/broker-runtime.mjs";

async function makeSocketPath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubb-"));
  const socketDirectory = path.join(root, "p");
  await mkdir(socketDirectory, { mode: 0o755 });
  return {
    root,
    socketDirectory,
    socketPath: path.join(socketDirectory, "b.sock"),
  };
}

async function socketIsAbsent(socketPath) {
  await assert.rejects(
    () => lstat(socketPath),
    (error) => error?.code === "ENOENT",
  );
}

async function waitForClosure(broker) {
  let timer;
  try {
    return await Promise.race([
      broker.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Broker did not close in time.")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertCleared(token) {
  assert.equal(token.every((byte) => byte === 0), true);
}

function fakeTimers() {
  const handles = [];
  return {
    handles,
    setTimer(callback, delay) {
      const handle = {
        callback,
        delay,
        cleared: false,
        unref() {},
      };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  };
}

test("uses private socket modes and forwards the token only as upstream authorization", async () => {
  const { socketDirectory, socketPath } = await makeSocketPath();
  const tokenText = "synthetic-broker-token";
  const token = Buffer.from(tokenText, "utf8");
  let upstreamRequest;
  const broker = await startBroker({
    token,
    socketPath,
    idleSeconds: 60,
    maxSessionSeconds: 120,
    fetchImpl: async (url, options) => {
      upstreamRequest = {
        url: url.toString(),
        method: options.method,
        tokenMatched:
          options.headers.get("authorization") === `Bearer ${tokenText}`,
        redirect: options.redirect,
      };
      return new Response(JSON.stringify({ meta: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    const directoryStat = await lstat(socketDirectory);
    const socketStat = await lstat(socketPath);
    assert.equal(directoryStat.isDirectory(), true);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(socketStat.isSocket(), true);
    assert.equal(socketStat.mode & 0o777, 0o600);

    const status = await sendBrokerMessage(socketPath, { op: "status" });
    assert.equal(status.unlocked, true);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(tokenText, "u"));

    const result = await sendBrokerMessage(socketPath, {
      op: "request",
      pathOrURL: "util/ping",
      options: {},
    });
    assert.deepEqual(result.body, { meta: { ok: true } });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(tokenText, "u"));
    assert.deepEqual(upstreamRequest, {
      url: "https://api.up.com.au/api/v1/util/ping",
      method: "GET",
      tokenMatched: true,
      redirect: "error",
    });
  } finally {
    await broker.close("test_complete");
  }

  assertCleared(token);
  await socketIsAbsent(socketPath);
});

test("shutdown clears the token, removes the socket, and closes the broker", async () => {
  const { socketPath } = await makeSocketPath();
  const token = Buffer.from("synthetic-shutdown-token", "utf8");
  let clearCalls = 0;
  const broker = await startBroker({
    token,
    socketPath,
    idleSeconds: 60,
    maxSessionSeconds: 120,
    onTokenCleared: () => {
      clearCalls += 1;
    },
  });

  const result = await sendBrokerMessage(socketPath, { op: "shutdown" });
  assert.deepEqual(result, { locked: true });
  assert.equal(await waitForClosure(broker), "locked");
  assertCleared(token);
  assert.equal(clearCalls, 1);
  await socketIsAbsent(socketPath);
});

test("idle and maximum session expiry clear credentials and close the broker", async (t) => {
  for (const expiry of [
    { name: "idle", timerDelay: 10_000, expectedReason: "idle_expired" },
    { name: "maximum session", timerDelay: 20_000, expectedReason: "session_expired" },
  ]) {
    await t.test(expiry.name, async () => {
      const { socketPath } = await makeSocketPath();
      const token = Buffer.from(`synthetic-${expiry.name}-token`, "utf8");
      const timers = fakeTimers();
      const broker = await startBroker({
        token,
        socketPath,
        idleSeconds: 10,
        maxSessionSeconds: 20,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });

      const expiryTimer = timers.handles.find(
        (handle) => handle.delay === expiry.timerDelay && !handle.cleared,
      );
      assert.ok(expiryTimer, `missing ${expiry.name} timer`);
      expiryTimer.callback();

      assert.equal(await waitForClosure(broker), expiry.expectedReason);
      assertCleared(token);
      await socketIsAbsent(socketPath);
    });
  }
});

test("an upstream 401 clears credentials and closes the broker", async () => {
  const { socketPath } = await makeSocketPath();
  const token = Buffer.from("synthetic-rejected-token", "utf8");
  let clearCalls = 0;
  const broker = await startBroker({
    token,
    socketPath,
    idleSeconds: 60,
    maxSessionSeconds: 120,
    onTokenCleared: () => {
      clearCalls += 1;
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          errors: [{ status: "401", title: "Not Authorized", detail: "Rejected" }],
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      sendBrokerMessage(socketPath, {
        op: "request",
        pathOrURL: "util/ping",
        options: {},
      }),
    (error) => {
      assert.equal(error instanceof BrokerError, true);
      assert.equal(error.code, "UNAUTHORIZED");
      assert.equal(error.status, 401);
      return true;
    },
  );

  assert.equal(await waitForClosure(broker), "credential_rejected");
  assertCleared(token);
  assert.equal(clearCalls, 1);
  await socketIsAbsent(socketPath);
});

test("refuses unsafe existing socket paths without deleting them", async (t) => {
  await t.test("regular file", async () => {
    const { socketDirectory, socketPath } = await makeSocketPath();
    await writeFile(socketPath, "keep me", { mode: 0o600 });
    const token = Buffer.from("synthetic-file-token", "utf8");

    await assert.rejects(
      () =>
        startBroker({
          token,
          socketPath,
          idleSeconds: 60,
          maxSessionSeconds: 120,
        }),
      (error) => error?.code === "UNSAFE_SOCKET",
    );

    assertCleared(token);
    assert.equal(await readFile(socketPath, "utf8"), "keep me");
    assert.equal((await lstat(socketDirectory)).mode & 0o777, 0o700);
  });

  await t.test("symbolic link", async () => {
    const { root, socketPath } = await makeSocketPath();
    const target = path.join(root, "target");
    await writeFile(target, "keep target", { mode: 0o600 });
    await symlink(target, socketPath);
    const token = Buffer.from("synthetic-link-token", "utf8");

    await assert.rejects(
      () =>
        startBroker({
          token,
          socketPath,
          idleSeconds: 60,
          maxSessionSeconds: 120,
        }),
      (error) => error?.code === "UNSAFE_SOCKET",
    );

    assertCleared(token);
    assert.equal((await lstat(socketPath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "keep target");
  });
});

test("validates broker requests before credentials reach the Up API transport", async () => {
  const { socketPath } = await makeSocketPath();
  const token = Buffer.from("synthetic-validation-token", "utf8");
  let fetchCalls = 0;
  const broker = await startBroker({
    token,
    socketPath,
    idleSeconds: 60,
    maxSessionSeconds: 120,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("invalid requests must not reach fetch");
    },
  });

  try {
    for (const message of [
      {
        op: "request",
        pathOrURL: "accounts",
        options: { method: "PUT" },
      },
      {
        op: "request",
        pathOrURL: "accounts",
        options: {},
        credential: "must-not-be-accepted",
      },
      {
        op: "request",
        pathOrURL: "accounts",
        options: { query: { nested: { invalid: true } } },
      },
    ]) {
      await assert.rejects(
        () => sendBrokerMessage(socketPath, message),
        (error) => error instanceof BrokerError && error.code === "INVALID_REQUEST",
      );
    }

    await assert.rejects(
      () =>
        sendBrokerMessage(socketPath, {
          op: "request",
          pathOrURL: "https://example.test/collect",
          options: {},
        }),
      (error) => error instanceof BrokerError && error.code === "UNSAFE_URL",
    );

    await assert.rejects(
      () =>
        sendBrokerMessage(socketPath, {
          op: "request",
          pathOrURL: "accounts",
          options: {
            method: "POST",
            body: { blob: "x".repeat(brokerRuntimeConstants.maxRequestBytes) },
          },
        }),
      (error) => error instanceof BrokerError && error.code === "REQUEST_TOO_LARGE",
    );

    assert.equal(fetchCalls, 0);
    assert.equal((await sendBrokerMessage(socketPath, { op: "status" })).unlocked, true);
  } finally {
    await broker.close("test_complete");
  }

  assertCleared(token);
});
