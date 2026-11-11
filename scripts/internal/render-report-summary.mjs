#!/usr/bin/env node
// Render a nightly test's JSON report as job-summary rows (#5352).
//
// The plugin sandbox perf gate (core/tests/plugin_runner_perf.rs) and the
// injected-shell side-effect audit (core/src/backends/local_shell_side_effect_tests.rs)
// write a report into $TERMIHUB_REPORT_DIR:
//
//   { "schema": 1, "report": "plugin-sandbox-perf", "title": "...",
//     "rows": [ { "metric": "...", "value": 12, "unit": "µs",
//                 "op": "<=", "budget": 500, "verdict": "pass" },
//               { "metric": "...", "value": 1, "baseline": 0,
//                 "baseline_label": "plain shell", "verdict": "info" } ] }
//
// This prints a Markdown table (metric, measured value, budget, verdict) under
// a heading that names the commit, so a run's numbers can be read without
// re-running the test. A report from before the rows existed (only flat
// fields, e.g. main's older perf test) is rendered as reported-only rows. A
// missing report prints one line saying so: the step runs under `if: always()`
// and a gate that failed before it measured still says why it has no numbers.
//
// Usage:
//   node scripts/internal/render-report-summary.mjs [--commit <sha>]
//     [--label <text>] [--out <file>] <report.json>...
// --out appends to the file (pass "$GITHUB_STEP_SUMMARY"); without it the
// Markdown goes to stdout. Always exits 0 unless the arguments are wrong:
// the test step, not this one, carries the verdict.
// The pure helpers are exported for unit testing (render-report-summary.test.mjs).

import { appendFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

const VERDICT_TEXT = { pass: "pass", fail: "**FAIL**", info: "reported" };
const OP_TEXT = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", "==": "=" };

/** Escape a value for a Markdown table cell. */
export function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A measured value with its unit; null/undefined is "n/a". */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return "n/a";
  return unit ? `${value} ${unit}` : String(value);
}

/** The budget column: `≤ 500 µs`, `plain shell: 0`, or `—`. */
export function formatBudget(row) {
  if (row.budget !== undefined && row.budget !== null) {
    const op = OP_TEXT[row.op] ?? row.op ?? "";
    return `${op ? `${op} ` : ""}${formatValue(row.budget, row.unit)}`;
  }
  if (row.baseline !== undefined && row.baseline !== null) {
    return `${row.baseline_label ?? "baseline"}: ${formatValue(row.baseline, row.unit)}`;
  }
  return "—";
}

/** Compare `value op budget`; undefined when it cannot be decided. */
export function compare(value, op, budget) {
  if (typeof value !== "number" || typeof budget !== "number") return undefined;
  switch (op) {
    case "<=":
      return value <= budget;
    case ">=":
      return value >= budget;
    case "<":
      return value < budget;
    case ">":
      return value > budget;
    case "==":
      return value === budget;
    default:
      return undefined;
  }
}

/**
 * The row's verdict: the test's own when given, else computed from the
 * budget, else "info" (reported only).
 */
export function verdictOf(row) {
  if (typeof row.verdict === "string" && row.verdict in VERDICT_TEXT) return row.verdict;
  const ok = compare(row.value, row.op, row.budget);
  if (ok === undefined) return "info";
  return ok ? "pass" : "fail";
}

/** A report without `rows` (the old flat shape): every field reported only. */
export function legacyRows(report) {
  return Object.entries(report)
    .filter(([, value]) => value === null || ["number", "string", "boolean"].includes(typeof value))
    .map(([metric, value]) => ({ metric, value, verdict: "info" }));
}

/**
 * Render one report as Markdown.
 *
 * @param {object | null} report the parsed JSON, or null when it is missing
 * @param {{ name: string, commit?: string, label?: string, error?: string }} meta
 * @returns {string}
 */
export function renderReport(report, meta) {
  const title = report?.title ?? meta.name;
  const label = meta.label ? ` (${meta.label})` : "";
  const commit = meta.commit ? ` · \`${meta.commit.slice(0, 12)}\`` : "";
  const lines = [`### ${title}${label}${commit}`, ""];
  if (meta.error) {
    lines.push(`Report \`${meta.name}\` could not be read: ${meta.error}`, "");
    return lines.join("\n");
  }
  if (report === null) {
    lines.push(`No report \`${meta.name}\` written (the test failed before it measured).`, "");
    return lines.join("\n");
  }
  const rows = Array.isArray(report.rows) ? report.rows : legacyRows(report);
  if (rows.length === 0) {
    lines.push("The report has no rows (nothing was measured on this runner).", "");
    return lines.join("\n");
  }
  const verdicts = rows.map(verdictOf);
  const failed = verdicts.filter((v) => v === "fail").length;
  const gated = verdicts.filter((v) => v !== "info").length;
  if (gated > 0) {
    lines.push(
      failed === 0 ? `All ${gated} budgets met.` : `**${failed} of ${gated} budgets breached.**`,
      ""
    );
  }
  if (report.release === false) {
    lines.push("Debug build: numbers are indicative only; budgets not asserted.", "");
  }
  lines.push("| Metric | Measured | Budget | Verdict |", "| --- | --- | --- | --- |");
  rows.forEach((row, i) => {
    lines.push(
      `| ${cell(row.metric ?? "?")} | ${cell(formatValue(row.value, row.unit))} | ${cell(
        formatBudget(row)
      )} | ${VERDICT_TEXT[verdicts[i]]} |`
    );
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Read and parse one report file.
 *
 * @param {string} file
 * @returns {{ report: object | null, error?: string }}
 */
export function loadReport(file) {
  if (!existsSync(file)) return { report: null };
  try {
    const report = JSON.parse(readFileSync(file, "utf8"));
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
      return { report: null, error: "not a JSON object" };
    }
    return { report };
  } catch (err) {
    return { report: null, error: err.message };
  }
}

/** Parse argv; throws on a usage error. */
export function parseArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit" || arg === "--label" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.files.length === 0) throw new Error("no report file given");
  return opts;
}

/** Render every file named on the command line. */
export function renderFiles(opts) {
  return opts.files
    .map((file) => {
      const { report, error } = loadReport(file);
      return renderReport(report, {
        name: path.basename(file),
        commit: opts.commit,
        label: opts.label,
        error,
      });
    })
    .join("\n");
}

if (isMainModule(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`render-report-summary: ${err.message}`);
    console.error(
      "usage: render-report-summary.mjs [--commit <sha>] [--label <text>] [--out <file>] <report.json>..."
    );
    process.exit(2);
  }
  const markdown = renderFiles(opts);
  if (opts.out) appendFileSync(opts.out, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}
