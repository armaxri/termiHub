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
  ARTIFACT,
  LCOV_NAME,
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
