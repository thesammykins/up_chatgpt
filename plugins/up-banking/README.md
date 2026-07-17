# Up Banking for Codex

A local Codex plugin for personal [Up API](https://developer.up.com.au/) workflows:

- available account balances
- bounded transaction search and detail
- categories and active tags
- exact-decimal cashflow summaries with internal transfers excluded by default
- explicitly confirmed transaction category and tag changes

The plugin has no payment tools and does not host a remote connector. Authentication uses a short-lived local broker and one of three interactive providers: 1Password, macOS Keychain with Touch ID/passcode, or a manual session that never persists a credential. Read this README before configuring it. The Up credential never enters Codex, the MCP process, environment variables, command arguments, or broker logs.

## Requirements

- Node.js 20 or newer
- an Up personal access token
- one of:
  - 1Password desktop app and CLI (`op`) with desktop integration; or
  - macOS with Swift/Xcode Command Line Tools for Keychain Touch ID/passcode; or
  - any interactive Terminal for a manual, memory-only session

## Secure setup

Find the installed plugin directory instead of guessing a cache path:

```bash
codex plugin list
```

Open a real, interactive Terminal, change to the listed `up-banking` directory, and configure the broker:

```bash
node scripts/up-banking-auth.mjs configure
```

To make this available from every Terminal directory, install the global launcher once from the marketplace bundle root:

```bash
node scripts/install-global-command.mjs
```

Then use `up-banking configure`, `up-banking unlock`, `up-banking status`, `up-banking test`, or `up-banking lock` from any directory. The launcher asks Codex for the current installed plugin location at runtime, so it does not retain a token or a stale plugin path.

`configure` asks which authentication method to use, then prompts for its non-secret reference and session limits:

- **1Password** — stores only an `op://` reference and optional account selection; unlock invokes the 1Password CLI and Touch ID.
- **macOS Keychain** — stores the token in a device-only Keychain item gated by Touch ID or passcode. The initial interactive setup supplies the token directly to the Keychain helper; it is not written to plugin configuration.
- **Manual session** — supported on macOS, Linux, and Windows. Every `unlock` presents a hidden Terminal prompt and retains the token only in the broker's bounded memory session.

The macOS Keychain option needs Xcode Command Line Tools because the plugin invokes a small local Swift helper using the native Security framework. It is intentionally unavailable on other operating systems.

The absolute limit can be at most 12 hours and cannot be shorter than the idle limit. Configuration stores only provider metadata and session limits: never the token. There is no token flag or environment-variable setup path.

Unlock the broker from the same real Terminal:

```bash
node scripts/up-banking-auth.mjs unlock
```

`unlock` invokes the selected provider, then starts a private local Unix-socket broker. Codex's background MCP process connects to that broker; it neither invokes the provider nor receives the credential. Manual-session users re-enter the token for every new broker session.

Check the local state and validate access after unlocking:

```bash
node scripts/up-banking-auth.mjs status
node scripts/up-banking-auth.mjs test
```

`test` requires an already-unlocked broker. It does not unlock 1Password itself.

Lock immediately or remove the non-secret configuration with:

```bash
node scripts/up-banking-auth.mjs lock
node scripts/up-banking-auth.mjs remove-config
```

`lock` stops the broker and clears its in-memory credential. `remove-config` locks first and removes configuration; it leaves 1Password items untouched and removes the plugin's macOS Keychain item when that provider is selected.

## Session lifecycle

Broker access expires after either:

- the configured idle limit, reset by broker activity; or
- the configured absolute limit, measured from unlock and never extended by activity.

The defaults are 10 minutes idle and 1 hour absolute. Run `unlock` again when a session expires. Run `lock` whenever access is no longer needed.

Locking the credential manager after `unlock` does not revoke an already-running broker session. Use the plugin's `lock` command for immediate revocation; otherwise the configured idle or absolute deadline applies. This avoids requiring a new Touch ID approval for every tool call.

## Token rotation, not refresh

Up does not publish OAuth or a token-refresh endpoint. Only one personal access token is active at a time, so generating a replacement invalidates the previous value.

To rotate it, lock the broker, update the 1Password item or re-run `configure` for Keychain/manual-session, then unlock and test. A `401` requires the same process.

## Data and mutation boundaries

The credential remains outside model and MCP context, but account and transaction data returned by tools can enter the conversation. The workflow therefore starts with narrow date ranges, one page, or a local aggregate instead of exposing a complete history.

Transaction lists omit `rawText`, `message`, `deepLinkURL`, and `foreignAmount` by default. Local `search_text` matching can inspect those fields inside the MCP process without returning them. Set `include_details: true` only when the user's task genuinely requires those fields.

Category and tag tools require `confirm: true`. Before calling either mutation, identify the transaction and preview the exact old-to-new metadata change for the user. These tools change metadata only; they never move money.

Pagination follows only opaque `links.next` URLs on the configured Up API origin. A response attempting to redirect an authenticated request to another origin is rejected. `429` and safe `5xx` responses use bounded retry behavior.

See [Security](docs/SECURITY.md) for the trust boundaries and [Tool reference](docs/TOOLS.md) for privacy and mutation guidance.

## Development and verification

No package installation is required; the MCP server uses Node.js built-ins. Run:

```bash
npm test
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/up-banking
```

Tests should cover MCP initialization and calls, the broker lifecycle, private configuration, session expiry, pagination-origin enforcement, exact cashflow arithmetic, mutation confirmation, retry behavior, redaction defaults, and assertions that a mock credential never reaches MCP output or persisted state.
