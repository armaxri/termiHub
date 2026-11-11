import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  candidateRuns,
  pickArtifact,
  staleListFrom,
  parseArgs,
  fetchIntegrationCoverage,
  fetchHarnessCoverage,
  harnessArtifactName,
  readMeasuredSha,
  latestRun,
  laneStatus,
  commitsBehind,
  WORKFLOW,
  ARTIFACT,
  LCOV_NAME,
  HARNESS_LCOV,
  HARNESS_META,
} from "./fetch-integration-coverage.mjs";

const run = (id, over = {}) => ({
  id,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  created_at: `2026-09-${String(id).padStart(2, "0")}T03:17:00Z`,
  head_sha: `sha${id}`.padEnd(40, "0"),
  ...over,
});

describe("candidateRuns", () => {
  it("keeps completed nightly/dispatch runs, newest first", () => {
    const runs = [
      run(1),
      run(3, { event: "workflow_dispatch" }),
      run(4, { event: "pull_request" }),
      run(5, { conclusion: "cancelled" }),
      run(6, { status: "in_progress", conclusion: null }),
      run(2, { conclusion: "failure" }),
    ];
    expect(candidateRuns(runs).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("pickArtifact", () => {
  it("returns the unexpired coverage artifact only", () => {
    expect(pickArtifact([{ name: "other" }])).toBeNull();
    expect(pickArtifact([{ name: ARTIFACT, expired: true }])).toBeNull();
    expect(pickArtifact([{ name: ARTIFACT, expired: false, id: 9 }])).toEqual({
      name: ARTIFACT,
      expired: false,
      id: 9,
    });
  });
});

describe("staleListFrom", () => {
  it("normalizes git diff output", () => {
    expect(staleListFrom("a.rs\r\n\nb.rs\n")).toBe("a.rs\nb.rs\n");
    expect(staleListFrom("")).toBe("");
  });
});

describe("parseArgs", () => {
  it("requires every option", () => {
    expect(() => parseArgs(["--repo", "o/r", "--branch", "develop"])).toThrow(/--out-dir/);
    expect(() => parseArgs(["--nope", "x"])).toThrow(/bad argument/);
    expect(parseArgs(["--repo", "o/r", "--branch", "develop", "--out-dir", "d"])).toEqual({
      repo: "o/r",
      branch: "develop",
      outDir: "d",
    });
  });
});

/** A fake gh/git: `responses` maps a joined command prefix to stdout or an Error. */
function fakeExec(responses, calls = []) {
  return (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    for (const [prefix, out] of responses) {
      if (line.startsWith(prefix)) {
        if (out instanceof Error) throw out;
        return typeof out === "function" ? out(args) : out;
      }
    }
    throw new Error(`unexpected command: ${line}`);
  };
}

describe("fetchIntegrationCoverage", () => {
  const repo = "o/r";
  const listRuns = "gh api -X GET repos/o/r/actions/workflows/integration-fixtures.yml/runs";

  it("skips runs without the artifact, downloads the newest usable one, lists stale files", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "int-cov-"));
    const calls = [];
    const logs = [];
    const exec = fakeExec(
      [
        [listRuns, JSON.stringify({ workflow_runs: [run(1), run(2)] })],
        ["gh api repos/o/r/actions/runs/2/artifacts", JSON.stringify({ artifacts: [] })],
        [
          "gh api repos/o/r/actions/runs/1/artifacts",
          JSON.stringify({ artifacts: [{ name: ARTIFACT, expired: false }] }),
        ],
        [
          "gh run download 1",
          () => {
            writeFileSync(path.join(outDir, LCOV_NAME), "SF:a\nend_of_record\n");
            return "";
          },
        ],
        ["git fetch", ""],
        ["git diff --name-only", "core/src/a.rs\ncore/src/b.rs\n"],
      ],
      calls
    );
    const res = fetchIntegrationCoverage({ repo, branch: "develop", outDir }, exec, (m) =>
      logs.push(m)
    );
    expect(res.run.id).toBe(1);
    expect(res.lcov).toBe(path.join(outDir, LCOV_NAME));
    expect(readFileSync(res.staleList, "utf8")).toBe("core/src/a.rs\ncore/src/b.rs\n");
    expect(calls[0]).toContain("-f branch=develop");
    expect(calls).toContain(`git diff --name-only ${run(1).head_sha} HEAD`);
    expect(logs.at(-1)).toMatch(/run 1 .*2 file\(s\) changed since/);
  });

  it("returns null (advisory) when no run has coverage yet", () => {
    const logs = [];
    const exec = fakeExec([[listRuns, JSON.stringify({ workflow_runs: [] })]]);
    const res = fetchIntegrationCoverage({ repo, branch: "main", outDir: "unused" }, exec, (m) =>
      logs.push(m)
    );
    expect(res).toBeNull();
    expect(logs[0]).toMatch(/no integration-fixtures.yml nightly run on 'main'/);
  });

  it("returns null when the gh API fails", () => {
    const exec = fakeExec([[listRuns, new Error("HTTP 403")]]);
    const logs = [];
    expect(
      fetchIntegrationCoverage({ repo, branch: "develop", outDir: "x" }, exec, (m) => logs.push(m))
    ).toBeNull();
    expect(logs[0]).toContain("HTTP 403");
  });

  it("returns null without a stale list when the nightly commit cannot be fetched", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "int-cov-"));
    const exec = fakeExec([
      [listRuns, JSON.stringify({ workflow_runs: [run(1)] })],
      [
        "gh api repos/o/r/actions/runs/1/artifacts",
        JSON.stringify({ artifacts: [{ name: ARTIFACT, expired: false }] }),
      ],
      [
        "gh run download 1",
        () => {
          writeFileSync(path.join(outDir, LCOV_NAME), "");
          return "";
        },
      ],
      ["git fetch", new Error("not our ref")],
    ]);
    expect(
      fetchIntegrationCoverage({ repo, branch: "develop", outDir }, exec, () => {})
    ).toBeNull();
    expect(existsSync(path.join(outDir, "stale-files.txt"))).toBe(false);
  });

  it("returns null when the artifact lacks the lcov file", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "int-cov-"));
    const exec = fakeExec([
      [listRuns, JSON.stringify({ workflow_runs: [run(1)] })],
      [
        "gh api repos/o/r/actions/runs/1/artifacts",
        JSON.stringify({ artifacts: [{ name: ARTIFACT, expired: false }] }),
      ],
      ["gh run download 1", ""],
    ]);
    expect(
      fetchIntegrationCoverage({ repo, branch: "develop", outDir }, exec, () => {})
    ).toBeNull();
  });
});

