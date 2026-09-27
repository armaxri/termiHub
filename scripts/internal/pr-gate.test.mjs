import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  GATE_EXCLUDED,
  GATE_JOB_ID,
  GATE_JOB_NAME,
  evaluateNeeds,
  expectedGateNeeds,
  formatReport,
  main,
  parseWorkflowJobs,
} from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "code-quality.yml");
const PROTECTION = path.join(ROOT, ".github", "branch-protection.json");

describe("evaluateNeeds", () => {
  it("passes when every needed job succeeded or was skipped", () => {
    const r = evaluateNeeds({
      tests: { result: "success" },
      "rust-quality": { result: "skipped" },
    });
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.job)).toEqual(["rust-quality", "tests"]);
  });

  it.each(["failure", "cancelled"])("fails when a needed job is %s", (result) => {
    const r = evaluateNeeds({ tests: { result }, changes: { result: "success" } });
    expect(r.ok).toBe(false);
    expect(r.rows.find((x) => x.job === "tests")).toMatchObject({ result, ok: false });
  });

  it("fails closed on an unknown or missing result", () => {
    expect(evaluateNeeds({ tests: { result: "neutral" } }).ok).toBe(false);
    const r = evaluateNeeds({ tests: {} });
    expect(r.ok).toBe(false);
    expect(r.rows[0].result).toBe("(none)");
  });

  it("rejects an empty or non-object needs context", () => {
    expect(() => evaluateNeeds({})).toThrow(/empty/);
    expect(() => evaluateNeeds(null)).toThrow(/object/);
    expect(() => evaluateNeeds([])).toThrow(/object/);
  });
});

describe("formatReport", () => {
  it("marks blocking jobs", () => {
    const out = formatReport(evaluateNeeds({ tests: { result: "failure" } }));
    expect(out).toContain("PR Gate: FAILED");
    expect(out).toContain("| tests | failure | BLOCKS |");
  });
});

describe("main", () => {
  const run = (env) => {
    const logs = [];
    const code = main(env, (l) => logs.push(l));
    return { code, out: logs.join("\n") };
  };

  it("exits 0 for a passing needs context and writes the step summary", () => {
    const summary = path.join(mkdtempSync(path.join(tmpdir(), "pr-gate-")), "summary.md");
    const { code } = run({
      NEEDS_JSON: JSON.stringify({ tests: { result: "skipped" } }),
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(code).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("PR Gate: passed");
  });

  it("exits 1 and annotates each failing job", () => {
    const { code, out } = run({
      NEEDS_JSON: JSON.stringify({ tests: { result: "cancelled" }, x: { result: "success" } }),
    });
    expect(code).toBe(1);
    expect(out).toContain("::error::PR Gate: needed job 'tests' finished with 'cancelled'");
    expect(out).not.toContain("job 'x'");
  });

  it("exits 2 on missing or malformed NEEDS_JSON", () => {
    expect(run({}).code).toBe(2);
    expect(run({ NEEDS_JSON: "{nope" }).code).toBe(2);
    expect(run({ NEEDS_JSON: "{}" }).code).toBe(2);
  });
});

describe("parseWorkflowJobs", () => {
  const SAMPLE = [
    "name: X",
    "on: push",
    "jobs:",
    "  a:",
    "    name: Job A # comment",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo",
    "  b:",
    "    name: 'Job B'",
    "    needs: a",
    "    if: >-",
    "      !cancelled() &&",
    "      needs.a.result == 'success'",
    "  c:",
    "    needs: [a, b]",
    "    continue-on-error: true",
    "    strategy:",
    "      matrix:",
    "        os:",
    "          - ubuntu",
    "  d:",
    "    needs:",
    "      - a",
    "      - c # trailing",
    "    if: always()",
    "other:",
    "  e:",
    "    name: not a job",
  ].join("\n");

  it("parses ids, names, needs, if and continue-on-error", () => {
    const jobs = parseWorkflowJobs(SAMPLE);
    expect([...jobs.keys()]).toEqual(["a", "b", "c", "d"]);
    expect(jobs.get("a")).toMatchObject({ name: "Job A", needs: [], continueOnError: false });
    expect(jobs.get("b")).toMatchObject({
      name: "Job B",
      needs: ["a"],
      if: "!cancelled() && needs.a.result == 'success'",
    });
    expect(jobs.get("c")).toMatchObject({ needs: ["a", "b"], continueOnError: true });
    expect(jobs.get("d")).toMatchObject({ needs: ["a", "c"], if: "always()" });
  });

  it("computes the expected gate needs", () => {
    const jobs = parseWorkflowJobs(SAMPLE.replace("  d:", `  ${GATE_JOB_ID}:`));
    expect(expectedGateNeeds(jobs, { c: "advisory" })).toEqual(["a", "b"]);
  });
});

// Consistency with the real workflow: a correctness job added to
// code-quality.yml but not to the PR Gate's `needs:` would never gate a PR.
describe("code-quality.yml PR Gate", () => {
  const jobs = parseWorkflowJobs(readFileSync(WORKFLOW, "utf8"));
  const gate = jobs.get(GATE_JOB_ID);

  it("has the gate job under its required name, always running", () => {
    expect(gate).toBeDefined();
    expect(gate.name).toBe(GATE_JOB_NAME);
    expect(gate.if).toBe("always()");
    expect(gate.continueOnError).toBe(false);
  });

  it("needs every job except those excluded with a reason", () => {
    expect([...gate.needs].sort()).toEqual(expectedGateNeeds(jobs));
  });

  it("excludes only jobs that exist and cannot gate a PR", () => {
    for (const id of Object.keys(GATE_EXCLUDED)) {
      const job = jobs.get(id);
      expect(job, `GATE_EXCLUDED lists unknown job '${id}'`).toBeDefined();
      const prOnlyOff = /github\.event_name != 'pull_request'/.test(job.if ?? "");
      expect(job.continueOnError || prOnlyOff, `'${id}' is a correctness job`).toBe(true);
    }
  });

  it("no gated job is advisory", () => {
    for (const id of gate.needs) expect(jobs.get(id)?.continueOnError, id).toBe(false);
  });

  it("is a required check on develop", () => {
    const protection = JSON.parse(readFileSync(PROTECTION, "utf8"));
    const contexts = protection.branches.develop.protection.required_status_checks.contexts;
    expect(contexts).toContain(GATE_JOB_NAME);
  });
});
