#!/usr/bin/env node
// Scheduled-lane heartbeat and dispatcher (#4277, audit TOOL2-001 / CI2-004).
//
// For each lane in scripts/internal/scheduled-lanes.mjs it reads the lane's
// recent runs from the Actions API and keeps the ones that count as "ran on
// develop" (the lane's `sources`). Then:
//
//   --check            fails (exit 1) when a lane's newest SUCCESSFUL develop run
//                      is older than its heartbeat window (36 h daily, 8 days
//                      weekly), or when it has none. This is the alarm that
//                      catches a dark lane, whatever made it dark.
//   --dispatch-stale   dispatches (`gh workflow run <file> --ref develop`) each
//                      dispatchable lane whose newest run of ANY outcome is older
//                      than its catch-up window (28 h / 7 d + 4 h). Run on every
//                      develop push, it keeps lanes firing before the dispatcher
//                      is on main. A failing lane is not re-dispatched on every
//                      push: any recent run, red or green, counts as fresh.
//   --dispatch-cron C  dispatches the lanes assigned to cron C (the dispatcher's
//                      `github.event.schedule`), regardless of age.
//
// When a lane's newest develop run FAILED, the report says why (#5159): a
// failure in one of the lane's `gateSteps` (e.g. coverage.yml's "Coverage
// ratchet") is a gate verdict — "ratchet drop": the lane works, the code
// regressed — while a failure anywhere else is "lane broken" at the named
// job/step. Both still fail the heartbeat; they need different fixes.
//
// Either dispatch mode skips a lane whose own `schedule:` is live, meaning
// its workflow file is on main with a schedule trigger and `ownSchedule` is not
// false. Every registered lane is `ownSchedule: false` (#4449, #4847), so the
// dispatcher always starts develop's run with develop's YAML.
//
// Usage:
//   node scripts/internal/scheduled-lanes-heartbeat.mjs [--check]
//        [--dispatch-stale | --dispatch-cron "<cron>"] [--dry-run]
//        [--repo owner/name] [--main-ref origin/main] [--now <iso>] [--summary <md>]
//
// Needs `gh` authenticated (GH_TOKEN in CI; dispatching needs actions: write)
// and the main ref locally (`git fetch origin main`).
// Exit codes: 0 ok, 1 a stale heartbeat or a failed dispatch, 2 usage/API error.

