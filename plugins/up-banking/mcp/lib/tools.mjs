import { UpApiError } from "./up-api.mjs";

const ACCOUNT_TYPES = ["SAVER", "TRANSACTIONAL", "HOME_LOAN"];
const OWNERSHIP_TYPES = ["INDIVIDUAL", "JOINT"];
const TRANSACTION_STATUSES = ["HELD", "SETTLED"];
const GROUPINGS = ["category", "parent_category", "account", "description", "month"];

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const localAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const mutationAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

const paginationProperties = {
  page_size: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 50,
    description: "Resources per API page.",
  },
  max_pages: {
    type: "integer",
    minimum: 1,
    maximum: 5,
    default: 1,
    description: "Maximum opaque API pages to follow. Narrow filters before increasing this.",
  },
};

export const toolDefinitions = [
  {
    name: "up_auth_status",
    title: "Up Authentication Status",
    description:
      "Check whether the local 1Password reference is configured and the private broker is unlocked, without reading or returning the Up API token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: localAnnotations,
  },
  {
    name: "up_ping",
    title: "Test Up Connection",
    description:
      "Validate the broker-held credential against Up's /util/ping endpoint. Never accepts a token argument.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readAnnotations,
  },
  {
    name: "up_list_accounts",
    title: "List Up Accounts and Balances",
    description:
      "List personal Up accounts with their available balances. Optionally filter by account and ownership type.",
    inputSchema: {
      type: "object",
      properties: {
        account_type: { type: "string", enum: ACCOUNT_TYPES },
        ownership_type: { type: "string", enum: OWNERSHIP_TYPES },
        ...paginationProperties,
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_list_transactions",
    title: "List Up Transactions",
    description:
      "List a bounded, newest-first set of personal transactions. Prefer explicit dates and narrow filters to limit sensitive data in context.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", minLength: 1, maxLength: 200 },
        status: { type: "string", enum: TRANSACTION_STATUSES },
        since: { type: "string", description: "Inclusive RFC 3339 timestamp." },
        until: { type: "string", description: "End RFC 3339 timestamp." },
        category: { type: "string", minLength: 1, maxLength: 200 },
        tag: { type: "string", minLength: 1, maxLength: 100 },
        search_text: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description:
            "Optional case-insensitive local match against description, raw text, or message after fetching the bounded API pages.",
        },
        include_details: {
          type: "boolean",
          default: false,
          description:
            "Include raw text, free-form message, foreign amount, and deep link fields. Leave false unless those details are needed.",
        },
        ...paginationProperties,
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_get_transaction",
    title: "Get Up Transaction",
    description: "Retrieve one transaction by its Up resource id, including its full API attributes.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_list_categories",
    title: "List Up Categories",
    description:
      "List Up's predefined category hierarchy, optionally restricted to children of one parent category.",
    inputSchema: {
      type: "object",
      properties: {
        parent_category_id: { type: "string", minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_list_tags",
    title: "List Up Tags",
    description: "List the transaction tags currently in use in the personal Up account.",
    inputSchema: {
      type: "object",
      properties: paginationProperties,
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_cashflow_summary",
    title: "Summarise Up Cashflow",
    description:
      "Compute a local, exact-base-unit income, spending, and net cashflow summary over a bounded transaction window.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Inclusive RFC 3339 timestamp. Defaults to 30 days before now.",
        },
        until: {
          type: "string",
          description: "End RFC 3339 timestamp. Defaults to now.",
        },
        account_id: { type: "string", minLength: 1, maxLength: 200 },
        group_by: { type: "string", enum: GROUPINGS, default: "category" },
        exclude_internal_transfers: {
          type: "boolean",
          default: true,
          description: "Exclude transactions related to another Up account to avoid double counting.",
        },
        top_n: { type: "integer", minimum: 1, maximum: 50, default: 15 },
        page_size: paginationProperties.page_size,
        max_pages: {
          ...paginationProperties.max_pages,
          default: 3,
        },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "up_set_transaction_category",
    title: "Set Up Transaction Category",
    description:
      "Set or clear one transaction category. Call only after the user explicitly requests this exact metadata change; confirm must be true.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: ["set", "clear"] },
        category_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Required for set; must be a child category id.",
        },
        confirm: { const: true, description: "Explicit confirmation guard." },
      },
      required: ["transaction_id", "action", "confirm"],
      additionalProperties: false,
    },
    annotations: mutationAnnotations,
  },
  {
    name: "up_modify_transaction_tags",
    title: "Modify Up Transaction Tags",
    description:
      "Add or remove up to six tags on one transaction. Call only after the user explicitly requests this exact metadata change; confirm must be true.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: ["add", "remove"] },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
        confirm: { const: true, description: "Explicit confirmation guard." },
      },
      required: ["transaction_id", "action", "tags", "confirm"],
      additionalProperties: false,
    },
    annotations: mutationAnnotations,
  },
];

