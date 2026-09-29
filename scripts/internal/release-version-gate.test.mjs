// Structural guard for the release version gate (CI-009, #3901).
//
// release.yml's verify-version job runs `release-check.sh --versions-only
// --expect-version <tag>` and must fail the release before anything is built.
// These tests pin that wiring so a later edit cannot silently drop it: every
// build/publish job must list verify-version in its own `needs:`, and the
// per-PR Code Quality lane must run the same drift check.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseWorkflowJobs } from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const RELEASE = read(".github/workflows/release.yml");
const CODE_QUALITY = read(".github/workflows/code-quality.yml");

/** Release jobs that run BEFORE (or beside) the gate and so cannot need it. */
const PRE_GATE = new Set(["verify-version", "verify-integration", "coverage-summary"]);

/** Jobs that produce or publish release assets; each must directly need the gate. */
const BUILD_JOBS = [
  "create-release",
  "build-and-upload",
  "agent-binaries-linux",
  "agent-binaries-macos",
  "agent-binaries-windows",
  "third-party-notices",
  "sbom",
];

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

/** Whether job `id` needs `target`, directly or transitively. */
function dependsOn(jobs, id, target, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const needs = jobs.get(id)?.needs ?? [];
  return needs.includes(target) || needs.some((n) => dependsOn(jobs, n, target, seen));
}

describe("release.yml version gate", () => {
  const jobs = releaseJobs();

  it("verify-version runs the versions-only check against the tag", () => {
    const start = RELEASE.indexOf("  verify-version:");
    const end = RELEASE.indexOf("\n  verify-integration:");
    const body = RELEASE.slice(start, end);
    expect(body).toContain(
      'scripts/release-check.sh --versions-only --expect-version "${TAG_NAME#v}"'
    );
    expect(jobs.get("verify-version").needs).toEqual([]);
  });

  it.each(BUILD_JOBS)("%s lists verify-version in its own needs", (id) => {
    expect(jobs.has(id)).toBe(true);
    expect(jobs.get(id).needs).toContain("verify-version");
  });

  it("every post-gate job depends on verify-version", () => {
    const ungated = [...jobs.keys()].filter(
      (id) => !PRE_GATE.has(id) && !dependsOn(jobs, id, "verify-version")
    );
    expect(ungated).toEqual([]);
  });
});

describe("per-PR version drift check", () => {
  it("Code Quality's frontend-quality job runs release-check.sh --versions-only", () => {
    const start = CODE_QUALITY.indexOf("  frontend-quality:");
    const end = CODE_QUALITY.indexOf("\n  bundle-size:");
    expect(start).toBeGreaterThan(-1);
    expect(CODE_QUALITY.slice(start, end)).toMatch(
      /run: scripts\/release-check\.sh --versions-only\s*$/m
    );
  });
});
