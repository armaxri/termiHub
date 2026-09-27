#!/usr/bin/env node
// PR Gate: the one always-reporting aggregate check of code-quality.yml (#3678).
//
// The per-PR test legs are matrix jobs whose legs depend on the changed areas,
// so no leg name (`Run Tests (ubuntu-latest)`, ...) can be a required check
// without blocking docs-only PRs forever. The `PR Gate` job `needs:` every
// correctness job of the workflow, runs with `if: always()`, and calls this
// script with `NEEDS_JSON: ${{ toJSON(needs) }}`. It fails when any needed job
// failed or was cancelled; `success` and `skipped` (an area the PR does not
// touch) pass. Anything else (an unknown or empty result) fails closed.
//
// Usage (in CI):
//   NEEDS_JSON='{"tests":{"result":"success"}}' node scripts/internal/pr-gate.mjs
// Exit codes: 0 all needed jobs passed or were skipped, 1 a needed job did not
// pass, 2 NEEDS_JSON missing or malformed.
//
// The pure helpers are exported for unit testing (pr-gate.test.mjs), including
// a minimal workflow parser the test uses to keep the gate's `needs:` in sync
// with the workflow's jobs (a new correctness job must be added to the gate or
// listed in GATE_EXCLUDED with a reason).

import { appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** Job id of the gate itself in code-quality.yml. */
export const GATE_JOB_ID = "pr-gate";

/** Check name the branch protection requires. */
export const GATE_JOB_NAME = "PR Gate";

/**
 * Jobs of code-quality.yml deliberately NOT gated, with the reason. Every other
 * job must appear in the gate's `needs:` (enforced by pr-gate.test.mjs).
 */
export const GATE_EXCLUDED = {
  "bundle-size": "advisory (continue-on-error) and push-only; never runs on a PR",
};

/** Job results that count as a pass. */
const PASSING = new Set(["success", "skipped"]);

/**
 * Evaluate the `needs` context of the gate job.
 * @param {Record<string, {result?: string}>} needs
 * @returns {{ok: boolean, rows: {job: string, result: string, ok: boolean}[]}}
 */
export function evaluateNeeds(needs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("needs must be an object keyed by job id");
  }
  const rows = Object.keys(needs)
    .sort()
    .map((job) => {
      const result = String(needs[job]?.result ?? "");
      return { job, result: result || "(none)", ok: PASSING.has(result) };
    });
  if (rows.length === 0) {
    throw new Error("needs is empty; the gate must depend on at least one job");
  }
  return { ok: rows.every((r) => r.ok), rows };
}

/** Render the evaluation as a Markdown table (step summary and log). */
export function formatReport({ ok, rows }) {
  const lines = [
    `### ${GATE_JOB_NAME}: ${ok ? "passed" : "FAILED"}`,
    "",
    "| Job | Result | Gate |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.job} | ${r.result} | ${r.ok ? "ok" : "BLOCKS"} |`),
    "",
  ];
  if (!ok) {
    lines.push("A needed job failed or was cancelled; `success` and `skipped` pass.", "");
  }
  return lines.join("\n");
}

function stripComment(value) {
  return value.replace(/\s+#.*$/, "").trim();
}

function parseInlineList(value) {
  const v = stripComment(value);
  if (v.startsWith("[")) {
    return v
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return v ? [v] : [];
}

/**
 * Minimal structural parser for a GitHub Actions workflow: returns each job's
 * id with its `name`, `needs`, `if` and `continue-on-error`. It relies on the
 * repository's 2-space YAML indentation (jobs at 2, job keys at 4) and handles
 * scalar, flow-list and block-list `needs`, and folded (`>-`) `if` values.
 * @param {string} text
 * @returns {Map<string, {name?: string, needs: string[], if?: string, continueOnError: boolean}>}
 */
export function parseWorkflowJobs(text) {
  const jobs = new Map();
  const lines = text.split(/\r?\n/);
  let inJobs = false;
  let job = null;
  let key = null; // the 4-indent key whose continuation lines we are reading
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*(#.*)?$/.test(line);
      job = null;
      key = null;
      continue;
    }
    if (!inJobs || /^\s*(#.*)?$/.test(line)) continue;
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (jobMatch) {
      job = { needs: [], continueOnError: false };
      jobs.set(jobMatch[1], job);
      key = null;
      continue;
    }
    if (!job) continue;
    const keyMatch = line.match(/^ {4}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, k, raw] = keyMatch;
      const value = stripComment(raw);
      key = k;
      if (k === "name") job.name = value.replace(/^(['"])(.*)\1$/, "$2");
      else if (k === "needs") job.needs = parseInlineList(raw);
      else if (k === "if") job.if = /^[>|]-?$/.test(value) ? "" : value;
      else if (k === "continue-on-error") job.continueOnError = value === "true";
      continue;
    }
    // Continuation of a 4-indent key (deeper indentation).
    if (/^ {5,}/.test(line)) {
      const item = line.match(/^ {4,}- +(.+)$/);
      if (key === "needs" && item) job.needs.push(stripComment(item[1]));
      else if (key === "if") job.if = `${job.if ?? ""} ${line.trim()}`.trim();
    }
  }
  return jobs;
}

/** Job ids the gate must need: every job except the gate and GATE_EXCLUDED. */
export function expectedGateNeeds(jobs, excluded = GATE_EXCLUDED) {
  return [...jobs.keys()].filter((id) => id !== GATE_JOB_ID && !(id in excluded)).sort();
}

export function main(env = process.env, log = console.log) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON ?? "");
  } catch {
    log("::error::NEEDS_JSON is missing or not valid JSON (pass ${{ toJSON(needs) }})");
    return 2;
  }
  let evaluation;
  try {
    evaluation = evaluateNeeds(needs);
  } catch (e) {
    log(`::error::${e.message}`);
    return 2;
  }
  const report = formatReport(evaluation);
  log(report);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report}\n`);
  for (const r of evaluation.rows.filter((row) => !row.ok)) {
    log(`::error::${GATE_JOB_NAME}: needed job '${r.job}' finished with '${r.result}'`);
  }
  return evaluation.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