describe("fetchHarnessCoverage (#3657)", () => {
  const repo = "o/r";
  const listRuns = "gh api -X GET repos/o/r/actions/workflows/system-integration.yml/runs";
  const measured = "a".repeat(40);

  function downloadInto(outDir, { meta = { sha: measured, branch: "develop" }, lcov = true } = {}) {
    return () => {
      if (lcov) writeFileSync(path.join(outDir, HARNESS_LCOV), "SF:src/a.ts\nend_of_record\n");
      if (meta) writeFileSync(path.join(outDir, HARNESS_META), JSON.stringify(meta));
      return "";
    };
  }

  it("picks the branch's artifact by name and diffs against the MEASURED sha", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "harness-cov-"));
    const calls = [];
    // The scheduled run is recorded on main (head_sha = main's) but graded develop.
    const exec = fakeExec(
      [
        [listRuns, JSON.stringify({ workflow_runs: [run(1, { head_sha: "m".repeat(40) })] })],
        [
          "gh api repos/o/r/actions/runs/1/artifacts",
          JSON.stringify({
            artifacts: [
              { name: harnessArtifactName("main"), expired: false },
              { name: harnessArtifactName("develop"), expired: false },
            ],
          }),
        ],
        ["gh run download 1", downloadInto(outDir)],
        ["git fetch", ""],
        ["git diff --name-only", "src/b.ts\n"],
      ],
      calls
    );
    const res = fetchHarnessCoverage({ repo, branch: "develop", outDir }, exec, () => {});
    expect(res.sha).toBe(measured);
    expect(res.lcov).toBe(path.join(outDir, HARNESS_LCOV));
    expect(readFileSync(res.staleList, "utf8")).toBe("src/b.ts\n");
    expect(calls[0]).not.toContain("branch=");
    expect(calls).toContain(
      `gh run download 1 -R o/r -n ${harnessArtifactName("develop")} -D ${outDir}`
    );
    expect(calls).toContain(`git diff --name-only ${measured} HEAD`);
  });

  it("returns null (advisory) when no run carries the branch's artifact", () => {
    const logs = [];
    const exec = fakeExec([
      [listRuns, JSON.stringify({ workflow_runs: [run(1)] })],
      [
        "gh api repos/o/r/actions/runs/1/artifacts",
        JSON.stringify({ artifacts: [{ name: harnessArtifactName("main"), expired: false }] }),
      ],
    ]);
    expect(
      fetchHarnessCoverage({ repo, branch: "develop", outDir: "x" }, exec, (m) => logs.push(m))
    ).toBeNull();
    expect(logs.at(-1)).toMatch(
      /no system-integration.yml run with a live 'harness-coverage-develop'/
    );
  });

  it("returns null when the artifact has no valid measured sha", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "harness-cov-"));
    const exec = fakeExec([
      [listRuns, JSON.stringify({ workflow_runs: [run(1)] })],
      [
        "gh api repos/o/r/actions/runs/1/artifacts",
        JSON.stringify({ artifacts: [{ name: harnessArtifactName("develop"), expired: false }] }),
      ],
      ["gh run download 1", downloadInto(outDir, { meta: { sha: "nope" } })],
    ]);
    expect(fetchHarnessCoverage({ repo, branch: "develop", outDir }, exec, () => {})).toBeNull();
  });

  it("returns null when the gh API fails", () => {
    const exec = fakeExec([[listRuns, new Error("HTTP 403")]]);
    expect(
      fetchHarnessCoverage({ repo, branch: "develop", outDir: "x" }, exec, () => {})
    ).toBeNull();
  });
});

