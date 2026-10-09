// The scheduled CI lanes that grade `develop`, and helpers for reading a
// workflow's `on:` block (#4277).
//
// Why this exists: GitHub fires `schedule:` and `workflow_run:` triggers only
// from the workflow file on the DEFAULT branch (`main`). `main` trails
// `develop` between releases, so a lane whose workflow file exists only on
// `develop` never runs on its cron. This registry is the single list of those
// lanes. Three tools read it:
//
//   * .github/workflows/scheduled-dispatch.yml — the dispatcher. Once it is on
//     `main`, each cron below dispatches its lanes with
//     `gh workflow run <file> --ref develop`. Before that, every push to
//     `develop` dispatches the lanes that have gone stale (catch-up).
//   * scripts/internal/scheduled-lanes-heartbeat.mjs — fails when a lane has
//     no successful develop run within its heartbeat window.
//   * scripts/internal/check-scheduled-lane-drift.mjs — fails when a workflow
//     with `schedule:`/`workflow_run:` is missing from this registry, and
//     reports which of them are missing from (or differ on) `main`.
//
// A NEW SCHEDULED LANE must be added here, or the drift check fails.
//
// Lane fields:
//   file       workflow file name under .github/workflows/.
//   cadence    "daily" | "weekly": sets the heartbeat and catch-up windows.
//   cron       the scheduled-dispatch.yml cron that dispatches it, or null when
//              the dispatcher never dispatches it (`dispatch: false`).
//   dispatch   false when the lane is only watched (its own schedule already
//              fires from `main`), true when the dispatcher may start it.
//   inputs     workflow_dispatch inputs passed with `-f key=value`.
//   sources    which runs count as "this lane ran on develop":
//              { event, branch? }. `branch: "develop"` matches runs whose head
//              branch is develop; a `schedule` source matches any scheduled
//              run, because scheduled runs are recorded on `main` even when
//              they check out develop.
//   ownSchedule
//              true (default) when the lane's own `schedule:` grades develop,
//              so once the file is on `main` its cron takes over and the
//              dispatcher stops dispatching it. false when only a dispatched
//              run produces what develop needs (integration-fixtures: only a
//              dispatched run is instrumented for coverage).

/** Hours a lane may go without a successful develop run before the heartbeat fails. */
export const HEARTBEAT_HOURS = { daily: 36, weekly: 8 * 24 };

/**
 * Hours after which a develop push dispatches a lane whose newest run (any
 * outcome) is older. Longer than the cadence so a late GitHub cron (they can
 * run an hour late) is not doubled by a push that lands first.
 */
export const CATCH_UP_HOURS = { daily: 28, weekly: 7 * 24 + 4 };

const DEVELOP_PUSH = { event: "push", branch: "develop" };
const DEVELOP_DISPATCH = { event: "workflow_dispatch", branch: "develop" };
const SCHEDULE = { event: "schedule" };

