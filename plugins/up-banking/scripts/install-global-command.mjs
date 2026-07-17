#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TARGET = path.join(os.homedir(), ".local", "bin", "up-banking");

function usage() {
  return "Usage: node scripts/install-global-command.mjs [--target /absolute/path/to/up-banking]";
}

function parseTarget(argv) {
  if (argv.length === 0) return DEFAULT_TARGET;
  if (argv.length === 2 && argv[0] === "--target" && path.isAbsolute(argv[1])) {
    const target = path.resolve(argv[1]);
    if (path.basename(target) !== "up-banking") {
      throw new Error("The global command target must be named up-banking.");
    }
    return target;
  }
  throw new Error(usage());
}

function wrapperSource() {
  return `#!/bin/sh
set -eu
plugin_path="$(codex plugin list 2>/dev/null | awk '$1 ~ /^up-banking@/ { print $NF; exit }')"
if [ -z "$plugin_path" ] || [ ! -f "$plugin_path/scripts/up-banking-auth.mjs" ]; then
  printf '%s\\n' 'Up Banking is not installed. Run: codex plugin add up-banking@up-banking-local' >&2
  exit 1
fi
exec node "$plugin_path/scripts/up-banking-auth.mjs" "$@"
`;
}

async function assertSafeExistingTarget(target) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Refusing to replace a non-regular global command target.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function install(target) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Refusing to use a non-directory global command path.");
  }
  await assertSafeExistingTarget(target);

  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o755,
  );
  try {
    await handle.writeFile(wrapperSource(), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await chmod(target, 0o755);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

const target = parseTarget(process.argv.slice(2));
await install(target);
process.stdout.write(`Installed global Up Banking command: ${target}\n`);
process.stdout.write("Use it from any directory: up-banking unlock\n");
