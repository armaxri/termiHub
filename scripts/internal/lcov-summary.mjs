#!/usr/bin/env node
// Summarize one or more concatenated lcov tracefiles into a single repo-wide
// coverage number. Shared by scripts/coverage.sh and scripts/coverage.cmd so the
// unified number is computed identically on every platform (TOOL-001).
//
// lcov records carry per-file totals: LF/LH (lines found/hit), FNF/FNH
// (functions), BRF/BRH (branches). Summing each across every record in the
// merged file yields whole-app totals. Usage: node lcov-summary.mjs <file.lcov>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: lcov-summary.mjs <merged.lcov>");
  process.exit(2);
}

const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const idx = line.indexOf(":");
  if (idx === -1) continue;
  const key = line.slice(0, idx);
  if (key in totals) {
    const n = Number.parseInt(line.slice(idx + 1), 10);
    if (Number.isFinite(n)) totals[key] += n;
  }
}

const pct = (hit, found) => (found > 0 ? (hit * 100) / found : 0);
const fmt = (label, hit, found) => `${label} ${hit}/${found}  (${pct(hit, found).toFixed(2)}%)`;

console.log(fmt("lines:    ", totals.LH, totals.LF));
console.log(fmt("functions:", totals.FNH, totals.FNF));
console.log(fmt("branches: ", totals.BRH, totals.BRF));
console.log(`UNIFIED WHOLE-APP LINE COVERAGE: ${pct(totals.LH, totals.LF).toFixed(2)}%`);
