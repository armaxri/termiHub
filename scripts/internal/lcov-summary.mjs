#!/usr/bin/env node
// Summarize one or more concatenated lcov tracefiles into a single repo-wide
// coverage number. Shared by scripts/coverage.sh and scripts/coverage.cmd so the
// unified number is computed identically on every platform (TOOL-001), and by
// release-coverage-summary.mjs (#3658) through the exported helpers.
//
// lcov records carry per-file totals: LF/LH (lines found/hit), FNF/FNH
// (functions), BRF/BRH (branches). Summing each across every record in the
// merged file yields whole-app totals. Usage: node lcov-summary.mjs <file.lcov>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Sum LF/LH/FNF/FNH/BRF/BRH across every record of an lcov text. */
export function summarizeLcov(text) {
  const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    if (key in totals) {
      const n = Number.parseInt(line.slice(idx + 1), 10);
      if (Number.isFinite(n)) totals[key] += n;
    }
  }
  return totals;
}

export const pct = (hit, found) => (found > 0 ? (hit * 100) / found : 0);

/** The four-line summary coverage.sh prints and writes to summary.txt. */
export function formatSummary(totals) {
  const fmt = (label, hit, found) => `${label} ${hit}/${found}  (${pct(hit, found).toFixed(2)}%)`;
  return [
    fmt("lines:    ", totals.LH, totals.LF),
    fmt("functions:", totals.FNH, totals.FNF),
    fmt("branches: ", totals.BRH, totals.BRF),
    `UNIFIED WHOLE-APP LINE COVERAGE: ${pct(totals.LH, totals.LF).toFixed(2)}%`,
  ].join("\n");
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error("usage: lcov-summary.mjs <merged.lcov>");
    return 2;
  }
  console.log(formatSummary(summarizeLcov(readFileSync(file, "utf8"))));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
