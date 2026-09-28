import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CANDIDATE_WORKFLOW,
  COVERAGE_ARTIFACT,
  COVERAGE_WORKFLOW,
  GAP_TITLE,
  UNIT_LCOV,
  computeCoverage,
  downloadArtifactForSha,
  formatMarkdown,
  parseArgs,
  runSummary,
  runsForSha,
} from "./release-coverage-summary.mjs";

const SHA = "a".repeat(40);
const ROOT = "/home/runner/work/termiHub/termiHub";

// Unit report: a frontend file (fully covered) and a core file with 2 of 4
// lines hit. Absolute cargo-llvm-cov paths, relative vitest paths.
const UNIT = [
  "SF:src/App.tsx",
  "DA:1,1",
  "DA:2,1",
  "LF:2",
  "LH:2",
  "end_of_record",
  `SF:${ROOT}/core/src/backends/ssh.rs`,
  "FN:1,connect",
  "FNDA:1,connect",
  "FN:3,reconnect",
  "FNDA:0,reconnect",
  "FNF:2",
  "FNH:1",
  "DA:1,3",
  "DA:2,1",
  "DA:3,0",
  "DA:4,0",
  "LF:4",
  "LH:2",
  "end_of_record",
].join("\n");

// Integration report (same commit): covers ssh.rs line 3 and `reconnect`,
// plus a file the unit report does not list (must be ignored).
const INTEGRATION = [
  `SF:${ROOT}/core/src/backends/ssh.rs`,
  "FN:3,reconnect",
  "FNDA:2,reconnect",
  "DA:3,2",
  "DA:4,0",
  "LF:2",
  "LH:1",
  "end_of_record",
  `SF:${ROOT}/core/tests/ssh.rs`,
  "DA:1,1",
  "LF:1",
  "LH:1",
  "end_of_record",
].join("\n");

const run = (id, over = {}) => ({
  id,
  event: "push",
  status: "completed",
  conclusion: "success",
  head_sha: SHA,
  created_at: `2026-09-${String(id).padStart(2, "0")}T10:00:00Z`,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...over,
});

describe("runsForSha", () => {
  it("keeps completed success/failure runs of the wanted events on the sha, newest first", () => {
    const runs = [
      run(1),
      run(3, { conclusion: "failure" }),
      run(4, { conclusion: "cancelled" }),
      run(5, { status: "in_progress", conclusion: null }),
      run(6, { head_sha: "b".repeat(40) }),
      run(7, { event: "pull_request" }),
      run(2, { event: "workflow_dispatch" }),
    ];
    expect(
      runsForSha(runs, { sha: SHA, events: ["push", "workflow_dispatch"] }).map((r) => r.id)
    ).toEqual([3, 2, 1]);
  });

  it("tolerates a missing run list", () => {
    expect(runsForSha(undefined, { sha: SHA, events: ["push"] })).toEqual([]);
  });
});

/**
 * A fake `gh`: `runs` per workflow, `artifacts` per run id, and `files` per
 * `<run id>/<artifact>` written into the -D directory on download.
 */
function fakeGh({ runs = {}, artifacts = {}, files = {}, fail = [] }) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "gh") throw new Error(`unexpected ${cmd}`);
    const joined = args.join(" ");
    if (fail.some((f) => joined.includes(f))) {
      throw Object.assign(new Error("boom"), { stderr: "HTTP 502: bad gateway\nmore" });
    }
    if (args[0] === "api" && args.includes("GET")) {
      const wf = Object.keys(runs).find((w) => joined.includes(`/workflows/${w}/runs`));
      expect(joined).toContain(`head_sha=${SHA}`);
      return JSON.stringify({ workflow_runs: wf ? runs[wf] : [] });
    }
    if (args[0] === "api") {
      const id = Number(args[1].match(/runs\/(\d+)\/artifacts/)[1]);
      return JSON.stringify({ artifacts: artifacts[id] ?? [] });
    }
    if (args[0] === "run" && args[1] === "download") {
      const id = args[2];
      const name = args[args.indexOf("-n") + 1];
      const dir = args[args.indexOf("-D") + 1];
      for (const [rel, body] of Object.entries(files[`${id}/${name}`] ?? {})) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      }
      return "";
    }
    throw new Error(`unexpected gh ${joined}`);
  };
  return { exec, calls };
}