/** The lanes that grade develop on a schedule. */
export const LANES = [
  {
    file: "wsl-live.yml",
    cadence: "daily",
    cron: "41 3 * * *",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH],
  },
  {
    // Only a dispatched run is instrumented and uploads the
    // `integration-coverage` lcov that coverage.yml overlays (TOOL-005), so
    // main's own (uninstrumented) schedule does not count.
    file: "integration-fixtures.yml",
    cadence: "daily",
    cron: "41 3 * * *",
    dispatch: true,
    ownSchedule: false,
    sources: [DEVELOP_DISPATCH],
  },
  {
    file: "cargo-update-lockfile.yml",
    cadence: "daily",
    cron: "0 4 * * *",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH, DEVELOP_PUSH],
  },
  {
    file: "windows-ssh-host.yml",
    cadence: "daily",
    cron: "0 4 * * *",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH],
  },
  {
    // Every develop push runs it too, so it is rarely stale; the cron catches
    // an advisory published on a day with no merges.
    file: "security-audit.yml",
    cadence: "daily",
    cron: "0 4 * * *",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH, DEVELOP_PUSH],
  },
  {
    // Main-resident: its own schedule fires from main and checks out develop.
    // Watched by the heartbeat only.
    file: "system-integration.yml",
    cadence: "daily",
    cron: null,
    dispatch: false,
    sources: [SCHEDULE, DEVELOP_DISPATCH],
  },
  {
    file: "plugin-sandbox-nightly.yml",
    cadence: "daily",
    cron: "35 5 * * *",
    dispatch: true,
    inputs: { branch: "develop" },
    sources: [SCHEDULE, DEVELOP_DISPATCH],
  },
  {
    // Has no schedule of its own (#4277): the dispatcher is its only cron.
    file: "coverage.yml",
    cadence: "daily",
    cron: "23 7 * * *",
    dispatch: true,
    sources: [DEVELOP_DISPATCH, DEVELOP_PUSH],
  },
  {
    // The upstream-drift job runs only on schedule/dispatch; the path-filtered
    // push runs do not exercise it, so they do not count.
    file: "vendored-forks.yml",
    cadence: "weekly",
    cron: "17 6 * * 1",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH],
  },
  {
    file: "branch-protection.yml",
    cadence: "weekly",
    cron: "17 6 * * 1",
    dispatch: true,
    sources: [SCHEDULE, DEVELOP_DISPATCH, DEVELOP_PUSH],
  },
];

/** The dispatcher workflow itself: scheduled, but not a lane. */
export const DISPATCHER_FILE = "scheduled-dispatch.yml";

/** Triggers GitHub reads only from the default branch's copy of a workflow. */
export const DEFAULT_BRANCH_ONLY_TRIGGERS = ["schedule", "workflow_run"];

/**
 * The raw lines of a workflow's top-level `on:` block (the key line included),
 * or null when there is none. Accepts `on:`, `"on":` and `'on':`.
 *
 * @param {string} text workflow YAML
 * @returns {string[] | null}
 */
export function extractOnBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(on|"on"|'on')\s*:/.test(l));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // The block ends at the next top-level key (column 0, not a comment).
    if (/^[^\s#]/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Strip a trailing ` # comment` that is outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The `on:` block with comments, blank lines and trailing whitespace removed,
 * so two copies that differ only in commentary compare equal.
 *
 * @param {string} text workflow YAML
 * @returns {string | null}
 */
export function normalizedOnBlock(text) {
  const block = extractOnBlock(text);
  if (!block) return null;
  return block
    .map((l) => stripComment(l).trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/**
 * The trigger names in a workflow's `on:` block (`push`, `schedule`, ...).
 * Handles the mapping form and the inline `on: [a, b]` / `on: a` forms.
 *
 * @param {string} text workflow YAML
 * @returns {string[]}
 */
export function triggersOf(text) {
  const block = extractOnBlock(text);
  if (!block) return [];
  const inline = stripComment(block[0])
    .replace(/^[^:]*:/, "")
    .trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const body = block.slice(1).filter((l) => stripComment(l).trim() !== "");
  if (body.length === 0) return [];
  const indent = body[0].match(/^\s*/)[0].length;
  const names = [];
  for (const line of body) {
    const lead = line.match(/^\s*/)[0].length;
    if (lead !== indent) continue;
    const m = line.trim().match(/^["']?([A-Za-z_]+)["']?\s*:/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * The cron expressions in a workflow's `on.schedule`.
 *
 * @param {string} text workflow YAML
 * @returns {string[]}
 */
export function cronsOf(text) {
  const block = extractOnBlock(text) ?? [];
  const crons = [];
  for (const line of block) {
    const m = stripComment(line).match(/cron:\s*["']([^"']+)["']/);
    if (m) crons.push(m[1].trim());
  }
  return crons;
}

/**
 * True when the workflow has a trigger GitHub reads only from the default
 * branch (`schedule:` or `workflow_run:`).
 *
 * @param {string} text workflow YAML
 */
export function hasDefaultBranchOnlyTrigger(text) {
  return triggersOf(text).some((t) => DEFAULT_BRANCH_ONLY_TRIGGERS.includes(t));
}
