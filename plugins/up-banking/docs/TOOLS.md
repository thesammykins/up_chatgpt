# Tool reference

All tools operate on the current user's personal Up data through the local broker. Tool arguments never accept an Up credential.

## Authentication

### `up_auth_status`

Check non-secret configuration and broker availability before the first financial call. If setup is missing, discover the installed directory with `codex plugin list` and direct the user to run `configure` and `unlock` in a real Terminal.

### `up_ping`

Validate an already-unlocked broker against Up's ping endpoint. It does not unlock 1Password and returns no credential.

## Read tools

### `up_list_accounts`

List accounts and available balances, optionally filtered by account type or ownership. Available balances include current holds. Begin with one page and fetch more only when `nextPageAvailable` is true.

### `up_list_transactions`

List a bounded, newest-first transaction set. Prefer explicit RFC 3339 `since` and `until` values plus account, status, category, or tag filters.

Privacy controls:

- `include_details` defaults to `false`, omitting `rawText`, `message`, `deepLinkURL`, and `foreignAmount` from returned transactions.
- `search_text` performs a case-insensitive local match across description, raw text, and message after fetching only the bounded API pages. It can match fields that remain omitted from output.
- Set `include_details: true` only when those optional fields are necessary for the user's request.
- `page_size` is 1–100 and `max_pages` is 1–5. Start at one page and increase only when required.

### `up_get_transaction`

Retrieve one transaction by resource ID. Use it only when the user identifies the transaction or a narrow search has already isolated it; it returns fuller API attributes than the list tool.

### `up_list_categories`

List the predefined category hierarchy, optionally by parent. Only categories with a non-null `parentCategoryId` are assignable children.

### `up_list_tags`

List active transaction tags with bounded pagination.

### `up_cashflow_summary`

Aggregate a bounded period using exact base-unit arithmetic. It includes settled transactions, excludes transfers between Up accounts by default, and supports grouping by category, parent category, account, description, or month.

The default period is a rolling 30×24 hours. State the effective range, grouping, excluded transfer count, skipped amount count, and whether another page remained. Do not present truncated output as complete.

## Metadata writes

The plugin exposes no money movement. These tools change transaction metadata only.

### `up_set_transaction_category`

Set or clear one transaction category. Before calling it:

1. Identify the exact transaction.
2. Resolve and verify the target as an assignable child category.
3. Show the current and proposed category to the user.
4. State that no money will move.
5. Obtain approval for that exact delta.

Only then pass `confirm: true`. Use `action: "set"` with `category_id`, or `action: "clear"` without it.

### `up_modify_transaction_tags`

Add or remove one to six unique tags on one transaction. Preview the exact current-to-proposed tag set and obtain approval before passing `confirm: true`.

## Error handling

- Broker missing, locked, or expired: ask the user to run `unlock` in a real Terminal.
- Touch ID cancelled: let the user retry `unlock`; do not introduce another credential path.
- `401`: run `lock`, update the referenced 1Password field, run `unlock` and `test`, then retry.
- `429`: wait or narrow the request; never paginate without a bound.
- Five pages still incomplete: report truncation and ask to narrow the date range.
