import { describe, it, expect } from "vitest";
import {
  describeDrift,
  driftFindings,
  loadWorkflows,
  registryProblems,
} from "./check-scheduled-lane-drift.mjs";
import { DISPATCHER_FILE } from "./scheduled-lanes.mjs";

const lane = (over = {}) => ({
  file: "nightly.yml",
  cadence: "daily",
  cron: "17 3 * * *",
  dispatch: true,
  sources: [{ event: "schedule" }],
  ...over,
});

const NIGHTLY = "on:\n  schedule:\n    - cron: '17 3 * * *'\n  workflow_dispatch:\njobs: {}\n";
const DISPATCHER = 'on:\n  schedule:\n    - cron: "17 3 * * *"\n  push:\njobs: {}\n';
const PLAIN = "on:\n  push:\njobs: {}\n";

function tree(over = {}) {
  return { "nightly.yml": NIGHTLY, [DISPATCHER_FILE]: DISPATCHER, "ci.yml": PLAIN, ...over };
}

describe("registryProblems", () => {
  it("accepts a consistent registry", () => {
    expect(registryProblems(tree(), [lane()])).toEqual([]);
  });

  it("flags a scheduled workflow that is not a lane", () => {
    const problems = registryProblems(tree({ "new-nightly.yml": NIGHTLY }), [lane()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/new-nightly\.yml has a schedule:\/workflow_run: trigger/);
  });

  it("flags a workflow_run workflow that is not a lane", () => {
    const wr = "on:\n  workflow_run:\n    workflows: [CI]\njobs: {}\n";
    expect(registryProblems(tree({ "after-ci.yml": wr }), [lane()])[0]).toMatch(/after-ci\.yml/);
  });

  it("flags a lane whose file is missing", () => {
    const problems = registryProblems(tree(), [lane(), lane({ file: "gone.yml" })]);
    expect(problems.some((p) => /gone\.yml .* does not exist/.test(p))).toBe(true);
  });

  it("flags a dispatched lane without workflow_dispatch", () => {
    const noDispatch = "on:\n  schedule:\n    - cron: '17 3 * * *'\njobs: {}\n";
    const problems = registryProblems(tree({ "nightly.yml": noDispatch }), [lane()]);
    expect(problems.some((p) => /no workflow_dispatch trigger/.test(p))).toBe(true);
  });

  it("flags an input the lane passes but the workflow does not declare", () => {
    const problems = registryProblems(tree(), [lane({ inputs: { branch: "develop" } })]);
    expect(problems.some((p) => /input "branch"/.test(p))).toBe(true);

    const withInput = NIGHTLY.replace(
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n    inputs:\n      branch:\n        type: string\n"
    );
    expect(
      registryProblems(tree({ "nightly.yml": withInput }), [
        lane({ inputs: { branch: "develop" } }),
      ])
    ).toEqual([]);
  });

  it("flags cron/dispatch mismatches", () => {
    expect(registryProblems(tree(), [lane({ cron: null })]).join("\n")).toMatch(/has no cron/);
    const watched = lane({ dispatch: false, cron: "17 3 * * *" });
    expect(registryProblems(tree(), [watched]).join("\n")).toMatch(/not dispatched but has a cron/);
  });

  it("flags dispatcher crons that do not match the registry", () => {
    const problems = registryProblems(tree(), [lane({ cron: "0 4 * * *" })]);
    expect(problems.some((p) => /lacks the cron "0 4 \* \* \*"/.test(p))).toBe(true);
    expect(problems.some((p) => /cron "17 3 \* \* \*" that no lane uses/.test(p))).toBe(true);
  });

  it("flags a missing dispatcher", () => {
    const t = tree();
    delete t[DISPATCHER_FILE];
    expect(registryProblems(t, [lane()])).toContain(`${DISPATCHER_FILE} is missing.`);
  });
});

describe("the real workflows", () => {
  it("register every scheduled lane (a new schedule:/workflow_run: must be added)", () => {
    expect(registryProblems(loadWorkflows())).toEqual([]);
  });
});

describe("driftFindings", () => {
  it("classifies missing, differing and identical copies, dispatcher first", () => {
    const main = {
      "nightly.yml": NIGHTLY.replace("'17 3 * * *'", "'17 3 * * *' # same, new comment"),
      "other.yml": NIGHTLY.replace("17 3", "0 4"),
    };
    const findings = driftFindings(tree({ "other.yml": NIGHTLY }), (name) => main[name] ?? null);
    expect(findings).toEqual([
      { file: DISPATCHER_FILE, status: "missing" },
      { file: "nightly.yml", status: "ok" },
      { file: "other.yml", status: "on-differs" },
    ]);
  });

  it("flags job-body drift for a lane whose own schedule grades develop (#4449)", () => {
    const mainCopy = NIGHTLY.replace("jobs: {}", "jobs:\n  old: {}");
    const t = tree();
    const read = (name) => (name === "nightly.yml" ? mainCopy : null);
    const own = driftFindings(t, read, [lane()]);
    expect(own.find((f) => f.file === "nightly.yml").status).toBe("jobs-differ");

    // Dispatched instead (ownSchedule: false): main's own run grades main.
    const dispatched = driftFindings(t, read, [lane({ ownSchedule: false })]);
    expect(dispatched.find((f) => f.file === "nightly.yml").status).toBe("ok");

    // Comment-only differences are not drift.
    const commented = NIGHTLY.replace("jobs: {}", "# note\njobs: {} # same");
    const quiet = driftFindings(t, (n) => (n === "nightly.yml" ? commented : null), [lane()]);
    expect(quiet.find((f) => f.file === "nightly.yml").status).toBe("ok");
  });

  it("reports a lane whose schedule main still fires after develop dropped it", () => {
    const t = tree({ "nightly.yml": "on:\n  workflow_dispatch:\njobs: {}\n" });
    const findings = driftFindings(t, (n) => (n === "nightly.yml" ? NIGHTLY : null), [lane()]);
    expect(findings.find((f) => f.file === "nightly.yml").status).toBe("on-differs");
    // An unregistered workflow without a schedule on develop stays out.
    const other = driftFindings(tree(), (n) => (n === "ci.yml" ? NIGHTLY : null), [lane()]);
    expect(other.map((f) => f.file)).not.toContain("ci.yml");
  });

  it("ignores workflows without schedule/workflow_run", () => {
    const findings = driftFindings(tree(), () => null);
    expect(findings.map((f) => f.file)).not.toContain("ci.yml");
  });
});

describe("describeDrift", () => {
  it("says a dark lane is covered only once the dispatcher is on main", () => {
    const dark = [
      { file: DISPATCHER_FILE, status: "missing" },
      { file: "nightly.yml", status: "missing" },
    ];
    const msgs = describeDrift(dark, [lane()]);
    expect(msgs[0].message).toMatch(/is not on main, so none of its crons fire/);
    expect(msgs[1].message).toMatch(/Only develop-push catch-up dispatches it/);

    const covered = describeDrift(
      [
        { file: DISPATCHER_FILE, status: "ok" },
        { file: "nightly.yml", status: "missing" },
      ],
      [lane()]
    );
    expect(covered[0].level).toBe("notice");
    expect(covered[1].message).toMatch(/dispatches it on develop meanwhile/);
  });

  it("explains job-body drift", () => {
    const msgs = describeDrift(
      [
        { file: DISPATCHER_FILE, status: "ok" },
        { file: "nightly.yml", status: "jobs-differ" },
      ],
      [lane()]
    );
    expect(msgs[1].level).toBe("warning");
    expect(msgs[1].message).toMatch(/runs MAIN's job definitions against develop/);
    expect(msgs[1].message).toMatch(/ownSchedule: false/);
  });

  it("does not claim coverage for a watched-only lane", () => {
    const msgs = describeDrift(
      [
        { file: DISPATCHER_FILE, status: "ok" },
        { file: "nightly.yml", status: "on-differs" },
      ],
      [lane({ dispatch: false, cron: null })]
    );
    expect(msgs[1].message).toBe("nightly.yml differs on main: main fires the stale trigger set.");
  });
});
