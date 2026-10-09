import { describe, it, expect } from "vitest";
import {
  dispatchArgs,
  fetchLaneRuns,
  fmtAge,
  laneStatus,
  ownScheduleLive,
  planDispatch,
  renderTable,
  runCounts,
  runQueries,
} from "./scheduled-lanes-heartbeat.mjs";

const NOW = new Date("2026-10-09T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const daily = (over = {}) => ({
  file: "nightly.yml",
  cadence: "daily",
  cron: "17 3 * * *",
  dispatch: true,
  sources: [{ event: "schedule" }, { event: "workflow_dispatch", branch: "develop" }],
  ...over,
});

let nextId = 1;
const run = (event, head_branch, h, conclusion = "success") => ({
  id: nextId++,
  event,
  head_branch,
  created_at: hoursAgo(h),
  conclusion,
  status: conclusion ? "completed" : "in_progress",
});

describe("runCounts", () => {
  it("matches a source by event and, when given, head branch", () => {
    const lane = daily();
    expect(runCounts(lane, run("schedule", "main", 1))).toBe(true);
    expect(runCounts(lane, run("workflow_dispatch", "develop", 1))).toBe(true);
    expect(runCounts(lane, run("workflow_dispatch", "dev2/probe", 1))).toBe(false);
    expect(runCounts(lane, run("pull_request", "develop", 1))).toBe(false);
  });
});

describe("runQueries", () => {
  it("lists develop runs and scheduled runs as needed", () => {
    expect(runQueries("o/r", daily())).toEqual([
      "repos/o/r/actions/workflows/nightly.yml/runs?branch=develop&per_page=50",
      "repos/o/r/actions/workflows/nightly.yml/runs?event=schedule&per_page=20",
    ]);
    const dispatchOnly = daily({ sources: [{ event: "workflow_dispatch", branch: "develop" }] });
    expect(runQueries("o/r", dispatchOnly)).toHaveLength(1);
  });
});

