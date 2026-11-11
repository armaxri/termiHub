#!/usr/bin/env node
// Integration-overlay freshness gate (#5346, audit COV-022).
//
// The Coverage workflow merges two nightly lcov overlays into the unified
// report: the Docker fixtures lane (integration-fixtures.yml) and the Python
// bridge harness lane (system-integration.yml). fetch-integration-coverage.mjs
// downloads them and writes <out-dir>/overlay-status.json: per lane, the
// measured commit, when it was measured, how far HEAD has moved since and how
// many of the overlay's own files changed since (lcov-merge.mjs skips those).
//
// Before this gate a dark lane was invisible: on 2026-11-09 both overlays were
// 11 days and 218 commits old, ~150 files each were silently skipped, and the
// summary only said "lines gained". This script:
//
//   * prints each overlay's source sha, age in days, commits behind HEAD and
//     its stale-file count and share into the job summary (--summary);
//   * fails (exit 1) when an overlay is missing, older than
//     MAX_OVERLAY_AGE_DAYS, or more than MAX_STALE_SHARE of its files are
//     stale, naming the lane that went dark and linking its latest run.
//
// It runs as its own step ("Integration overlay freshness") AFTER the ratchet,
// so the unit-coverage ratchet's verdict never depends on it. The verdict only
// gates on GATED_BRANCHES (the branch the nightlies grade); any other ref gets
// the same report as warnings.
//
// Usage: node overlay-freshness.mjs --status <overlay-status.json>
//          [--summary <md>] [--now <iso>]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";
import { normalizePath, parseLcov } from "./lcov-merge.mjs";

/**
 * An overlay older than this many days means its nightly lane has missed
 * (at least) three daily runs: a dark lane, not a late cron.
 */
export const MAX_OVERLAY_AGE_DAYS = 3;
/**
 * More than this share of the overlay's own files changed since it was
 * measured means most of what it would add is skipped as stale, so the
 * "unit + integration" number is close to unit-only.
 */
export const MAX_STALE_SHARE = 0.1;
/** Branches whose overlays the nightlies produce; elsewhere the gate only warns. */
export const GATED_BRANCHES = new Set(["develop"]);
export const STATUS_FILE = "overlay-status.json";

const DAY_MS = 24 * 3600 * 1000;

/** Days between `measuredAt` (ISO) and `now` (ms), or null when unknown. */
export function ageDays(measuredAt, now) {
  const t = Date.parse(measuredAt ?? "");
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / DAY_MS);
}

/** Repo-relative source files an lcov tracefile covers. */
export function lcovFiles(text, root) {
  return new Set(parseLcov(text, root).keys());
}

/**
 * How many of the overlay's files are in the stale list (changed since the
 * measured commit). `share` is 0 for an empty overlay.
 */
export function staleShare(overlayFiles, staleFiles) {
  const files = [...overlayFiles];
  const stale = files.filter((f) => staleFiles.has(normalizePath(f))).length;
  return { stale, total: files.length, share: files.length > 0 ? stale / files.length : 0 };
}

/**
 * The problems with one lane's overlay: missing, too old, too stale.
 * `lane` is an overlay-status.json entry. Returns a list of phrases.
 */
export function evaluateOverlay(lane, now) {
  if (!lane.present) return [`no usable overlay (${lane.note ?? "nothing fetched"})`];
  const problems = [];
  const age = ageDays(lane.measuredAt, now);
  if (age === null) problems.push("its measurement time is unknown");
  else if (age > MAX_OVERLAY_AGE_DAYS) {
    problems.push(`it is ${age.toFixed(1)} days old (limit ${MAX_OVERLAY_AGE_DAYS})`);
  }
  if (lane.overlayFiles > 0 && lane.staleOverlayFiles / lane.overlayFiles > MAX_STALE_SHARE) {
    problems.push(
      `${lane.staleOverlayFiles} of its ${lane.overlayFiles} files ` +
        `(${pct(lane.staleOverlayFiles / lane.overlayFiles)}) changed since ` +
        `(limit ${pct(MAX_STALE_SHARE)})`
    );
  }
  return problems;
}

