// Structural guard for the release version gate (CI-009, #3901) and the Rust
// supply-chain gate (#4282).
//
// release.yml's verify-version job runs `release-check.sh --versions-only
// --expect-version <tag>` and must fail the release before anything is built.
// These tests pin that wiring so a later edit cannot silently drop it: every
// build/publish job must list verify-version in its own `needs:`, and the
// per-PR Code Quality lane must run the same drift check.
//
// verify-supply-chain runs cargo audit + cargo deny (workspace and RDP sidecar)
// with pinned tools on the release commit at tag time; every build job must
// need it too, and every release cargo build must pass --locked.

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
const PRE_GATE = new Set([
  "verify-version",
  "verify-supply-chain",
  "verify-integration",
  "coverage-summary",
]);

/** Jobs that produce or publish release assets; each must directly need the gate. */
const BUILD_JOBS = [
  "create-release",
  "build-and-upload",
  "agent-binaries-linux",
  "agent-binaries-macos",
  "agent-binaries-windows",
  "third-party-notices",
  "sbom-generate",
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

/** The body of one top-level release.yml job, up to the next job. */
function jobBody(id) {
  const start = RELEASE.indexOf(`\n  ${id}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = RELEASE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("release.yml Rust supply-chain gate (#4282)", () => {
  const jobs = releaseJobs();
  const body = jobBody("verify-supply-chain");

  it("audits the workspace and the RDP sidecar with cargo audit and cargo deny", () => {
    expect(jobs.get("verify-supply-chain").needs).toEqual([]);
    expect(body).toMatch(/^\s+run: cargo audit\s*$/m);
    expect(body).toMatch(/^\s+run: cargo deny check advisories bans licenses sources\s*$/m);
    expect(body).toMatch(
      /working-directory: rdp-sidecar\s*\n\s+run: cargo deny check advisories bans licenses sources/
    );
  });

  it("checks both lockfiles are fresh before anything is built", () => {
    expect(body).toContain("cargo metadata --locked --format-version 1 > /dev/null");
    expect(body).toContain("--manifest-path rdp-sidecar/Cargo.toml");
  });

  it("installs cargo-audit and cargo-deny at pinned versions only", () => {
    const tools = [...body.matchAll(/^\s+tool: (.+)$/gm)].flatMap((m) => m[1].split(","));
    expect(tools.map((t) => t.split("@")[0].trim()).sort()).toEqual(["cargo-audit", "cargo-deny"]);
    for (const tool of tools) {
      expect(tool.trim()).toMatch(/^cargo-[a-z]+@\d+\.\d+\.\d+$/);
    }
    expect(body).not.toMatch(/cargo install/);
  });

  it.each(BUILD_JOBS)("%s lists verify-supply-chain in its own needs", (id) => {
    expect(jobs.get(id).needs).toContain("verify-supply-chain");
  });

  it("every post-gate job depends on verify-supply-chain", () => {
    const ungated = [...jobs.keys()].filter(
      (id) => !PRE_GATE.has(id) && !dependsOn(jobs, id, "verify-supply-chain")
    );
    expect(ungated).toEqual([]);
  });
});

describe("release.yml --locked builds (#4282)", () => {
  it("every cargo/cross build passes --locked", () => {
    const builds = RELEASE.split("\n").filter((l) => /\b(cargo|cross) build\b/.test(l));
    const runs = builds.filter((l) => /^\s+run: /.test(l));
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const line of runs) {
      expect(line).toContain("--locked");
    }
  });

  it("the sidecar and plugin-runner builds pass --locked to their scripts", () => {
    for (const script of ["build-rdp-sidecar.sh", "build-plugin-runner.sh"]) {
      const lines = RELEASE.split("\n").filter((l) => l.includes(`./scripts/${script}`));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toContain("--locked");
      }
    }
  });

  it("tauri-action forwards --locked to cargo", () => {
    const args = RELEASE.split("\n").filter((l) => /^\s+args: .*--target/.test(l));
    expect(args.length).toBe(1);
    expect(args[0].trimEnd()).toMatch(/ -- --locked$/);
  });

  it.each(["build-rdp-sidecar.sh", "build-plugin-runner.sh"])(
    "scripts/%s accepts --locked and hands it to cargo",
    (script) => {
      const text = read(`scripts/${script}`);
      expect(text).toMatch(/--locked\)\s*\n\s*CARGO_FLAGS\+=\(--locked\)/);
    }
  );
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
