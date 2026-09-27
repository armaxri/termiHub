import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REQUIRED_WORKFLOWS,
  classifyRuns,
  evaluateGate,
  formatReport,
  fetchRuns,
  runGate,
} from "./release-integration-gate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function run(overrides = {}) {
  return {
    id: 1,
    head_sha: SHA,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-27T10:00:00Z",
    html_url: "https://github.com/o/r/actions/runs/1",
    ...overrides,
  };
}

const GREEN = {
  "release-candidate.yml": [run()],
  "code-quality.yml": [run({ id: 2, event: "push" })],
};

describe("classifyRuns", () => {
  const want = { sha: SHA, event: "workflow_dispatch" };

  it("is ok for a successful run on the sha", () => {
    expect(classifyRuns([run()], want).state).toBe("ok");
  });

  it("is missing when there are no runs, or only runs on other commits/events", () => {
    expect(classifyRuns([], want).state).toBe("missing");
    expect(classifyRuns(undefined, want).state).toBe("missing");
    expect(classifyRuns([run({ head_sha: OTHER })], want).state).toBe("missing");
    expect(classifyRuns([run({ event: "schedule" })], want).state).toBe("missing");
  });

  it("fails on a non-success conclusion", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", null]) {
      expect(classifyRuns([run({ conclusion })], want).state).toBe("failed");
    }
  });

  it("is pending while the newest run is not completed", () => {
    const r = classifyRuns([run({ status: "in_progress", conclusion: null })], want);
    expect(r.state).toBe("pending");
  });

  it("lets the NEWEST run decide, so a later red outranks an earlier green", () => {
    const older = run({ id: 1, created_at: "2026-09-27T09:00:00Z" });
    const newer = run({ id: 2, created_at: "2026-09-27T11:00:00Z", conclusion: "failure" });
    expect(classifyRuns([older, newer], want).state).toBe("failed");
    expect(classifyRuns([newer, older], want).run.id).toBe(2);
  });

  it("accepts a newer green after an older red", () => {
    const older = run({ id: 1, created_at: "2026-09-27T09:00:00Z", conclusion: "failure" });
    const newer = run({ id: 2, created_at: "2026-09-27T11:00:00Z" });
    expect(classifyRuns([older, newer], want).state).toBe("ok");
  });

  it("breaks created_at ties by the higher run id", () => {
    const a = run({ id: 5, conclusion: "failure" });
    const b = run({ id: 6 });
    expect(classifyRuns([a, b], want).run.id).toBe(6);
  });
});

describe("evaluateGate", () => {
  it("requires the release candidate and the Code Quality push run", () => {
    expect(REQUIRED_WORKFLOWS.map((w) => [w.file, w.event])).toEqual([
      ["release-candidate.yml", "workflow_dispatch"],
      ["code-quality.yml", "push"],
    ]);
  });

  it("passes only when every required workflow is green", () => {
    expect(evaluateGate({ sha: SHA, runsByWorkflow: GREEN }).ok).toBe(true);
  });

  it("fails when any one requirement is missing", () => {
    const verdict = evaluateGate({
      sha: SHA,
      runsByWorkflow: { ...GREEN, "release-candidate.yml": [] },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.results.map((r) => r.state)).toEqual(["missing", "ok"]);
  });

  it("does not accept a Code Quality pull_request run as the post-merge run", () => {
    const verdict = evaluateGate({
      sha: SHA,
      runsByWorkflow: { ...GREEN, "code-quality.yml": [run({ event: "pull_request" })] },
    });
    expect(verdict.results[1].state).toBe("missing");
  });
});

describe("formatReport", () => {
  const ctx = { sha: SHA, repo: "o/r", refName: "v1.2.3", runId: "99", runUrl: "https://x/99" };

  it("reports success without errors", () => {
    const lines = formatReport(evaluateGate({ sha: SHA, runsByWorkflow: GREEN }), ctx);
    expect(lines.some((l) => l.startsWith("::error::"))).toBe(false);
    expect(lines.at(-1)).toMatch(/All required integration lanes are green/);
  });

  it("annotates each unmet lane and prints the remediation commands", () => {
    const verdict = evaluateGate({
      sha: SHA,
      runsByWorkflow: {
        "release-candidate.yml": [run({ conclusion: "failure" })],
        "code-quality.yml": [],
      },
    });
    const text = formatReport(verdict, ctx).join("\n");
    expect(text).toMatch(/::error::Release Candidate.*concluded failure/);
    expect(text).toMatch(/::error::Code Quality.*no push run on this commit/);
    expect(text).toContain("gh workflow run release-candidate.yml --repo o/r --ref v1.2.3");
    expect(text).toContain("gh run rerun 99 --repo o/r --failed");
  });
});

/** A fake `fetch` answering per-workflow from a table, recording the URLs. */
function fakeFetch(table, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const file = Object.keys(table).find((f) => url.includes(`/workflows/${f}/runs`));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ workflow_runs: table[file] ?? [] }),
      text: async () => "boom",
    };
  };
  return { impl, calls };
}