describe("readMeasuredSha", () => {
  it("accepts only a full sha", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meta-"));
    const meta = path.join(dir, "m.json");
    writeFileSync(meta, JSON.stringify({ sha: "b".repeat(40) }));
    expect(readMeasuredSha(meta)).toBe("b".repeat(40));
    writeFileSync(meta, JSON.stringify({ sha: "b".repeat(39) }));
    expect(readMeasuredSha(meta)).toBeNull();
    writeFileSync(meta, "{");
    expect(readMeasuredSha(meta)).toBeNull();
    expect(readMeasuredSha(path.join(dir, "missing.json"))).toBeNull();
  });
});

describe("overlay status (#5346)", () => {
  it("latestRun picks the newest run of any outcome", () => {
    const runs = [
      run(1, { html_url: "u1" }),
      run(3, { conclusion: "cancelled", html_url: "u3" }),
      run(2, { html_url: "u2" }),
    ];
    expect(latestRun(runs)).toEqual({ id: 3, url: "u3", conclusion: "cancelled" });
    expect(latestRun([])).toBeNull();
  });

  it("records the latest run and the last note when nothing is usable", () => {
    const listRuns = "gh api -X GET repos/o/r/actions/workflows/integration-fixtures.yml/runs";
    const exec = fakeExec([
      [listRuns, JSON.stringify({ workflow_runs: [run(1, { conclusion: "cancelled" })] })],
    ]);
    const info = {};
    expect(
      fetchIntegrationCoverage(
        { repo: "o/r", branch: "develop", outDir: "x" },
        exec,
        () => {},
        info
      )
    ).toBeNull();
    expect(info.latestRun).toEqual({ id: 1, url: null, conclusion: "cancelled" });
    expect(info.note).toMatch(/no integration-fixtures.yml nightly run/);
    const entry = laneStatus(
      { lane: "integration fixtures", workflow: WORKFLOW, repo: "o/r", root: "/w" },
      null,
      info
    );
    expect(entry.present).toBe(false);
    expect(entry.note).toBe(info.note);
    expect(entry.workflowUrl).toBe(
      "https://github.com/o/r/actions/workflows/integration-fixtures.yml"
    );
  });

  it("counts the overlay's stale files from the lcov and the stale list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "status-"));
    const lcov = path.join(dir, LCOV_NAME);
    const staleList = path.join(dir, "stale-files.txt");
    writeFileSync(lcov, "SF:/w/core/a.rs\nend_of_record\nSF:/w/core/b.rs\nend_of_record\n");
    writeFileSync(staleList, "core/a.rs\nREADME.md\nsrc/x.ts\n");
    const r = run(7, { run_started_at: "2026-11-01T03:00:00Z", html_url: "u7" });
    const entry = laneStatus(
      { lane: "integration fixtures", workflow: WORKFLOW, repo: "o/r", root: "/w" },
      { lcov, staleList, run: r, sha: r.head_sha },
      {}
    );
    expect(entry).toMatchObject({
      present: true,
      sha: r.head_sha,
      measuredAt: "2026-11-01T03:00:00Z",
      run: { id: 7, url: "u7", event: "schedule" },
      changedFiles: 3,
      overlayFiles: 2,
      staleOverlayFiles: 1,
    });
  });

  it("commitsBehind reads the compare API's ahead_by, null on failure", () => {
    const sha = "a".repeat(40);
    const calls = [];
    const exec = fakeExec([["gh api repos/o/r/compare/", "218\n"]], calls);
    expect(commitsBehind("o/r", sha, "h".repeat(40), exec)).toBe(218);
    expect(calls[0]).toContain(`compare/${sha}...${"h".repeat(40)} --jq .ahead_by`);
    expect(commitsBehind("o/r", sha, "h", fakeExec([["gh", new Error("404")]]))).toBeNull();
    expect(commitsBehind("o/r", sha, null, exec)).toBeNull();
  });
});