describe("downloadArtifactForSha", () => {
  const args = (dir) => ({
    repo: "o/r",
    sha: SHA,
    workflow: COVERAGE_WORKFLOW,
    events: ["push"],
    artifact: COVERAGE_ARTIFACT,
    dir,
  });

  it("skips runs whose artifact expired and downloads the newest live one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rcs-"));
    const { exec, calls } = fakeGh({
      runs: { [COVERAGE_WORKFLOW]: [run(1), run(2)] },
      artifacts: {
        2: [{ name: COVERAGE_ARTIFACT, expired: true }],
        1: [{ name: COVERAGE_ARTIFACT, expired: false }],
      },
      files: { [`1/${COVERAGE_ARTIFACT}`]: { [UNIT_LCOV]: UNIT } },
    });
    const got = downloadArtifactForSha(args(dir), exec);
    expect(got.run.id).toBe(1);
    expect(readFileSync(path.join(dir, UNIT_LCOV), "utf8")).toBe(UNIT);
    expect(calls.filter((c) => c.startsWith("gh run download"))).toHaveLength(1);
  });

  it("returns a note when no run on the sha has the artifact", () => {
    const { exec } = fakeGh({ runs: { [COVERAGE_WORKFLOW]: [run(1)] } });
    expect(downloadArtifactForSha(args("unused"), exec).note).toContain(
      `live '${COVERAGE_ARTIFACT}' artifact`
    );
  });

  it("returns a note (first stderr line) when the run list cannot be fetched", () => {
    const { exec } = fakeGh({ fail: ["/runs"] });
    expect(downloadArtifactForSha(args("unused"), exec).note).toBe(
      `could not list ${COVERAGE_WORKFLOW} runs (HTTP 502: bad gateway)`
    );
  });
});

describe("computeCoverage", () => {
  it("merges the integration lane into the unit report (unit owns the denominator)", () => {
    const r = computeCoverage({ unitText: UNIT, integrationText: INTEGRATION, root: ROOT });
    expect(r.unit).toMatchObject({ LF: 6, LH: 4, FNF: 2, FNH: 1 });
    expect(r.unified).toMatchObject({ LF: 6, LH: 5, FNF: 2, FNH: 2 });
    expect(r.stats.newlyCoveredLines).toBe(1);
    expect(r.stats.notInBase).toBe(1);
    const core = r.components.find((c) => c.component === "core");
    expect(core.unit).toBeCloseTo(50);
    expect(core.unified).toBeCloseTo(75);
    expect(r.components.find((c) => c.component === "frontend")).toMatchObject({
      unit: 100,
      unified: 100,
    });
    // Components the report has no lines for are left out.
    expect(r.components.map((c) => c.component)).toEqual(["frontend", "core", "unified"]);
  });

  it("reports unit-only coverage without an integration lcov", () => {
    const r = computeCoverage({ unitText: UNIT, integrationText: null, root: ROOT });
    expect(r.unified).toBeNull();
    expect(r.stats).toBeNull();
    expect(r.components.every((c) => c.unified === null)).toBe(true);
  });

  it("reports the integration lane alone without a unit lcov", () => {
    const r = computeCoverage({ unitText: null, integrationText: INTEGRATION, root: ROOT });
    expect(r.unit).toBeNull();
    expect(r.integration).toMatchObject({ LF: 3, LH: 2 });
  });
});

