#!/usr/bin/env node
// Summarize a `pnpm audit --json` payload for the full-tree audit step in
// security-audit.yml (SUP-008, #3755 / CI-012). Dev-dependency advisories do not
// ship, so in general they only warn: the step writes a per-severity count to the
// job summary and emits a GitHub warning annotation when any high or critical
// advisory is present.
//
// Forcing function (#3755): a high or critical advisory that ALREADY HAS A
// PATCHED VERSION fails the step (exit 1). There is nothing to wait for upstream,
// so it must be acted on: bump the tool, run `pnpm update <pkg>`, or add an
// override (with its row in docs/supply-chain.md). An advisory with no patched
// version (`patched_versions` of "<0.0.0", pnpm's own "unfixable" marker) keeps
// warning only. A fixable advisory that genuinely cannot be taken yet goes into
// package.json `pnpm.auditConfig.ignoreGhsas`, documented in docs/supply-chain.md;
// pnpm drops it from the payload and this script skips it as well.
//
// An unparseable payload (registry unreachable) only warns: the blocking
// production gate, pnpm-audit-prod-gate.sh, owns the registry-outage policy.
//
// Usage: node scripts/internal/pnpm-audit-summary.mjs <audit.json>

import { appendFileSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// pnpm's marker for "no patched version exists" (see pnpm audit --ignore-unfixable).
const UNFIXABLE = "<0.0.0";
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/**
 * High/critical advisories that already have a patched version.
 *
 * @param {Record<string, any>} advisories - the payload's `advisories` map.
 * @param {string[]} ignoreGhsas - GHSA ids accepted in package.json auditConfig.
 * @returns {{ module: string, severity: string, patched: string, id: string, url: string }[]}
 */
export function fixableBlocking(advisories, ignoreGhsas = []) {
  return Object.values(advisories ?? {})
    .filter((a) => BLOCKING_SEVERITIES.has(a?.severity))
    .filter((a) => typeof a.patched_versions === "string" && a.patched_versions.trim() !== "")
    .filter((a) => a.patched_versions.trim() !== UNFIXABLE)
    .filter((a) => !ignoreGhsas.includes(a.github_advisory_id))
    .map((a) => ({
      module: a.module_name,
      severity: a.severity,
      patched: a.patched_versions,
      id: a.github_advisory_id ?? String(a.id),
      url: a.url ?? "",
    }))
    .sort((x, y) => x.module.localeCompare(y.module) || x.id.localeCompare(y.id));
}

/**
 * Build the summary line, annotation and blocking findings for an audit payload.
 *
 * @param {string} text - raw `pnpm audit --json` output.
 * @param {string[]} ignoreGhsas - GHSA ids accepted in package.json auditConfig.
 * @returns {{ line: string, annotation: string | null, fixable: ReturnType<typeof fixableBlocking> }}
 */
export function summarize(text, ignoreGhsas = []) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  const vulnerabilities = payload?.metadata?.vulnerabilities;
  if (!vulnerabilities) {
    return {
      line: "no parseable audit JSON (registry unreachable?)",
      annotation: "::warning::full-tree pnpm audit returned no parseable JSON",
      fixable: [],
    };
  }
  const n = (severity) => vulnerabilities[severity] ?? 0;
  const line =
    `critical ${n("critical")}, high ${n("high")}, ` + `moderate ${n("moderate")}, low ${n("low")}`;
  const annotation =
    n("critical") + n("high") > 0
      ? `::warning title=Dev-dependency advisories::${line} ` +
        "(only a high/critical with a patched version fails; see docs/supply-chain.md)"
      : null;
  return { line, annotation, fixable: fixableBlocking(payload.advisories, ignoreGhsas) };
}

/** GHSA ids accepted via package.json `pnpm.auditConfig.ignoreGhsas`. */
export function readIgnoreGhsas(packageJsonText) {
  try {
    const ids = JSON.parse(packageJsonText)?.pnpm?.auditConfig?.ignoreGhsas;
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = "";
  try {
    text = readFileSync(process.argv[2], "utf8");
  } catch {
    // Missing file is reported as unparseable below.
  }
  let packageJson = "";
  try {
    packageJson = readFileSync("package.json", "utf8");
  } catch {
    // Not run from the repo root: no accepted ignores.
  }
  const { line, annotation, fixable } = summarize(text, readIgnoreGhsas(packageJson));
  console.log(`pnpm audit (full tree): ${line}`);
  if (annotation) console.log(annotation);
  for (const f of fixable) {
    console.log(
      `::error title=Fixable ${f.severity} advisory::${f.module} ${f.id} is fixed in ` +
        `${f.patched} ${f.url}`.trimEnd()
    );
  }
  if (fixable.length > 0) {
    console.log(
      `${fixable.length} high/critical advisory(ies) already have a patched version. ` +
        "Take the fix (bump the tool, `pnpm update <pkg>`, or an override with a row in " +
        "docs/supply-chain.md). If it truly cannot be taken yet, add the GHSA id to " +
        "package.json pnpm.auditConfig.ignoreGhsas and document why in docs/supply-chain.md."
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = fixable.map(
      (f) => `- **${f.module}** ${f.id} (${f.severity}), fixed in \`${f.patched}\``
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### pnpm audit, full tree\n\n${line}\n` +
        (rows.length ? `\n**Fixable high/critical (fails the step):**\n\n${rows.join("\n")}\n` : "")
    );
  }
  process.exit(fixable.length > 0 ? 1 : 0);
}
