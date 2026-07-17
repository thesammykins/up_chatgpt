# Security model

Up Banking for Codex separates interactive credential unlock from background tool execution. The user authorises a selected credential provider in a real Terminal; Codex and the MCP process never receive the Up credential.

## Trust boundaries

### Credential providers

The setup flow offers three providers:

- **1Password:** the token remains in a 1Password field. Configuration contains only its `op://` reference, optional account selection, and session limits.
- **macOS Keychain:** a local Swift helper creates a device-only Keychain item protected by `userPresence` (Touch ID or passcode). Configuration contains only the non-secret Keychain account label and session limits.
- **Manual session:** no credential is persisted. Each unlock reads the token from a hidden interactive Terminal prompt and transfers it directly into the broker.

No provider writes a token to plugin configuration.

### Interactive unlock

`node scripts/up-banking-auth.mjs unlock` must run in a real Terminal. 1Password and macOS Keychain can present Touch ID/passcode; manual sessions request a hidden token entry. Each path starts the local broker only after obtaining the credential. There is no token command flag, environment-variable path, or MCP tool argument.

For convenience, `up-banking unlock` can be installed as a global Terminal command. It is only a location-independent launcher for this same interactive flow; it does not let Codex or the MCP process unlock a provider in the background.

### Local broker

The broker holds the credential only in process memory and listens on a private local Unix socket. The MCP process sends bounded Up requests through that socket and receives response data, never the credential. The credential does not enter Codex context, MCP input or output, configuration, environment variables, command arguments, logs, or files on disk.

The socket directory is user-only (`0700`) and the socket is `0600`. As with other per-user desktop integrations, another process already running as the same macOS user could use that local socket while it is unlocked; protecting against a compromised same-user process is outside this plugin's boundary. The absolute session deadline limits that exposure.

The broker expires at the first of:

- the idle deadline, reset by broker activity; or
- the absolute deadline, measured from unlock and unaffected by activity.

Defaults are 600 seconds idle and 3600 seconds absolute. The absolute limit can be configured up to 12 hours. `lock` stops the broker immediately and clears its in-memory credential.

Locking a credential manager after `unlock` does not signal or revoke an already-running broker. Use the plugin's `lock` command for immediate revocation; otherwise the broker remains available until its idle or absolute deadline. This is the deliberate tradeoff that avoids a new Touch ID approval for every tool call.

### Codex and MCP

Tool results can contain private account and transaction data. That data may enter model context even though the credential does not. Use aggregates and bounded filters first, expose optional transaction details only when needed, and never persist or export financial data without an explicit request.

## Configuration lifecycle

Use `codex plugin list` to discover the installed directory, then run these commands from a real Terminal:

```bash
node scripts/up-banking-auth.mjs configure
node scripts/up-banking-auth.mjs unlock
node scripts/up-banking-auth.mjs status
node scripts/up-banking-auth.mjs test
node scripts/up-banking-auth.mjs lock
node scripts/up-banking-auth.mjs remove-config
```

- `configure` records only provider metadata and session limits. Keychain setup passes the token directly to the Keychain helper; manual-session setup records no credential at all.
- `unlock` invokes the selected provider and starts the broker after the interactive approval or hidden manual entry.
- `status` reports non-secret configuration and broker state.
- `test` validates Up access through an already-unlocked broker.
- `lock` stops the broker and clears the in-memory credential.
- `remove-config` locks first and deletes configuration. It leaves 1Password items untouched and deletes the plugin-owned macOS Keychain item.

## Up API containment

- The plugin exposes no payment operations.
- Category and tag writes require an exact user-approved preview and `confirm: true`.
- Pagination accepts only opaque next links on the configured Up API origin.
- Authentication failures should not trigger blind retries. On `401`, lock the broker, update the selected provider's credential, unlock again, and test.
- Rate limits use bounded retry behavior; callers must narrow or wait rather than loop indefinitely.

## Disclosure checklist

Before returning financial results:

- prefer `up_cashflow_summary` over a raw history;
- bound transaction queries by date and page count;
- keep `include_details` false unless optional fields are necessary;
- state settled versus held scope and whether internal transfers were excluded;
- disclose truncation and skipped amounts;
- avoid writing transaction data to disk or external services unless explicitly requested.