describe("fetchLaneRuns", () => {
  it("merges, filters, de-duplicates and sorts newest first", () => {
    const shared = run("workflow_dispatch", "develop", 5);
    const pages = {
      branch: [run("push", "develop", 1), shared],
      schedule: [run("schedule", "main", 3), shared],
    };
    const api = (q) => ({ workflow_runs: q.includes("branch=") ? pages.branch : pages.schedule });
    const { registered, runs } = fetchLaneRuns("o/r", daily(), api);
    expect(registered).toBe(true);
    expect(runs.map((r) => r.event)).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("reports an unregistered workflow (404) without throwing", () => {
    expect(fetchLaneRuns("o/r", daily(), () => null)).toEqual({ registered: false, runs: [] });
  });
});

describe("laneStatus", () => {
  it("is fresh with a recent success", () => {
    const s = laneStatus(daily(), [run("schedule", "main", 10)], NOW);
    expect(s.heartbeatStale).toBe(false);
    expect(s.catchUpDue).toBe(false);
  });

  it("is stale past 36 h for a daily lane, measured from the newest SUCCESS", () => {
    const runs = [run("schedule", "main", 2, "failure"), run("schedule", "main", 40)];
    const s = laneStatus(daily(), runs, NOW);
    expect(s.heartbeatStale).toBe(true);
    // A recent red run still counts as fresh for catch-up: no re-dispatch storm.
    expect(s.catchUpDue).toBe(false);
  });

  it("is stale and due when the lane never ran", () => {
    const s = laneStatus(daily(), [], NOW);
    expect(s).toMatchObject({ heartbeatStale: true, catchUpDue: true, newest: null });
  });

  it("uses the weekly windows for a weekly lane", () => {
    const weekly = daily({ cadence: "weekly" });
    expect(laneStatus(weekly, [run("schedule", "main", 6 * 24)], NOW).heartbeatStale).toBe(false);
    expect(laneStatus(weekly, [run("schedule", "main", 9 * 24)], NOW).heartbeatStale).toBe(true);
    expect(laneStatus(weekly, [run("schedule", "main", 7 * 24 + 5)], NOW).catchUpDue).toBe(true);
  });

  it("counts an in-progress run as fresh for catch-up", () => {
    const s = laneStatus(daily(), [run("workflow_dispatch", "develop", 0.1, null)], NOW);
    expect(s.catchUpDue).toBe(false);
    expect(s.heartbeatStale).toBe(true);
  });
});

describe("ownScheduleLive", () => {
  const onMain = "on:\n  schedule:\n    - cron: '1 1 * * *'\njobs: {}\n";
  it("is true when main has the file with a schedule", () => {
    expect(ownScheduleLive(daily(), () => onMain)).toBe(true);
  });
  it("is false when main lacks the file or its schedule", () => {
    expect(ownScheduleLive(daily(), () => null)).toBe(false);
    expect(ownScheduleLive(daily(), () => "on:\n  push:\njobs: {}\n")).toBe(false);
  });
  it("is false when the lane opts out (only a dispatched run counts)", () => {
    expect(ownScheduleLive(daily({ ownSchedule: false }), () => onMain)).toBe(false);
  });
});

describe("planDispatch", () => {
  const row = (lane, h, ownLive = false) => ({
    lane,
    registered: true,
    ownLive,
    status: laneStatus(lane, h === null ? [] : [run("schedule", "main", h)], NOW),
  });

  it("dispatches nothing without a mode", () => {
    expect(planDispatch({ mode: null }, [row(daily(), null)])).toEqual([]);
  });

  it("stale mode dispatches only lanes past the catch-up window", () => {
    const a = daily({ file: "a.yml" });
    const b = daily({ file: "b.yml" });
    const c = daily({ file: "c.yml" });
    const plan = planDispatch({ mode: "stale" }, [row(a, 30), row(b, 5), row(c, null)]);
    expect(plan.map((p) => p.lane.file)).toEqual(["a.yml", "c.yml"]);
    expect(plan[1].reason).toBe("catch-up: no develop run yet");
  });

  it("cron mode dispatches the cron's lanes regardless of age", () => {
    const a = daily({ file: "a.yml" });
    const b = daily({ file: "b.yml", cron: "0 4 * * *" });
    const plan = planDispatch({ mode: "cron", cron: "17 3 * * *" }, [row(a, 1), row(b, 50)]);
    expect(plan.map((p) => p.lane.file)).toEqual(["a.yml"]);
  });

  it("never dispatches a watched-only lane or one whose own schedule is live", () => {
    const watched = daily({ file: "w.yml", dispatch: false, cron: null });
    const live = daily({ file: "l.yml" });
    expect(planDispatch({ mode: "stale" }, [row(watched, null), row(live, null, true)])).toEqual(
      []
    );
    expect(planDispatch({ mode: "cron", cron: "17 3 * * *" }, [row(live, 50, true)])).toEqual([]);
  });
});

describe("dispatchArgs", () => {
  it("dispatches on develop with the lane's inputs", () => {
    expect(dispatchArgs("o/r", daily({ inputs: { branch: "develop" } }))).toEqual([
      "workflow",
      "run",
      "nightly.yml",
      "--repo",
      "o/r",
      "--ref",
      "develop",
      "-f",
      "branch=develop",
    ]);
  });
});

describe("fmtAge / renderTable", () => {
  it("formats hours and days", () => {
    expect(fmtAge(null)).toBe("never");
    expect(fmtAge(5)).toBe("5.0h");
    expect(fmtAge(72)).toBe("3.0d");
  });

  it("renders a row per lane with the heartbeat verdict", () => {
    const lane = daily();
    const table = renderTable(
      [
        { lane, registered: true, ownLive: false, status: laneStatus(lane, [], NOW) },
        {
          lane: daily({ file: "w.yml", dispatch: false, cron: null }),
          registered: false,
          ownLive: false,
          status: laneStatus(lane, [], NOW),
        },
      ],
      new Set(["nightly.yml"])
    );
    expect(table).toContain(
      "| `nightly.yml` | daily | none | never | STALE (> 36.0h) — dispatched now |"
    );
    expect(table).toContain("none (workflow not registered)");
    expect(table).toContain("own schedule (main)");
  });
});
