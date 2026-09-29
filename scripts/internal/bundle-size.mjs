#!/usr/bin/env node
// Frontend bundle-size budget for the built `dist/` (audit findings TOOL-013,
// CI-012; #3757). Measures the total on-disk size of the Vite build output and
// compares it against a GENEROUS budget picked well above the current build, so
// only a large regression trips it, never normal growth.
//
// Over budget, it prints an `::error` annotation and exits 1. The CI job that
// runs it is post-merge only (#3325), so an over-budget bundle reds develop's
// push run of Code Quality, which the coordinator watches, instead of blocking
// a PR. Within budget, it exits 0. A missing `dist/` also exits 0: the build
// failure that caused it is owned by the real build lanes.
//
// Usage:
//   pnpm build && pnpm size
//   node scripts/internal/bundle-size.mjs [--dist <dir>] [--budget-mib <n>]
// `--dist` and `--budget-mib` exist for tests and dry runs of the alarm path.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIB = 1024 * 1024;

// Budget: current dist is ~34 MiB (measured 2026-09-19). 48 MiB sits ~40% above
// that, so routine additions stay green and only a large regression trips it.
export const BUDGET_BYTES = 48 * MIB;

/** Recursively sum the byte size of every file under `dir`. */
export function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

function mib(bytes) {
  return (bytes / MIB).toFixed(2);
}

/**
 * Grade a measured size against the budget.
 * @param {number} total bytes in dist/
 * @param {number} budget budget in bytes
 * @returns {{ok: boolean, lines: string[], annotation: string | null}}
 */
export function evaluate(total, budget) {
  const ok = total <= budget;
  const lines = [
    "## Bundle size",
    "",
    `dist/ total: ${mib(total)} MiB`,
    `budget:      ${mib(budget)} MiB`,
    ok
      ? `status:      OK (${mib(budget - total)} MiB headroom)`
      : `status:      OVER BUDGET by ${mib(total - budget)} MiB — find the size regression`,
  ];
  const annotation = ok
    ? null
    : `::error title=Bundle over budget::dist/ is ${mib(total)} MiB, over the ` +
      `${mib(budget)} MiB budget by ${mib(total - budget)} MiB. Find the size ` +
      "regression, or raise BUDGET_BYTES in scripts/internal/bundle-size.mjs if the " +
      "growth is intended.";
  return { ok, lines, annotation };
}

/** Parse `--dist <dir>` and `--budget-mib <n>`. */
export function parseArgs(argv) {
  const opts = { dist: join(repoRoot, "dist"), budget: BUDGET_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--dist" && value !== undefined) {
      opts.dist = resolve(value);
      i++;
    } else if (arg === "--budget-mib" && value !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --budget-mib: ${value}`);
      opts.budget = n * MIB;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * CLI entry. The report goes to stdout (CI appends it to the step summary);
 * the `::error` annotation goes to stderr so it reaches the log, where the
 * runner turns it into an annotation.
 * @returns {number} exit code
 */
export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (!existsSync(opts.dist)) {
    console.log(
      `${opts.dist} not found — run \`pnpm build\` first. Skipping the bundle-size check.`
    );
    return 0;
  }
  const { ok, lines, annotation } = evaluate(dirSize(opts.dist), opts.budget);
  for (const line of lines) console.log(line);
  if (annotation) console.error(annotation);
  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
