/**
 * Per-checkout dev settings resolved from `dev.local.json` (parallel isolation).
 *
 * This is the **Node** third of the resolver trio; the other two are
 * `scripts/internal/dev-local-env.sh` (shell) and
 * `tests/system/termihub_harness/dev_local.py` (Python). All three read the same
 * gitignored `dev.local.json` and apply the same precedence, so several
 * checkouts can run their dev servers and test environments at once without
 * contending. See docs/testing.md → "Parallel test isolation".
 *
 * Precedence for every value: an explicit **environment variable** wins (so
 * `scripts/dev.sh` and CI keep overriding), then the `dev.local.json` key, then
 * a built-in default that reproduces the historical single-checkout behaviour
 * exactly. A missing or malformed file is therefore never an error — it just
 * means "use the defaults", which is the fresh-clone / CI case.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Vite dev-server port when nothing else says otherwise (checkout 0). */
export const DEFAULT_DEV_PORT = 1420;

/** Repo root: `scripts/internal/dev-local.mjs` → up two. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Parse a port from a JSON value or env string.
 *
 * @param {unknown} value
 * @returns {number | null} the port, or `null` if absent/unusable.
 */
function parsePort(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const port = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Parse `dev.local.json` from `repoRoot`; `{}` when absent or invalid.
 *
 * @param {string} [repoRoot]
 * @returns {Record<string, unknown>}
 */
export function readDevLocal(repoRoot = REPO_ROOT) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(repoRoot, "dev.local.json"), "utf8"));
  } catch {
    return {};
  }
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
}

/**
 * The Vite dev-server port: `TERMIHUB_DEV_PORT` > `dev.local.json` > 1420.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {number}
 */
export function resolveDevPort({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  return (
    parsePort(env.TERMIHUB_DEV_PORT) ??
    parsePort(readDevLocal(repoRoot).dev_port) ??
    DEFAULT_DEV_PORT
  );
}