import { execFileSync } from "child_process";
import { appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./is-main-module.mjs";
import { gitMainReader } from "./check-scheduled-lane-drift.mjs";
import { CATCH_UP_HOURS, HEARTBEAT_HOURS, LANES, triggersOf } from "./scheduled-lanes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_REPO = "armaxri/termiHub";
const HOUR_MS = 3600 * 1000;

/**
 * True when the run counts as the lane running on develop.
 *
 * @param {{ sources: { event: string, branch?: string }[] }} lane
 * @param {{ event: string, head_branch: string }} run
 */
export function runCounts(lane, run) {
  return lane.sources.some(
    (s) => s.event === run.event && (s.branch === undefined || s.branch === run.head_branch)
  );
}

/**
 * The API paths that cover a lane's sources: one branch=develop listing and/or
 * one event=schedule listing.
 *
 * @param {string} repo owner/name
 * @param {{ file: string, sources: { event: string, branch?: string }[] }} lane
 * @returns {string[]}
 */
export function runQueries(repo, lane) {
  const base = `repos/${repo}/actions/workflows/${lane.file}/runs`;
  const queries = [];
  if (lane.sources.some((s) => s.branch === "develop")) {
    queries.push(`${base}?branch=develop&per_page=50`);
  }
  if (lane.sources.some((s) => s.event === "schedule")) {
    queries.push(`${base}?event=schedule&per_page=20`);
  }
  return queries;
}

/**
 * Fetch the counted runs of a lane, newest first.
 *
 * @param {string} repo
 * @param {object} lane
 * @param {(apiPath: string) => any | null} api returns parsed JSON, or null on 404
 * @returns {{ registered: boolean, runs: object[] }}
 */
export function fetchLaneRuns(repo, lane, api) {
  const seen = new Map();
  for (const q of runQueries(repo, lane)) {
    const body = api(q);
    // 404: GitHub does not know the workflow yet. It is registered by its
    // first run on any branch, or by reaching the default branch.
    if (body === null) return { registered: false, runs: [] };
    for (const run of body.workflow_runs ?? []) {
      if (runCounts(lane, run)) seen.set(run.id, run);
    }
  }
  const runs = [...seen.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { registered: true, runs };
}

/**
 * Age and freshness of one lane at `now`.
 *
 * @param {object} lane
 * @param {object[]} runs counted runs, newest first
 * @param {Date} now
 */
export function laneStatus(lane, runs, now) {
  const age = (run) => (run ? (now.getTime() - Date.parse(run.created_at)) / HOUR_MS : null);
  const newest = runs[0] ?? null;
  const newestSuccess = runs.find((r) => r.conclusion === "success") ?? null;
  const successAge = age(newestSuccess);
  const newestAge = age(newest);
  return {
    newest,
    newestAge,
    newestSuccess,
    successAge,
    heartbeatStale: successAge === null || successAge > HEARTBEAT_HOURS[lane.cadence],
    catchUpDue: newestAge === null || newestAge > CATCH_UP_HOURS[lane.cadence],
  };
}

/**
 * Why a failed run failed: a gate verdict (every failed step is one of the
 * lane's `gateSteps`) or a broken lane (anything else failed).
 *
 * @param {{ gateSteps?: Record<string, string> }} lane
 * @param {{ name: string, conclusion: string | null,
 *   steps?: { name: string, conclusion: string | null }[] }[]} jobs the run's jobs
 * @returns {{ kind: "gate" | "broken", label: string, detail: string }}
 */
export function classifyFailure(lane, jobs) {
  const gates = lane.gateSteps ?? {};
  const failed = [];
  for (const job of jobs ?? []) {
    if (job.conclusion !== "failure") continue;
    const step = (job.steps ?? []).find((st) => st.conclusion === "failure");
    failed.push({ job: job.name, step: step?.name ?? null });
  }
  const where = (f) => `${f.job} / ${f.step ?? "(no failed step)"}`;
  if (failed.length === 0) {
    return { kind: "broken", label: "lane broken", detail: "no failed job recorded" };
  }
  const broken = failed.find((f) => !(f.step && gates[f.step]));
  if (broken) return { kind: "broken", label: "lane broken", detail: where(broken) };
  return {
    kind: "gate",
    label: [...new Set(failed.map((f) => gates[f.step]))].join(", "),
    detail: failed.map(where).join("; "),
  };
}

/** One phrase for a classified failure, e.g. `ratchet drop (Job / Step)`. */
export function describeFailure(failure) {
  return failure.kind === "gate"
    ? `${failure.label} (${failure.detail})`
    : `${failure.label} at ${failure.detail}`;
}

/**
 * True when the lane's own schedule fires from main (so the dispatcher must
 * not double it).
 *
 * @param {object} lane
 * @param {(name: string) => string | null} readMain
 */
export function ownScheduleLive(lane, readMain) {
  if (lane.ownSchedule === false) return false;
  const text = readMain(lane.file);
  return text !== null && triggersOf(text).includes("schedule");
}

/**
 * Decide which lanes to dispatch.
 *
 * @param {{ mode: "stale" | "cron" | null, cron?: string }} how
 * @param {{ lane: object, registered: boolean, status: ReturnType<typeof laneStatus>, ownLive: boolean }[]} rows
 * @returns {{ lane: object, reason: string }[]} lanes to dispatch
 */
export function planDispatch(how, rows) {
  if (!how.mode) return [];
  const plan = [];
  for (const { lane, status, ownLive } of rows) {
    if (!lane.dispatch || ownLive) continue;
    if (how.mode === "cron" && lane.cron === how.cron) {
      plan.push({ lane, reason: `cron ${how.cron}` });
    } else if (how.mode === "stale" && status.catchUpDue) {
      const since =
        status.newestAge === null
          ? "no develop run yet"
          : `newest run ${fmtAge(status.newestAge)} ago`;
      plan.push({ lane, reason: `catch-up: ${since}` });
    }
  }
  return plan;
}

/** The `gh` argv for dispatching a lane on develop. */
export function dispatchArgs(repo, lane) {
  const args = ["workflow", "run", lane.file, "--repo", repo, "--ref", "develop"];
  for (const [k, v] of Object.entries(lane.inputs ?? {})) args.push("-f", `${k}=${v}`);
  return args;
}

export function fmtAge(hours) {
  if (hours === null) return "never";
  return hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

/**
 * The report table.
 *
 * @param {{ lane: object, registered: boolean, status: object, ownLive: boolean,
 *   failure?: ReturnType<typeof classifyFailure> | null }[]} rows
 * @param {Set<string>} dispatched files dispatched in this run
 */
export function renderTable(rows, dispatched) {
  const out = [
    "| Lane | Cadence | Newest develop run | Newest success | Heartbeat | Cron owner |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const { lane, registered, status, ownLive, failure } of rows) {
    const cause = failure ? ` — ${describeFailure(failure)}` : "";
    const newest = status.newest
      ? `${fmtAge(status.newestAge)} ago (${status.newest.conclusion ?? status.newest.status}, ${status.newest.event})${cause}`
      : registered
        ? "none"
        : "none (workflow not registered)";
    const success = status.newestSuccess ? `${fmtAge(status.successAge)} ago` : "never";
    const limit = HEARTBEAT_HOURS[lane.cadence];
    const beat = status.heartbeatStale ? `STALE (> ${fmtAge(limit)})` : "ok";
    const owner = !lane.dispatch
      ? "own schedule (main)"
      : ownLive
        ? "own schedule (main)"
        : `scheduled-dispatch \`${lane.cron}\``;
    const note = dispatched.has(lane.file) ? " — dispatched now" : "";
    out.push(
      `| \`${lane.file}\` | ${lane.cadence} | ${newest} | ${success} | ${beat}${note} | ${owner} |`
    );
  }
  return out.join("\n");
}

/** `gh api` returning parsed JSON, or null on HTTP 404. */
export function ghApi(apiPath) {
  try {
    const out = execFileSync("gh", ["api", apiPath], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    if (/HTTP 404/.test(String(e.stderr ?? ""))) return null;
    throw new Error(`gh api ${apiPath} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

function parseArgs(argv) {
  const a = {
    check: false,
    mode: null,
    cron: null,
    dryRun: false,
    repo: DEFAULT_REPO,
    mainRef: "origin/main",
    now: null,
    summary: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "--check") a.check = true;
    else if (x === "--dispatch-stale") a.mode = "stale";
    else if (x === "--dispatch-cron") {
      a.mode = "cron";
      a.cron = next();
    } else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--repo") a.repo = next();
    else if (x === "--main-ref") a.mainRef = next();
    else if (x === "--now") a.now = next();
    else if (x === "--summary") a.summary = next();
    else throw new Error(`unknown argument: ${x}`);
  }
  if (!a.check && !a.mode) a.check = true;
  if (a.mode === "cron" && !LANES.some((l) => l.cron === a.cron)) {
    throw new Error(`no lane uses the cron "${a.cron}"`);
  }
  return a;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    return 2;
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a date: ${args.now}`);
    return 2;
  }
  const gha = Boolean(process.env.GITHUB_ACTIONS);
  const readMain = gitMainReader(args.mainRef);

  let rows;
  try {
    rows = LANES.map((lane) => {
      const { registered, runs } = fetchLaneRuns(args.repo, lane, ghApi);
      return {
        lane,
        registered,
        status: laneStatus(lane, runs, now),
        ownLive: ownScheduleLive(lane, readMain),
        failure: null,
      };
    });
  } catch (e) {
    console.error(String(e.message));
    return 2;
  }
  for (const row of rows) {
    if (row.status.newest?.conclusion !== "failure") continue;
    try {
      const body = ghApi(
        `repos/${args.repo}/actions/runs/${row.status.newest.id}/jobs?per_page=100`
      );
      row.failure = classifyFailure(row.lane, body?.jobs ?? []);
    } catch (e) {
      // Advisory detail only: the heartbeat verdict does not depend on it.
      console.error(`could not read the jobs of ${row.lane.file}'s newest run: ${e.message}`);
    }
  }

  let failed = false;
  const dispatched = new Set();
  const log = [];
  for (const { lane, reason } of planDispatch({ mode: args.mode, cron: args.cron }, rows)) {
    const row = rows.find((r) => r.lane === lane);
    const argv = dispatchArgs(args.repo, lane);
    if (!row.registered) {
      const msg =
        `${lane.file}: cannot dispatch (${reason}) — GitHub has not registered the ` +
        "workflow yet. It registers on its first run (its develop push trigger) or " +
        "when it reaches main.";
      log.push(`- ${msg}`);
      if (gha) console.log(`::warning::${msg}`);
      continue;
    }
    if (args.dryRun) {
      log.push(`- would run: gh ${argv.join(" ")} (${reason})`);
      continue;
    }
    try {
      execFileSync("gh", argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      dispatched.add(lane.file);
      log.push(`- dispatched ${lane.file} on develop (${reason})`);
    } catch (e) {
      failed = true;
      const msg = `${lane.file}: dispatch failed: ${String(e.stderr ?? e.message).trim()}`;
      log.push(`- ${msg}`);
      if (gha) console.log(`::error::${msg}`);
    }
  }

  const out = [
    `## Scheduled-lane heartbeat (${now.toISOString()})`,
    "",
    renderTable(rows, dispatched),
  ];
  if (log.length) out.push("", ...log);
  const stale = rows.filter((r) => r.status.heartbeatStale);
  if (args.check && stale.length) {
    out.push(
      "",
      `${stale.length} lane(s) have no successful develop run inside their heartbeat window: ` +
        stale
          .map((r) => (r.failure ? `${r.lane.file} (${describeFailure(r.failure)})` : r.lane.file))
          .join(", ") +
        ". Open the lane's runs, fix the failure or the trigger, and re-dispatch it. A gate " +
        "verdict (e.g. ratchet drop) means the lane works and the code regressed; " +
        '"lane broken" means the lane itself failed.'
    );
    if (gha) {
      for (const r of stale) {
        const title = r.failure ? `${r.lane.file}: ${r.failure.label}` : `${r.lane.file}: stale`;
        const cause = r.failure ? ` Newest run: ${describeFailure(r.failure)}.` : "";
        console.log(
          `::error file=.github/workflows/${r.lane.file},title=${title}::No successful develop ` +
            `run in ${fmtAge(HEARTBEAT_HOURS[r.lane.cadence])} (newest success: ` +
            `${r.status.newestSuccess ? fmtAge(r.status.successAge) + " ago" : "never"}).${cause}`
        );
      }
    }
    failed = true;
  }
  console.log(out.join("\n"));
  if (args.summary) appendFileSync(args.summary, out.join("\n") + "\n");
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
