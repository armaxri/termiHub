#!/usr/bin/env node
// Advisory bundle-size report for the built frontend `dist/` (audit finding
// TOOL-013). Measures the total on-disk size of the Vite build output and
// compares it against a GENEROUS budget picked well above the current build so
// it only speaks up on a large regression, never on normal growth.
//
// This is REPORT-ONLY: it always exits 0. It never gates the build — the CI
// step that runs it is additionally `continue-on-error`. A red bundle-size
// check would be misleading; a large regression instead shows up as a loud
// "OVER BUDGET" line in the CI step summary for a human to weigh.
//
// Run `pnpm build` first so `dist/` exists; then `pnpm size`.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = join(repoRoot, "dist");

// Budget: current dist is ~34 MiB (measured 2026-09-19). 48 MiB sits ~40% above
// that, so routine additions stay green and only a large regression trips it.
const BUDGET_BYTES = 48 * 1024 * 1024;

/** Recursively sum the byte size of every file under `dir`. */
function dirSize(dir) {
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
  return (bytes / (1024 * 1024)).toFixed(2);
}

if (!existsSync(distDir)) {
  console.log("dist/ not found — run `pnpm build` first. Skipping bundle-size report (advisory).");
  process.exit(0);
}

const total = dirSize(distDir);
const overBudget = total > BUDGET_BYTES;

console.log("## Bundle size (advisory)");
console.log("");
console.log(`dist/ total: ${mib(total)} MiB`);
console.log(`budget:      ${mib(BUDGET_BYTES)} MiB`);
console.log(
  overBudget
    ? `status:      OVER BUDGET by ${mib(total - BUDGET_BYTES)} MiB — review for a size regression (advisory, non-blocking)`
    : `status:      OK (${mib(BUDGET_BYTES - total)} MiB headroom)`
);

// Always succeed: advisory report, never a gate.
process.exit(0);