describe("formatMarkdown", () => {
  const base = { sha: SHA, ref: "v0.1.0", repo: "o/r", notes: [] };

  it("shows the unified number, the component table and the gap report", () => {
    const md = formatMarkdown({
      ...base,
      result: computeCoverage({ unitText: UNIT, integrationText: INTEGRATION, root: ROOT }),
      unitRun: run(9),
      integrationSource: "the candidate artifact",
      baseline: { core: 90.48 },
    });
    expect(md).toContain("## Release coverage (advisory)");
    expect(md).toContain(`Commit \`${SHA.slice(0, 12)}\` (v0.1.0)`);
    expect(md).toContain("never blocks the release");
    expect(md).toContain("| Unit tests | 66.67% (4/6) | 50.00% (1/2) | — |");
    expect(md).toContain("| **Unified (unit + integration)** | 83.33% (5/6) |");
    expect(md).toContain("**UNIFIED LINE COVERAGE: 83.33%** (unit only: 66.67%)");
    expect(md).toContain("| core | 50.00% | 75.00% | +25.00 pp | 90.48% |");
    expect(md).toContain("| frontend | 100.00% | 100.00% | +0.00 pp | — |");
    expect(md).toContain(`### ${GAP_TITLE}`);
    expect(md).toContain("| `core/src/backends/ssh.rs` | 1 |");
    expect(md).toContain(
      "- Unit: Coverage [run 9](https://github.com/o/r/actions/runs/9) (push, success)"
    );
    expect(md).toContain("- Integration: the candidate artifact");
    expect(md).not.toContain("### Notes");
  });

  it("says so when only unit coverage exists", () => {
    const md = formatMarkdown({
      ...base,
      result: computeCoverage({ unitText: UNIT, integrationText: null, root: ROOT }),
      unitRun: run(9),
      notes: ["Integration coverage unavailable: x."],
    });
    expect(md).toContain("**UNIT LINE COVERAGE: 66.67%** (no integration coverage merged)");
    expect(md).toContain("| core | 50.00% | — | — | — |");
    expect(md).not.toContain(GAP_TITLE);
    expect(md).toContain("- Integration: none");
    expect(md).toContain("### Notes\n\n- Integration coverage unavailable: x.");
  });

  it("falls back to the integration lane alone, then to a no-data line", () => {
    const intOnly = formatMarkdown({
      ...base,
      result: computeCoverage({ unitText: null, integrationText: INTEGRATION, root: ROOT }),
    });
    expect(intOnly).toContain("no unified number");
    expect(intOnly).toContain("| Integration lane | 66.67% (2/3) |");
    expect(intOnly).toContain("- Unit: none");

    const none = formatMarkdown({ ...base, result: computeCoverage({ root: ROOT }) });
    expect(none).toContain("_No coverage data was available for this commit._");
  });
});

describe("parseArgs", () => {
  it("parses and normalizes the sha", () => {
    expect(
      parseArgs(["--repo", "o/r", "--sha", ` ${SHA.toUpperCase()} `, "--out-dir", "d"])
    ).toEqual({ repo: "o/r", sha: SHA, outDir: "d" });
  });

  it("rejects a missing flag, an unknown flag and a non-sha", () => {
    expect(() => parseArgs(["--repo", "o/r", "--sha", SHA])).toThrow(/--out-dir/);
    expect(() => parseArgs(["--nope", "x"])).toThrow(/bad argument/);
    expect(() => parseArgs(["--repo", "o/r", "--sha", "main", "--out-dir", "d"])).toThrow(
      /not a commit sha/
    );
  });
});

