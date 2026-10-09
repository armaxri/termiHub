// Structural guard for the install-smoke gate on mark-latest (CI2-006, PKG2-004,
// #4281).
//
// release.yml calls every platform install smoke (.github/workflows/
// release-*-smoke.yml) as a reusable workflow after verify-release, and
// mark-latest needs every one of those smoke jobs. A broken installer therefore
// fails the Release run before the release becomes GitHub's "Latest release",
// which the desktop update check and the agent self-updater follow. These tests
// pin that wiring: dropping a smoke job, a smoke from mark-latest's needs, or
// adding an `if:` that lets mark-latest run past a failed smoke turns them red.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseWorkflowJobs } from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = ".github/workflows";
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const RELEASE = read(`${WORKFLOWS}/release.yml`);

/** Every install-smoke workflow in the repository. */
const SMOKE_FILES = readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((f) => /^release-.+-smoke\.yml$/.test(f))
  .sort();

/** The body of one top-level job in `text`, up to the next job. */
function jobBody(text, id) {
  const start = text.indexOf(`\n  ${id}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * parseWorkflowJobs reads inline and `- item` needs lists; release.yml also uses
 * multi-line flow lists (`needs:\n  [\n    a,\n    b,\n  ]`). Fill those in.
 */
function releaseJobs() {
  const jobs = parseWorkflowJobs(RELEASE);
  const flow =
    /^ {2}([A-Za-z0-9_-]+):\s*\n(?:(?! {2}\S)[^\n]*\n)*? {4}needs:\s*\n\s*\[([^\]]*)\]/gm;
  for (const [, id, list] of RELEASE.matchAll(flow)) {
    const job = jobs.get(id);
    if (job && job.needs.length === 0) {
      job.needs = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return jobs;
}

/** release.yml job id → the smoke workflow file it calls. */
function smokeCallers(jobs) {
  const callers = new Map();
  for (const id of jobs.keys()) {
    const uses = jobBody(RELEASE, id).match(
      /^ {4}uses: \.\/\.github\/workflows\/(release-.+-smoke\.yml)\s*$/m
    );
    if (uses) callers.set(id, uses[1]);
  }
  return callers;
}

describe("release.yml install-smoke gate on mark-latest (#4281)", () => {
  const jobs = releaseJobs();
  const callers = smokeCallers(jobs);

  it("finds the five platform install smokes", () => {
    expect(SMOKE_FILES).toEqual([
      "release-linux-arm64-smoke.yml",
      "release-linux-smoke.yml",
      "release-macos-smoke.yml",
      "release-windows-arm64-smoke.yml",
      "release-windows-smoke.yml",
    ]);
  });

  it("calls every smoke workflow exactly once", () => {
    expect([...callers.values()].sort()).toEqual(SMOKE_FILES);
  });

  it.each(SMOKE_FILES)("the job calling %s runs after verify-release with the tag", (file) => {
    const [id] = [...callers].find(([, f]) => f === file);
    expect(jobs.get(id).needs).toEqual(
      expect.arrayContaining(["create-release", "verify-release"])
    );
    expect(jobs.get(id).if).toBeUndefined();
    expect(jobBody(RELEASE, id)).toMatch(
      /^ {4}with:\s*\n {6}tag: v\$\{\{ needs\.create-release\.outputs\.version \}\}\s*$/m
    );
  });

  it("mark-latest needs verify-release and every smoke job", () => {
    const needs = jobs.get("mark-latest").needs;
    expect(needs).toContain("verify-release");
    for (const id of callers.keys()) {
      expect(needs).toContain(id);
    }
  });

  it("mark-latest has no if: that could run it past a failed or skipped smoke", () => {
    expect(jobs.get("mark-latest").if).toBeUndefined();
    expect(jobs.get("mark-latest").continueOnError).toBe(false);
  });

  it("no smoke job is continue-on-error", () => {
    for (const id of callers.keys()) {
      expect(jobBody(RELEASE, id)).not.toMatch(/continue-on-error/);
    }
  });

  it("only mark-latest moves the latest marker, and the release starts non-latest", () => {
    const edits = RELEASE.split("\n").filter((l) => /gh release edit\b.*--latest\b/.test(l));
    expect(edits).toHaveLength(1);
    expect(jobBody(RELEASE, "mark-latest")).toContain(edits[0]);
    expect(jobBody(RELEASE, "create-release")).toMatch(/^\s+--latest=false \\$/m);
  });
});

describe.each(SMOKE_FILES)("%s is a reusable workflow", (file) => {
  const text = read(`${WORKFLOWS}/${file}`);
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:\n"));

  it("is triggered by workflow_call and workflow_dispatch with a required tag", () => {
    for (const trigger of ["workflow_call", "workflow_dispatch"]) {
      const block = on.slice(on.indexOf(`  ${trigger}:`));
      expect(block).toMatch(
        new RegExp(
          `^ {2}${trigger}:\\s*\\n {4}inputs:\\s*\\n {6}tag:\\s*\\n(?: {8}.*\\n)*? {8}required: true`,
          "m"
        )
      );
    }
  });

  it("no longer fires on workflow_run (it would grade the release after mark-latest)", () => {
    expect(on).not.toMatch(/workflow_run/);
    expect(text).not.toMatch(/github\.event\.workflow_run/);
  });

  it("reads the tag from inputs and never skips on the event name", () => {
    expect(text).toContain("TAG: ${{ inputs.tag }}");
    // Under workflow_call github.event_name is the caller's (`push`), so an
    // event-name guard would silently skip every job and pass the gate.
    expect(text).not.toMatch(/github\.event_name/);
    for (const job of parseWorkflowJobs(text).values()) {
      expect(job.continueOnError).toBe(false);
    }
  });
});

describe("release-windows-smoke.yml keeps the per-machine LPAC check (#4264)", () => {
  const text = read(`${WORKFLOWS}/release-windows-smoke.yml`);
  const jobs = parseWorkflowJobs(text);

  it("calls plugin-lpac-per-machine.yml for the release MSI", () => {
    const body = jobBody(text, "per-machine-plugin-lpac");
    expect(jobs.get("per-machine-plugin-lpac").needs).toEqual(["resolve-tag"]);
    expect(jobs.get("per-machine-plugin-lpac").if).toBeUndefined();
    expect(body).toMatch(/^ {4}uses: \.\/\.github\/workflows\/plugin-lpac-per-machine\.yml\s*$/m);
    expect(body).toContain("release_tag: ${{ needs.resolve-tag.outputs.tag }}");
  });
});