/** Evaluate every lane; `gated` says whether problems fail the step. */
export function evaluateStatus(status, now) {
  const gated = GATED_BRANCHES.has(status.branch);
  const lanes = (status.lanes ?? []).map((lane) => ({
    lane,
    problems: evaluateOverlay(lane, now),
  }));
  return { gated, lanes, failed: gated && lanes.some((l) => l.problems.length > 0) };
}

/** The lane's latest run link (any outcome), falling back to the workflow page. */
export function latestRunLink(lane) {
  if (lane.latestRun?.url) {
    const c = lane.latestRun.conclusion ?? lane.latestRun.status ?? "unknown";
    return `[run ${lane.latestRun.id}](${lane.latestRun.url}) (${c})`;
  }
  return lane.workflowUrl ? `[${lane.workflow}](${lane.workflowUrl})` : lane.workflow;
}

/** One line per lane that went dark, for the log / an ::error annotation. */
export function darkMessage(lane, problems) {
  return (
    `${lane.lane} overlay (${lane.workflow}) went dark: ${problems.join("; ")}. ` +
    `Latest run: ${lane.latestRun?.url ?? lane.workflowUrl ?? lane.workflow}`
  );
}

/** The job-summary section. */
export function formatSummary(status, evaluation, now) {
  const out = [
    "### Integration overlay freshness",
    "",
    `Graded branch \`${status.branch}\`, HEAD \`${short(status.head)}\`. ` +
      `Limits: ${MAX_OVERLAY_AGE_DAYS} days old, ${pct(MAX_STALE_SHARE)} of the overlay's ` +
      `files stale. ${evaluation.gated ? "Gated" : "Not gated on this branch (warnings only)"}.`,
    "",
    "| Lane | Source sha | Age (days) | Commits behind | Changed files | Stale overlay files | Verdict | Latest run |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const { lane, problems } of evaluation.lanes) {
    const age = lane.present ? ageDays(lane.measuredAt, now) : null;
    const staleCell =
      lane.present && lane.overlayFiles > 0
        ? `${lane.staleOverlayFiles} / ${lane.overlayFiles} (${pct(lane.staleOverlayFiles / lane.overlayFiles)})`
        : "-";
    out.push(
      `| ${lane.lane} | ${lane.present && lane.sha ? `\`${short(lane.sha)}\`` : "-"} | ` +
        `${age === null ? "-" : age.toFixed(1)} | ${lane.present ? (lane.behindBy ?? "-") : "-"} | ` +
        `${lane.present ? (lane.changedFiles ?? "-") : "-"} | ${staleCell} | ` +
        `${problems.length === 0 ? "ok" : `**dark**: ${problems.join("; ")}`} | ` +
        `${latestRunLink(lane)} |`
    );
  }
  out.push("");
  return out.join("\n") + "\n";
}

export function parseArgs(argv) {
  const opts = {};
  const names = { "--status": "status", "--summary": "summary", "--now": "now" };
  for (let i = 0; i < argv.length; i++) {
    const name = names[argv[i]];
    if (!name || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    opts[name] = argv[++i];
  }
  if (!opts.status) throw new Error("--status is required");
  return opts;
}

function pct(share) {
  return `${(share * 100).toFixed(1)} %`;
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "unknown";
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`overlay-freshness: ${e.message}`);
    console.error("usage: overlay-freshness.mjs --status <json> [--summary <md>] [--now <iso>]");
    return 2;
  }
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  if (!existsSync(opts.status)) {
    // The fetch step crashed before writing anything: both lanes are unknown.
    const msg = `no ${opts.status}: the overlay fetch step failed before reporting.`;
    console.log(`::error title=Integration overlay::${msg}`);
    if (opts.summary)
      appendFileSync(opts.summary, `### Integration overlay freshness\n\n${msg}\n\n`);
    return 1;
  }
  const status = JSON.parse(readFileSync(opts.status, "utf8"));
  const evaluation = evaluateStatus(status, now);
  const summary = formatSummary(status, evaluation, now);
  process.stdout.write(summary);
  if (opts.summary) appendFileSync(opts.summary, summary);
  const level = evaluation.gated ? "error" : "warning";
  for (const { lane, problems } of evaluation.lanes) {
    if (problems.length === 0) continue;
    console.log(
      `::${level} title=Integration overlay (${lane.lane})::${darkMessage(lane, problems)}`
    );
  }
  return evaluation.failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
