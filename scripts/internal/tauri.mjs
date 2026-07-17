#!/usr/bin/env node
/**
 * `pnpm tauri` wrapper that keeps `tauri dev` inside this checkout's isolation.
 *
 * Why this exists (#1588): the dev-server port lives in the gitignored
 * `dev.local.json`, but two separate places have to agree on it — Vite (which
 * binds the port) and Tauri's `build.devUrl` (which loads it). `devUrl` is a
 * static `http://localhost:1420` in `src-tauri/tauri.conf.json`, so a bare
 * `pnpm tauri dev` used to bind **1420 in every checkout** regardless of
 * `dev.local.json` — silently squatting on checkout 0's dev server and dev
 * agent, and producing cross-checkout flakiness that looks like a real bug.
 * Only `scripts/dev.sh` / `scripts/dev.cmd` resolved the port, so isolation held
 * by convention rather than by construction.
 *
 * This wrapper closes that gap for `tauri dev` by merging in a `build.devUrl`
 * pointing at the resolved port. Everything else is a strict pass-through —
 * `tauri build`, `tauri info`, etc. behave exactly as before, which matters
 * because CI builds run through here.
 */

import { createRequire } from "node:module";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

import { resolveDevPort } from "./dev-local.mjs";

/**
 * Apply this checkout's dev port to a `tauri` argument list.
 *
 * Only `dev` is touched; every other subcommand passes through untouched.
 *
 * The injected `--config` is placed **before** the caller's arguments because
 * Tauri merges configs left to right, with later values winning. So an explicit
 * `--config` (as `scripts/dev.sh` passes, carrying its CLI port override) still
 * takes precedence — `scripts/dev.sh` keeps working unchanged — while a config
 * that sets other keys but not `devUrl` still gets the isolated port. Inserting
 * at index 1 also keeps it ahead of any `--` runner/app argument separator.
 *
 * @param {string[]} args - arguments after `tauri` (e.g. `["dev"]`).
 * @param {number} devPort - the resolved Vite dev-server port.
 * @returns {string[]} the arguments to hand to the real Tauri CLI.
 */
export function applyDevPort(args, devPort) {
  if (args[0] !== "dev") return [...args];
  const config = JSON.stringify({ build: { devUrl: `http://localhost:${devPort}` } });
  return [args[0], "--config", config, ...args.slice(1)];
}

/** Run the real Tauri CLI, isolating `dev` to this checkout's port. */
function main() {
  const require = createRequire(import.meta.url);
  const cli = require("@tauri-apps/cli/main");

  const args = argv.slice(2);
  let effective = args;

  if (args[0] === "dev") {
    const devPort = resolveDevPort();
    // Exported for the `beforeDevCommand` (`pnpm dev` → vite.config.ts). Vite
    // resolves the port itself through the same resolver, so this only pins the
    // value both sides already agree on — and keeps `TERMIHUB_DEV_PORT` visible
    // to child processes, exactly as scripts/dev.sh sets it.
    env.TERMIHUB_DEV_PORT = String(devPort);
    effective = applyDevPort(args, devPort);
  }

  cli.run(effective, "pnpm tauri").catch((err) => {
    cli.logError(err.message);
    exit(1);
  });
}

// Importable for tests; only the real invocation runs the CLI.
if (argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
