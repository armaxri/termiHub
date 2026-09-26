#!/usr/bin/env node
// Summarize a `pnpm audit --json` payload for the ADVISORY full-tree audit step
// in security-audit.yml (SUP-008). Dev-dependency advisories do not gate, but
// they must not be silent either: this writes a per-severity count to the job
// summary and emits a GitHub warning annotation when any high or critical
// advisory is present. It always exits 0 — the step is advisory by design; the
// blocking production gate is pnpm-audit-prod-gate.sh.
//
// Usage: node scripts/internal/pnpm-audit-summary.mjs <audit.json>

import { appendFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/**
 * Build the summary line and annotation for an audit payload.
 *
 * @param {string} text - raw `pnpm audit --json` output.
 * @returns {{ line: string, annotation: string | null }}
 */
export function summarize(text) {
  let vulnerabilities;
  try {
    vulnerabilities = JSON.parse(text).metadata.vulnerabilities;
  } catch {
    vulnerabilities = undefined;
  }
  if (!vulnerabilities) {
    return {
      line: "no parseable audit JSON (registry unreachable?)",
      annotation: "::warning::full-tree pnpm audit returned no parseable JSON",
    };
  }
  const n = (severity) => vulnerabilities[severity] ?? 0;
  const line =
    `critical ${n("critical")}, high ${n("high")}, ` + `moderate ${n("moderate")}, low ${n("low")}`;
  const annotation =
    n("critical") + n("high") > 0
      ? `::warning title=Dev-dependency advisories::${line} ` +
        "(advisory, not gating; see docs/supply-chain.md)"
      : null;
  return { line, annotation };
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = "";
  try {
    text = readFileSync(process.argv[2], "utf8");
  } catch {
    // Missing file is reported as unparseable below.
  }
  const { line, annotation } = summarize(text);
  console.log(`pnpm audit (full tree): ${line}`);
  if (annotation) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### pnpm audit, full tree (advisory)\n\n${line}\n`
    );
  }
}