function argsObject(args) {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("Tool arguments must be an object.");
  }
  return args;
}

function stringValue(value, name, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new TypeError(`${name} is required.`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function enumValue(value, name, allowed, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (!allowed.includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function integerValue(value, name, min, max, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function booleanValue(value, name, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean.`);
  }
  return value;
}

function rfc3339(value, name, fallback) {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(candidate) ||
    Number.isNaN(Date.parse(candidate))
  ) {
    throw new TypeError(`${name} must be an RFC 3339 timestamp with a timezone.`);
  }
  return candidate;
}

function relationData(resource, name) {
  return resource?.relationships?.[name]?.data ?? null;
}

function relationId(resource, name) {
  const data = relationData(resource, name);
  return data && !Array.isArray(data) ? data.id ?? null : null;
}

function normalizeMoney(money) {
  if (!money || typeof money !== "object") {
    return null;
  }
  return {
    currencyCode: money.currencyCode,
    value: money.value,
    valueInBaseUnits:
      money.valueInBaseUnits === undefined ? undefined : String(money.valueInBaseUnits),
  };
}

function normalizeAccount(resource) {
  const attributes = resource?.attributes ?? {};
  return {
    id: resource?.id,
    displayName: attributes.displayName,
    accountType: attributes.accountType,
    ownershipType: attributes.ownershipType,
    balance: normalizeMoney(attributes.balance),
    createdAt: attributes.createdAt,
  };
}

function normalizeTransaction(resource) {
  const attributes = resource?.attributes ?? {};
  const tags = relationData(resource, "tags");
  return {
    id: resource?.id,
    status: attributes.status,
    description: attributes.description,
    rawText: attributes.rawText,
    message: attributes.message,
    amount: normalizeMoney(attributes.amount),
    foreignAmount: normalizeMoney(attributes.foreignAmount),
    createdAt: attributes.createdAt,
    settledAt: attributes.settledAt,
    transactionType: attributes.transactionType,
    isCategorizable: attributes.isCategorizable,
    accountId: relationId(resource, "account"),
    transferAccountId: relationId(resource, "transferAccount"),
    categoryId: relationId(resource, "category"),
    parentCategoryId: relationId(resource, "parentCategory"),
    tags: Array.isArray(tags) ? tags.map((tag) => tag.id).filter(Boolean) : [],
    deepLinkURL: attributes.deepLinkURL,
  };
}

function transactionForOutput(transaction, includeDetails) {
  if (includeDetails) {
    return transaction;
  }
  const {
    rawText: _rawText,
    message: _message,
    foreignAmount: _foreignAmount,
    deepLinkURL: _deepLinkURL,
    ...minimal
  } = transaction;
  return minimal;
}

function normalizeCategory(resource) {
  return {
    id: resource?.id,
    name: resource?.attributes?.name,
    parentCategoryId: relationId(resource, "parent"),
    childCategoryIds: Array.isArray(relationData(resource, "children"))
      ? relationData(resource, "children").map((child) => child.id).filter(Boolean)
      : [],
  };
}

function pagination(args, defaultPages = 1) {
  return {
    pageSize: integerValue(args.page_size, "page_size", 1, 100, 50),
    maxPages: integerValue(args.max_pages, "max_pages", 1, 5, defaultPages),
  };
}

function compactQuery(query) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function transactionQuery(args, pageSize) {
  return compactQuery({
    "page[size]": pageSize,
    "filter[status]": enumValue(args.status, "status", TRANSACTION_STATUSES),
    "filter[since]": args.since === undefined ? undefined : rfc3339(args.since, "since"),
    "filter[until]": args.until === undefined ? undefined : rfc3339(args.until, "until"),
    "filter[category]": stringValue(args.category, "category"),
    "filter[tag]": stringValue(args.tag, "tag", { max: 100 }),
  });
}

function success(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function failure(error) {
  const known =
    error instanceof UpApiError ||
    error instanceof TypeError ||
    (error instanceof Error && typeof error.code === "string");
  const message = known ? error.message : "The Up Banking tool could not complete the request.";
  const details =
    error instanceof UpApiError
      ? error.safeDetails()
      : { code: typeof error?.code === "string" ? error.code : "TOOL_ERROR" };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: details },
    isError: true,
  };
}

function encodeId(value) {
  return encodeURIComponent(value);
}

function exactBaseUnits(money) {
  const value = money?.value;
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
  if (!match) {
    return null;
  }
  const fraction = (match[3] || "").padEnd(2, "0");
  const units = BigInt(match[2]) * 100n + BigInt(fraction || "0");
  return match[1] === "-" ? -units : units;
}

function decimalFromBaseUnits(value) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function aggregateCashflow(resources, { groupBy, excludeInternalTransfers, topN }) {
  const groups = new Map();
  const totals = new Map();
  let includedTransactions = 0;
  let excludedInternalTransfers = 0;
  let skippedAmounts = 0;

  for (const resource of resources) {
    if (excludeInternalTransfers && relationId(resource, "transferAccount")) {
      excludedInternalTransfers += 1;
      continue;
    }
    const attributes = resource?.attributes ?? {};
    const baseUnits = exactBaseUnits(attributes.amount);
    const currency = attributes.amount?.currencyCode || "AUD";
    if (baseUnits === null) {
      skippedAmounts += 1;
      continue;
    }
    includedTransactions += 1;

    let label;
    switch (groupBy) {
      case "parent_category":
        label = relationId(resource, "parentCategory") || "uncategorised";
        break;
      case "account":
        label = relationId(resource, "account") || "unknown-account";
        break;
      case "description":
        label = attributes.description || "unknown-description";
        break;
      case "month":
        label = String(attributes.settledAt || attributes.createdAt || "unknown").slice(0, 7);
        break;
      default:
        label = relationId(resource, "category") || "uncategorised";
    }
    const groupKey = `${currency}\u0000${label}`;
    const totalKey = currency;
    const group = groups.get(groupKey) || {
      label,
      currencyCode: currency,
      transactionCount: 0,
      income: 0n,
      spending: 0n,
      net: 0n,
    };
    const total = totals.get(totalKey) || {
      currencyCode: currency,
      transactionCount: 0,
      income: 0n,
      spending: 0n,
      net: 0n,
    };
    for (const target of [group, total]) {
      target.transactionCount += 1;
      target.net += baseUnits;
      if (baseUnits > 0n) {
        target.income += baseUnits;
      } else if (baseUnits < 0n) {
        target.spending += -baseUnits;
      }
    }
    groups.set(groupKey, group);
    totals.set(totalKey, total);
  }

  const serialize = (entry) => ({
    ...entry,
    income: decimalFromBaseUnits(entry.income),
    spending: decimalFromBaseUnits(entry.spending),
    net: decimalFromBaseUnits(entry.net),
  });
  const sortedGroups = [...groups.values()]
    .sort((left, right) => {
      if (left.spending !== right.spending) {
        return left.spending > right.spending ? -1 : 1;
      }
      if (left.income !== right.income) {
        return left.income > right.income ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    })
    .slice(0, topN)
    .map(serialize);
  return {
    totals: [...totals.values()].map(serialize),
    groups: sortedGroups,
    includedTransactions,
    excludedInternalTransfers,
    skippedAmounts,
  };
}

export function createToolHandler({ client, credentials, now = () => new Date() }) {
  if (!client || !credentials) {
    throw new TypeError("client and credentials are required");
  }

  return async function callTool(name, rawArguments) {
    try {
      const args = argsObject(rawArguments);
      switch (name) {
        case "up_auth_status": {
          const status = await credentials.status();
          const description = !status.configured
            ? "Up Banking is not configured. Run the local auth setup; do not paste a token into chat."
            : status.unlocked
              ? "Up Banking is configured and its local broker is unlocked."
              : "Up Banking is configured but locked. Run the local unlock command in a Terminal.";
          return success(
            description,
            { ok: true, ...status },
          );
        }
        case "up_ping": {
          const response = await client.request("util/ping");
          return success("Up authentication succeeded.", {
            ok: true,
            meta: response.body?.meta ?? null,
            rateLimitRemaining: response.rateLimitRemaining,
          });
        }
        case "up_list_accounts": {
          const { pageSize, maxPages } = pagination(args);
          const query = compactQuery({
            "page[size]": pageSize,
            "filter[accountType]": enumValue(
              args.account_type,
              "account_type",
              ACCOUNT_TYPES,
            ),
            "filter[ownershipType]": enumValue(
              args.ownership_type,
              "ownership_type",
              OWNERSHIP_TYPES,
            ),
          });
          const result = await client.paginate("accounts", { query, maxPages });
          const accounts = result.items.map(normalizeAccount);
          return success(`Found ${accounts.length} Up account(s).`, {
            ok: true,
            accounts,
            pagesRead: result.pages,
            nextPageAvailable: result.nextPageAvailable,
            rateLimitRemaining: result.rateLimitRemaining,
          });
        }
        case "up_list_transactions": {
          const { pageSize, maxPages } = pagination(args);
          const accountId = stringValue(args.account_id, "account_id");
          const endpoint = accountId
            ? `accounts/${encodeId(accountId)}/transactions`
            : "transactions";
          const result = await client.paginate(endpoint, {
            query: transactionQuery(args, pageSize),
            maxPages,
          });
          const normalized = result.items.map(normalizeTransaction);
          const searchText = stringValue(args.search_text, "search_text", { max: 100 });
          const needle = searchText?.toLocaleLowerCase("en-AU");
          const matches = needle
            ? normalized.filter((transaction) =>
                [transaction.description, transaction.rawText, transaction.message]
                  .filter((value) => typeof value === "string")
                  .some((value) => value.toLocaleLowerCase("en-AU").includes(needle)),
              )
            : normalized;
          const includeDetails = booleanValue(
            args.include_details,
            "include_details",
            false,
          );
          const transactions = matches.map((transaction) =>
            transactionForOutput(transaction, includeDetails),
          );
          return success(`Found ${transactions.length} Up transaction(s).`, {
            ok: true,
            transactions,
            fetchedTransactionCount: normalized.length,
            localSearchApplied: searchText ?? null,
            detailsIncluded: includeDetails,
            pagesRead: result.pages,
            nextPageAvailable: result.nextPageAvailable,
            rateLimitRemaining: result.rateLimitRemaining,
          });
        }
        case "up_get_transaction": {
          const transactionId = stringValue(args.transaction_id, "transaction_id", {
            required: true,
          });
          const response = await client.request(`transactions/${encodeId(transactionId)}`);
          return success("Retrieved the Up transaction.", {
            ok: true,
            transaction: response.body?.data ?? null,
            rateLimitRemaining: response.rateLimitRemaining,
          });
        }
        case "up_list_categories": {
          const parent = stringValue(args.parent_category_id, "parent_category_id");
          const response = await client.request("categories", {
            query: compactQuery({ "filter[parent]": parent }),
          });
          const categories = Array.isArray(response.body?.data)
            ? response.body.data.map(normalizeCategory)
            : [];
          return success(`Found ${categories.length} Up categor${categories.length === 1 ? "y" : "ies"}.`, {
            ok: true,
            categories,
            rateLimitRemaining: response.rateLimitRemaining,
          });
        }
        case "up_list_tags": {
          const { pageSize, maxPages } = pagination(args);
          const result = await client.paginate("tags", {
            query: { "page[size]": pageSize },
            maxPages,
          });
          const tags = result.items.map((item) => item?.id).filter(Boolean);
          return success(`Found ${tags.length} active Up tag(s).`, {
            ok: true,
            tags,
            pagesRead: result.pages,
            nextPageAvailable: result.nextPageAvailable,
            rateLimitRemaining: result.rateLimitRemaining,
          });
        }
        case "up_cashflow_summary": {
          const current = now();
          const until = rfc3339(args.until, "until", current.toISOString());
          const sinceDefault = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const since = rfc3339(args.since, "since", sinceDefault);
          if (Date.parse(since) >= Date.parse(until)) {
            throw new TypeError("since must be earlier than until.");
          }
          const { pageSize, maxPages } = pagination(args, 3);
          const accountId = stringValue(args.account_id, "account_id");
          const groupBy = enumValue(args.group_by, "group_by", GROUPINGS, "category");
          const excludeInternalTransfers = booleanValue(
            args.exclude_internal_transfers,
            "exclude_internal_transfers",
            true,
          );
          const topN = integerValue(args.top_n, "top_n", 1, 50, 15);
          const endpoint = accountId
            ? `accounts/${encodeId(accountId)}/transactions`
            : "transactions";
          const result = await client.paginate(endpoint, {
            query: {
              "page[size]": pageSize,
              "filter[status]": "SETTLED",
              "filter[since]": since,
              "filter[until]": until,
            },
            maxPages,
          });
          const summary = aggregateCashflow(result.items, {
            groupBy,
            excludeInternalTransfers,
            topN,
          });
          return success(
            `Summarised ${summary.includedTransactions} settled transaction(s) from ${since} to ${until}.`,
            {
              ok: true,
              since,
              until,
              groupBy,
              ...summary,
              pagesRead: result.pages,
              nextPageAvailable: result.nextPageAvailable,
              rateLimitRemaining: result.rateLimitRemaining,
            },
          );
        }
        case "up_set_transaction_category": {
          if (args.confirm !== true) {
            throw new TypeError("confirm must be true after explicit user approval.");
          }
          const transactionId = stringValue(args.transaction_id, "transaction_id", {
            required: true,
          });
          const action = enumValue(args.action, "action", ["set", "clear"]);
          if (!action) {
            throw new TypeError("action is required.");
          }
          const categoryId = stringValue(args.category_id, "category_id");
          if (action === "set" && !categoryId) {
            throw new TypeError("category_id is required when action is set.");
          }
          await client.request(
            `transactions/${encodeId(transactionId)}/relationships/category`,
            {
              method: "PATCH",
              idempotent: true,
              body: {
                data: action === "clear" ? null : { type: "categories", id: categoryId },
              },
            },
          );
          return success(
            action === "clear"
              ? "Cleared the Up transaction category."
              : `Set the Up transaction category to ${categoryId}.`,
            { ok: true, transactionId, action, categoryId: categoryId ?? null },
          );
        }
        case "up_modify_transaction_tags": {
          if (args.confirm !== true) {
            throw new TypeError("confirm must be true after explicit user approval.");
          }
          const transactionId = stringValue(args.transaction_id, "transaction_id", {
            required: true,
          });
          const action = enumValue(args.action, "action", ["add", "remove"]);
          if (!action) {
            throw new TypeError("action is required.");
          }
          if (!Array.isArray(args.tags) || args.tags.length < 1 || args.tags.length > 6) {
            throw new TypeError("tags must contain between one and six labels.");
          }
          const tags = [...new Set(args.tags.map((tag) => stringValue(tag, "tag", { required: true, max: 100 })) )];
          if (tags.length !== args.tags.length) {
            throw new TypeError("tags must not contain duplicates.");
          }
          await client.request(
            `transactions/${encodeId(transactionId)}/relationships/tags`,
            {
              method: action === "add" ? "POST" : "DELETE",
              idempotent: true,
              body: { data: tags.map((id) => ({ type: "tags", id })) },
            },
          );
          return success(`${action === "add" ? "Added" : "Removed"} ${tags.length} tag(s).`, {
            ok: true,
            transactionId,
            action,
            tags,
          });
        }
        default:
          throw new TypeError(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return failure(error);
    }
  };
}

export const toolInternals = Object.freeze({
  normalizeAccount,
  normalizeTransaction,
  exactBaseUnits,
  decimalFromBaseUnits,
  aggregateCashflow,
});
