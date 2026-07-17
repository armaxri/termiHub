#!/usr/bin/env node
/**
 * `pnpm tauri` wrapper that keeps `tauri dev` inside this checkout's isolation.
 *
 * Why this exists (#1588): the dev server's port lives in the gitignored
 * `dev.local.json`, but two separate places have to agree on it — Vite (which
 * binds the port) and Tauri's `build.devUrl` (which loads it). `devUrl` is a
 * static `http://localhost:1420` in `src-tauri/tauri.conf.json`, so a bare
 * `pnpm tauri dev` used to bind **1420 in every checkout** regardless of
 * `dev.local.json` — silently squatting on checkout 0's port and dev agent, and
 * producing cross-checkout flakiness that looks like a real bug. Only
 * `scripts/dev.sh` / `scripts/dev.cmd` resolved the port, so isolation held by
 * convention rather than by construction.
 *
 * This wrapper closes that gap for `tauri dev`:
 *   - exports `TERMIHUB_DEV_PORT` so the `beforeDevCommand` Vite child agrees,
 *   - merges in a `build.devUrl` pointing at the same port.
 *
 * Everything else is a strict pass-through — `tauri build`, `tauri info`, etc.
 * behave exactly as before, which matters because CI builds run through here.
 *
 * The injected `--config` is placed **before** the caller's arguments, and Tauri
 * merges configs left to right with later values winning. So an explicit
 * `--config` (as `scripts/dev.sh` passes, carrying its CLI port override) still
 * takes precedence, and `scripts/dev.sh` keeps working unchanged.
 */

import { createRequire } from "node:module";

import { resolveDevPort } from "./dev-local.mjs";

const require = createRequire(import.meta.url);
const cli = require("@tauri-apps/cli/main");

const args = process.argv.slice(2);

if (args[0] === "dev") {
  const devPort = resolveDevPort();
  // Exported for the `beforeDevCommand` (`pnpm dev` → vite.config.ts). Vite
  // resolves the port itself via the same resolver, so this only pins the value
  // both sides already agree on — and keeps `TERMIHUB_DEV_PORT` visible to any
  // other child process, exactly as scripts/dev.sh sets it.
  process.env.TERMIHUB_DEV_PORT = String(devPort);
  const devUrl = `http://localhost:${devPort}`;
  args.splice(1, 0, "--config", JSON.stringify({ build: { devUrl } }));
}

cli.run(args, "pnpm tauri").catch((err) => {
  cli.logError(err.message);
  process.exit(1);
});
