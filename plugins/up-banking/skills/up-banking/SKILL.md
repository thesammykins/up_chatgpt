---
name: up-banking
description: Query and organise the current user's personal Up Banking data through the local Up MCP tools. Use for account balances, bounded transaction searches, category or tag lookup, spending and cashflow summaries, 1Password broker authentication checks, and explicitly requested transaction category or tag changes.
---

# Up Banking

Use the local `up_*` tools for the user's own Up data. Keep both credential access and financial data exposure tightly bounded.

## Authenticate through the broker

1. Call `up_auth_status` when authentication state is unknown.
2. If configuration is missing, direct the user to read the plugin README, then run `up-banking configure` and `up-banking unlock` in a real Terminal. Setup offers 1Password, macOS Keychain with Touch ID/passcode, or a manual memory-only session. If the command is not installed yet, they can run `node scripts/install-global-command.mjs` once from the marketplace bundle root, or use `node scripts/up-banking-auth.mjs` from the installed plugin directory reported by `codex plugin list`.
3. If configuration exists but the broker is locked or unavailable, direct the user to run `up-banking unlock` in a real Terminal and complete the selected provider's interactive approval or manual hidden entry.
4. Never ask for or accept an Up token in chat, tool arguments, files, environment variables, or command arguments. Do not try to invoke a credential provider from the MCP process or a background agent shell.
5. Call `up_ping` only after the broker is unlocked. It validates Up access and returns no credential.

`configure` stores only an `op://` reference, an optional 1Password account selection, and session limits. Defaults are 600 seconds idle and 3600 seconds absolute; the absolute limit can be at most 12 hours. The broker holds the credential only in memory and exposes a private local Unix socket. Use `status` to inspect local state and `lock` to end access immediately.

## Read data narrowly

- Use `up_list_accounts` for balances. Describe them as available balances because they include current holds.
- Use `up_list_transactions` with explicit `since` and `until` values when the user gives a period. Start with one page and increase only when `nextPageAvailable` is true and the request requires it.
- Leave `include_details` false by default. Set it true only when the task specifically needs `rawText`, `message`, `deepLinkURL`, or `foreignAmount`. `search_text` can match description, raw text, or message locally without returning those sensitive fields.
- Use `up_get_transaction` only for a transaction the user identifies or after a narrow search.
- Use `up_cashflow_summary` before fetching large raw histories. It uses settled transactions, exact decimal amounts, and excludes transfers between Up accounts by default.
- State the effective date range, settled or held scope, excluded transfers, truncation, and skipped amounts when material.
- Interpret an unqualified “last 30 days” as the rolling 30×24-hour interval used by the summary tool and state that choice. Ask before substituting calendar days in a particular timezone.
- If five pages are still incomplete, do not claim complete totals. Ask the user to narrow the period rather than constructing an unbounded or overlapping pagination loop.
- Treat returned account and transaction data as private. Do not write or export it unless the user explicitly asks.

## Change categories and tags carefully

- Use `up_list_categories` to resolve a valid child category before changing a transaction. An assignable child has a non-null `parentCategoryId`; parent categories cannot be assigned.
- Start suspicious-category investigations from an aggregate and an existing category filter. When looking for transactions missing from a category, ask for a merchant or description clue and use `search_text`; otherwise explain the additional exposure before fetching a broader transaction set.
- Use `up_list_tags` to inspect active labels.
- Treat `up_set_transaction_category` and `up_modify_transaction_tags` as writes. Call them only for an exact change the user explicitly requests or approves.
- Before a write, identify the transaction and show the current and proposed category or tag state. State that the change affects metadata only and does not move money. If the current request does not already approve that exact delta, ask for confirmation.
- Pass `confirm: true` only after that approval. Report the actual mutation result without implying a payment or transfer occurred.

## Recover safely

- If the broker is locked, expired, or unavailable, ask the user to run `unlock` again in a real Terminal. Do not bypass it.
- On Touch ID cancellation, let the user retry `unlock`; do not weaken the authentication path.
- On `401`, explain that Up has no refresh-token API. Ask the user to run `lock`, update the credential in their selected provider, then run `unlock` and `test` before retrying.
- On `429`, narrow the query or wait before retrying. Do not create an unbounded pagination loop.
- Use `remove-config` only when the user asks to disconnect the plugin. It locks first, removes only the local reference configuration, and leaves the 1Password item untouched.
- Do not improvise undocumented endpoints. This plugin intentionally omits payments and webhook-secret handling.