describe("runSummary", () => {
  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "rcs-run-"));
    const summary = path.join(dir, "step-summary.md");
    const baseline = path.join(dir, "baseline.json");
    writeFileSync(baseline, JSON.stringify({ platforms: { linux: { unified: 60 } } }));
    return { dir, summary, baseline, out: path.join(dir, "out") };
  }
  const opts = (s, extra = {}) => ({
    repo: "o/r",
    sha: SHA,
    outDir: s.out,
    root: ROOT,
    ref: "v0.1.0",
    baseline: s.baseline,
    ...extra,
  });
  const quiet = () => {};

  it("release.yml mode: fetches unit + candidate integration coverage by sha", () => {
    const s = setup();
    const { exec } = fakeGh({
      runs: {
        [COVERAGE_WORKFLOW]: [run(1)],
        [CANDIDATE_WORKFLOW]: [run(2, { event: "workflow_dispatch" })],
      },
      artifacts: {
        1: [{ name: COVERAGE_ARTIFACT }],
        2: [{ name: "integration-coverage" }],
      },
      files: {
        [`1/${COVERAGE_ARTIFACT}`]: { [UNIT_LCOV]: UNIT },
        "2/integration-coverage": { "integration.lcov": INTEGRATION },
      },
    });
    const code = runSummary(opts(s), {
      exec,
      env: { GITHUB_STEP_SUMMARY: s.summary },
      log: quiet,
    });
    expect(code).toBe(0);
    const md = readFileSync(path.join(s.out, "release-coverage.md"), "utf8");
    expect(md).toContain("**UNIFIED LINE COVERAGE: 83.33%**");
    expect(md).toContain("| unified | 66.67% | 83.33% | +16.67 pp | 60.00% |");
    expect(md).toContain("Release Candidate [run 2]");
    expect(readFileSync(s.summary, "utf8")).toBe(md);
    expect(readFileSync(path.join(s.out, "integration-gap.md"), "utf8")).toContain(GAP_TITLE);
    expect(readFileSync(path.join(s.out, "merged.lcov"), "utf8")).toContain("LH:3");
  });

  it("release-candidate mode: reads the integration lcov from disk", () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    const lcov = path.join(s.dir, "integration.lcov");
    writeFileSync(lcov, INTEGRATION);
    const { exec, calls } = fakeGh({
      runs: { [COVERAGE_WORKFLOW]: [run(1)] },
      artifacts: { 1: [{ name: COVERAGE_ARTIFACT }] },
      files: { [`1/${COVERAGE_ARTIFACT}`]: { [UNIT_LCOV]: UNIT } },
    });
    runSummary(opts(s, { integrationLcov: lcov }), { exec, env: {}, log: quiet });
    expect(calls.some((c) => c.includes(CANDIDATE_WORKFLOW))).toBe(false);
    const md = readFileSync(path.join(s.out, "release-coverage.md"), "utf8");
    expect(md).toContain("**UNIFIED LINE COVERAGE: 83.33%**");
    expect(md).toContain("artifact of this Release Candidate run");
  });

  it("never fails: gh down and no lcov still exit 0 with notes", () => {
    const s = setup();
    const { exec } = fakeGh({ fail: ["api"] });
    const code = runSummary(opts(s, { integrationLcov: path.join(s.dir, "missing.lcov") }), {
      exec,
      env: { GITHUB_STEP_SUMMARY: path.join(s.dir, "no-such-dir", "summary.md") },
      log: quiet,
    });
    expect(code).toBe(0);
    const md = readFileSync(path.join(s.out, "release-coverage.md"), "utf8");
    expect(md).toContain("_No coverage data was available for this commit._");
    expect(md).toContain("Unit coverage unavailable: could not list coverage.yml runs");
    expect(md).toContain("gh workflow run coverage.yml --repo o/r --ref v0.1.0");
    expect(md).toContain("Integration coverage unavailable: no ");
    expect(existsSync(path.join(s.out, "merged.lcov"))).toBe(false);
  });

  it("notes an artifact that lacks the expected lcov", () => {
    const s = setup();
    const { exec } = fakeGh({
      runs: {
        [COVERAGE_WORKFLOW]: [run(1)],
        [CANDIDATE_WORKFLOW]: [run(2, { event: "workflow_dispatch" })],
      },
      artifacts: {
        1: [{ name: COVERAGE_ARTIFACT }],
        2: [{ name: "integration-coverage" }],
      },
    });
    runSummary(opts(s), { exec, env: {}, log: quiet });
    const md = readFileSync(path.join(s.out, "release-coverage.md"), "utf8");
    expect(md).toContain(`Coverage run 1's artifact has no ${UNIT_LCOV}`);
    expect(md).toContain("Release Candidate run 2's artifact has no integration.lcov");
  });
});
