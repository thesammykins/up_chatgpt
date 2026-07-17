import assert from "node:assert/strict";
import test from "node:test";

import { createToolHandler } from "../mcp/lib/tools.mjs";

const credentials = {
  async status() {
    return { configured: true, provider: "onepassword", unlocked: true };
  },
};

test("normalizes account balances and bounds pagination", async () => {
  let captured;
  const client = {
    async paginate(endpoint, options) {
      captured = { endpoint, options };
      return {
        items: [
          {
            id: "account-1",
            attributes: {
              displayName: "Spending",
              accountType: "TRANSACTIONAL",
              ownershipType: "INDIVIDUAL",
              balance: { currencyCode: "AUD", value: "12.34", valueInBaseUnits: 1234 },
            },
          },
        ],
        pages: 1,
        nextPageAvailable: false,
      };
    },
  };
  const call = createToolHandler({ client, credentials });
  const result = await call("up_list_accounts", { page_size: 25, max_pages: 2 });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.accounts[0].balance.valueInBaseUnits, "1234");
  assert.deepEqual(captured, {
    endpoint: "accounts",
    options: { query: { "page[size]": 25 }, maxPages: 2 },
  });
});

test("cashflow summary uses exact decimal strings and excludes internal transfers", async () => {
  const client = {
    async paginate() {
      return {
        items: [
          {
            id: "spend",
            attributes: {
              status: "SETTLED",
              description: "Grocer",
              amount: { currencyCode: "AUD", value: "-10.05" },
              settledAt: "2026-07-02T01:00:00Z",
            },
            relationships: {
              category: { data: { type: "categories", id: "groceries" } },
              account: { data: { type: "accounts", id: "account-1" } },
            },
          },
          {
            id: "income",
            attributes: {
              status: "SETTLED",
              description: "Pay",
              amount: { currencyCode: "AUD", value: "100.10" },
              settledAt: "2026-07-03T01:00:00Z",
            },
            relationships: {
              category: { data: { type: "categories", id: "income" } },
              account: { data: { type: "accounts", id: "account-1" } },
            },
          },
          {
            id: "transfer",
            attributes: {
              status: "SETTLED",
              amount: { currencyCode: "AUD", value: "-20.00" },
            },
            relationships: {
              transferAccount: { data: { type: "accounts", id: "account-2" } },
            },
          },
        ],
        pages: 1,
        nextPageAvailable: false,
      };
    },
  };
  const call = createToolHandler({
    client,
    credentials,
    now: () => new Date("2026-07-14T00:00:00Z"),
  });
  const result = await call("up_cashflow_summary", {
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-14T00:00:00Z",
  });

  assert.equal(result.structuredContent.includedTransactions, 2);
  assert.equal(result.structuredContent.excludedInternalTransfers, 1);
  assert.deepEqual(result.structuredContent.totals, [
    {
      currencyCode: "AUD",
      transactionCount: 2,
      income: "100.10",
      spending: "10.05",
      net: "90.05",
    },
  ]);
});

test("transaction search filters locally without widening the API request", async () => {
  let captured;
  const client = {
    async paginate(endpoint, options) {
      captured = { endpoint, options };
      return {
        items: [
          {
            id: "1",
            attributes: {
              description: "Corner Grocer",
              rawText: "PRIVATE RAW TEXT",
              message: "PRIVATE MESSAGE",
              foreignAmount: { currencyCode: "USD", value: "-3.00" },
              deepLinkURL: "up://transaction/private",
              amount: { value: "-5.00" },
            },
          },
          { id: "2", attributes: { description: "Train", amount: { value: "-3.00" } } },
        ],
        pages: 1,
        nextPageAvailable: false,
      };
    },
  };
  const call = createToolHandler({ client, credentials });
  const result = await call("up_list_transactions", {
    search_text: "grocer",
    page_size: 20,
  });

  assert.equal(result.structuredContent.transactions.length, 1);
  assert.equal(result.structuredContent.transactions[0].id, "1");
  assert.equal(result.structuredContent.detailsIncluded, false);
  assert.equal("rawText" in result.structuredContent.transactions[0], false);
  assert.equal("message" in result.structuredContent.transactions[0], false);
  assert.equal("foreignAmount" in result.structuredContent.transactions[0], false);
  assert.equal("deepLinkURL" in result.structuredContent.transactions[0], false);
  assert.equal(result.structuredContent.fetchedTransactionCount, 2);
  assert.equal(captured.options.query["page[size]"], 20);
  assert.equal("search_text" in captured.options.query, false);

  const detailed = await call("up_list_transactions", {
    search_text: "private message",
    include_details: true,
  });
  assert.equal(detailed.structuredContent.detailsIncluded, true);
  assert.equal(detailed.structuredContent.transactions[0].message, "PRIVATE MESSAGE");
});

test("category hierarchy uses the API parent relationship", async () => {
  const client = {
    async request() {
      return {
        body: {
          data: [
            {
              id: "groceries",
              attributes: { name: "Groceries" },
              relationships: {
                parent: { data: { type: "categories", id: "good-life" } },
                children: { data: [] },
              },
            },
          ],
        },
      };
    },
  };
  const call = createToolHandler({ client, credentials });
  const result = await call("up_list_categories", {});
  assert.equal(result.structuredContent.categories[0].parentCategoryId, "good-life");
});

test("metadata writes require explicit confirmation and emit the narrow API request", async () => {
  const calls = [];
  const client = {
    async request(endpoint, options) {
      calls.push({ endpoint, options });
      return { status: 204 };
    },
  };
  const call = createToolHandler({ client, credentials });

  const rejected = await call("up_set_transaction_category", {
    transaction_id: "tx-1",
    action: "set",
    category_id: "groceries",
  });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 0);

  const accepted = await call("up_set_transaction_category", {
    transaction_id: "tx-1",
    action: "set",
    category_id: "groceries",
    confirm: true,
  });
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(calls[0], {
    endpoint: "transactions/tx-1/relationships/category",
    options: {
      method: "PATCH",
      idempotent: true,
      body: { data: { type: "categories", id: "groceries" } },
    },
  });
});