describe("fetchRuns", () => {
  it("queries the workflow's runs filtered by sha and event, with the token", async () => {
    const { impl, calls } = fakeFetch(GREEN);
    const runs = await fetchRuns({
      repo: "o/r",
      file: "code-quality.yml",
      sha: SHA,
      event: "push",
      token: "t0k",
      fetchImpl: impl,
    });
    expect(runs).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.github.com/repos/o/r/actions/workflows/code-quality.yml/runs?head_sha=${SHA}&event=push&per_page=100`
    );
    expect(calls[0].init.headers.Authorization).toBe("Bearer t0k");
  });

  it("throws on an HTTP error", async () => {
    const { impl } = fakeFetch(GREEN, { status: 403 });
    await expect(
      fetchRuns({
        repo: "o/r",
        file: "x.yml",
        sha: SHA,
        event: "push",
        token: "t",
        fetchImpl: impl,
      })
    ).rejects.toThrow(/HTTP 403/);
  });
});

it("treats a 404 (workflow not on the default branch) as no runs", async () => {
  const { impl } = fakeFetch(GREEN, { status: 404 });
  const runs = await fetchRuns({
    repo: "o/r",
    file: "release-candidate.yml",
    sha: SHA,
    event: "workflow_dispatch",
    token: "t",
    fetchImpl: impl,
  });
  expect(runs).toEqual([]);
});

describe("runGate", () => {
  const baseEnv = { GITHUB_SHA: SHA, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" };

  async function gate(env, table = GREEN, opts) {
    const log = [];
    const { impl } = fakeFetch(table, opts);
    const code = await runGate({ env, fetchImpl: impl, log: (l) => log.push(l) });
    return { code, log: log.join("\n") };
  }

  it("exits 0 when every lane is green", async () => {
    expect((await gate(baseEnv)).code).toBe(0);
  });

  it("exits 1 and fails loudly when a lane is missing", async () => {
    const { code, log } = await gate(baseEnv, { ...GREEN, "release-candidate.yml": [] });
    expect(code).toBe(1);
    expect(log).toMatch(/Refusing to release/);
  });

  it("prefers RELEASE_SHA over GITHUB_SHA", async () => {
    const { code } = await gate({ ...baseEnv, RELEASE_SHA: OTHER });
    expect(code).toBe(1);
  });

  it("exits 2 on a malformed sha, missing token or API error", async () => {
    expect((await gate({ ...baseEnv, GITHUB_SHA: "main" })).code).toBe(2);
    expect((await gate({ ...baseEnv, GITHUB_TOKEN: "" })).code).toBe(2);
    expect((await gate(baseEnv, GREEN, { status: 500 })).code).toBe(2);
  });

  it("writes the verdict to the step summary", async () => {
    const summary = path.join(mkdtempSync(path.join(tmpdir(), "gate-")), "summary.md");
    const { code } = await gate(
      { ...baseEnv, GITHUB_STEP_SUMMARY: summary },
      {
        ...GREEN,
        "code-quality.yml": [],
      }
    );
    expect(code).toBe(1);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("### Release integration gate");
    expect(text).toContain("FAIL: Code Quality");
    expect(text).not.toContain("::error::");
  });
});
