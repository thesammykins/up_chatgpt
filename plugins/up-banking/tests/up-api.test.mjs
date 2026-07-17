import assert from "node:assert/strict";
import test from "node:test";

import { UpApiClient, UpApiError } from "../mcp/lib/up-api.mjs";

function credentials(token = "private-test-token") {
  return {
    clearCalls: 0,
    async getToken() {
      return Buffer.from(token);
    },
    clear() {
      this.clearCalls += 1;
    },
  };
}

test("sends bearer auth in-process and follows only same-origin pagination", async () => {
  const auth = credentials();
  const requests = [];
  const client = new UpApiClient({
    credentials: auth,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.get("authorization") });
      return new Response(
        JSON.stringify({ data: [{ id: "a" }], links: { next: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.paginate("accounts", { query: { "page[size]": 1 } });
  assert.equal(result.items.length, 1);
  assert.equal(requests[0].authorization, "Bearer private-test-token");
  assert.match(requests[0].url, /page%5Bsize%5D=1/u);

  const unsafe = new UpApiClient({
    credentials: auth,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: [],
          links: { next: "https://attacker.invalid/api/v1/transactions?page=2" },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    () => unsafe.paginate("transactions", { maxPages: 2 }),
    (error) => error instanceof UpApiError && error.code === "UNSAFE_URL",
  );
});

test("disables automatic HTTP redirects for authenticated requests", async () => {
  const auth = credentials();
  let redirectPolicy;
  const client = new UpApiClient({
    credentials: auth,
    fetchImpl: async (_url, options) => {
      redirectPolicy = options.redirect;
      return new Response(JSON.stringify({ meta: {} }), { status: 200 });
    },
  });

  await client.request("util/ping");
  assert.equal(redirectPolicy, "error");
});

test("clears the in-memory credential on 401 without leaking it", async () => {
  const auth = credentials("never-echo-this-token");
  const client = new UpApiClient({
    credentials: auth,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ errors: [{ status: "401", title: "Not authorised" }] }),
        { status: 401 },
      ),
  });

  await assert.rejects(
    () => client.request("util/ping"),
    (error) => {
      assert.equal(error.code, "UNAUTHORIZED");
      assert.doesNotMatch(JSON.stringify(error.safeDetails()), /never-echo-this-token/u);
      assert.doesNotMatch(error.message, /never-echo-this-token/u);
      return true;
    },
  );
  assert.equal(auth.clearCalls, 1);
});

test("retries a bounded 429 response with exponential backoff", async () => {
  const auth = credentials();
  let attempts = 0;
  const waits = [];
  const client = new UpApiClient({
    credentials: auth,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({ errors: [] }), { status: 429 });
      }
      return new Response(JSON.stringify({ meta: { statusEmoji: "ok" } }), { status: 200 });
    },
  });

  await client.request("util/ping");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
});
