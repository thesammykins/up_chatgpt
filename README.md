# Up Banking Codex plugin bundle

This folder is an installable local Codex marketplace containing `up-banking` v0.1.0.

## Install directly from GitHub

In a Terminal with Codex installed, add this GitHub marketplace and then install the plugin:

```bash
codex plugin marketplace add thesammykins/up_chatgpt --ref main
codex plugin add up-banking@up-banking-local
```

Start a new Codex task after installation so the skill and MCP tools are loaded. Then read [the plugin README](plugins/up-banking/README.md) before running the interactive setup.

## Install from a local checkout

```bash
codex plugin marketplace add /absolute/path/to/up_chatgpt
codex plugin add up-banking@up-banking-local
```

## Configure authentication securely

Requirements: Node.js 20+, an Up personal access token, and an interactive Terminal. `configure` offers 1Password, macOS Keychain with Touch ID/passcode, or a no-persistence manual session for Linux, Windows, and other machines without a password manager.

Read [the plugin README](plugins/up-banking/README.md) before setup. From this marketplace bundle root—the directory containing this README—run:

```bash
node scripts/up-banking-auth.mjs configure
node scripts/up-banking-auth.mjs unlock
node scripts/up-banking-auth.mjs test
```

The root launcher forwards to the actual plugin script under `plugins/up-banking`. The same commands also work from the plugin directory shown by `codex plugin list` after installation.

## Unlock from any directory

Install the small global launcher once:

```bash
node scripts/install-global-command.mjs
```

Afterwards, use the same protected flow from any Terminal directory:

```bash
up-banking status
up-banking unlock
up-banking test
up-banking lock
```

The global command discovers the currently installed `up-banking` plugin through Codex at runtime, so it keeps working after a plugin update. It still requires a real Terminal because a background Codex MCP process cannot safely satisfy provider user-presence checks.

`configure` stores only non-secret provider metadata. `unlock` runs in your Terminal and starts a private local broker. The token is passed to that broker through a pipe and held only for a bounded session (10 minutes idle or one hour total by default); it is never put in Codex, plugin configuration, an environment variable, a command argument, or a disk file. The macOS Keychain provider stores the credential only in a device-local Keychain item guarded by Touch ID or passcode; manual sessions do not store it at all.

Locking a credential manager does not revoke an already-running broker. The bounded session avoids a new approval prompt on every tool call; use the plugin's `lock` command when you need immediate revocation.

Lock it explicitly at any time:

```bash
node scripts/up-banking-auth.mjs lock
```

See [plugins/up-banking/README.md](plugins/up-banking/README.md) for the security design, rotation flow, data boundaries, tool scope, and verification commands.
