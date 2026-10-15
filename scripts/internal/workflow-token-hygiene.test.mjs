// Regression test for CI2-007 (#4360): the dev-build and release build jobs run
// third-party code (pnpm packages, every crate's build.rs) and used to do so
// with a contents: write token persisted in .git/config by actions/checkout.
// Pinned here:
//   - dev-build.yml defaults to contents: read; only publish-release writes;
//   - no checkout in dev-build.yml or release.yml persists its credentials;
//   - the app build jobs install frontend dependencies with --ignore-scripts;
//   - release.yml defaults to contents: read, and no job that installs
//     dependencies or compiles holds a write token: the build jobs hand their
//     outputs on as workflow artifacts to small write-scoped upload jobs that
//     check nothing out and run no package manager (#4730).
// Text-based like release-draft.test.mjs: the workflow layout is the contract.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseWorkflowJobs } from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(path.join(ROOT, ".github/workflows", name), "utf8");
const DEV_BUILD = read("dev-build.yml");
const RELEASE = read("release.yml");

/** The body of one top-level job in `text`, up to the next job. */
function jobBody(text, id) {
  const start = text.indexOf(`\n  ${id}:\n`);
  expect(start, `job ${id}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Each actions/checkout step: from its `uses:` line to the next step. */
function checkoutSteps(text) {
  const steps = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)(?:- )?uses: actions\/checkout@/);
    if (!match) return;
    const indent = match[1].length;
    const body = [line];
    for (const next of lines.slice(index + 1)) {
      const nextIndent = next.search(/\S/);
      if (nextIndent !== -1 && (nextIndent < indent || /^\s*- /.test(next))) break;
      body.push(next);
    }
    steps.push({ line: index + 1, body: body.join("\n") });
  });
  return steps;
}

describe("dev-build.yml token scope (CI2-007)", () => {
  it("defaults the workflow token to contents: read", () => {
    expect(DEV_BUILD).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(DEV_BUILD).not.toMatch(/^permissions:\n {2}contents: write/m);
  });

  it("grants contents: write to publish-release only", () => {
    expect(jobBody(DEV_BUILD, "publish-release")).toMatch(
      /\n {4}permissions:\n {6}contents: write\n/
    );
    const writers = [...parseWorkflowJobs(DEV_BUILD).keys()].filter((id) =>
      /contents: write/.test(jobBody(DEV_BUILD, id))
    );
    expect(writers).toEqual(["publish-release"]);
  });
});

describe.each([
  ["dev-build.yml", DEV_BUILD],
  ["release.yml", RELEASE],
])("%s checkouts (CI2-007)", (name, text) => {
  it("never persist the token into .git/config", () => {
    const steps = checkoutSteps(text);
    expect(steps.length).toBeGreaterThan(0);
    const persisting = steps
      .filter((step) => !/\n\s+persist-credentials: false\b/.test(step.body))
      .map((step) => `${name}:${step.line}`);
    expect(persisting).toEqual([]);
  });
});

describe("app build jobs run no dependency lifecycle scripts (CI2-007)", () => {
  it.each([
    ["dev-build.yml", "build-app", DEV_BUILD],
    ["release.yml", "build-app", RELEASE],
  ])("%s %s installs with --ignore-scripts", (_name, job, text) => {
    const installs = jobBody(text, job).match(/pnpm install[^\n]*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).toContain("--ignore-scripts");
  });
});

/** The job-level `permissions:` map of a job body as { scope: level }. */
function jobPermissions(body) {
  const m = body.match(/\n {4}permissions:[ \t]*([^\n]*)\n((?: {6}[^\n]*\n)*)/);
  if (!m) return null;
  if (m[1].trim()) return { "*": m[1].trim() };
  const perms = {};
  for (const line of m[2].split("\n")) {
    const kv = line.match(/^ {6}([a-z-]+):\s*([a-z-]+)/);
    if (kv) perms[kv[1]] = kv[2];
  }
  return perms;
}

/** Drop full-line and trailing YAML comments so prose cannot satisfy a check. */
function stripComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");
}

/** Scopes a job body grants `write` (the workflow default when it has no block). */
function writeScopes(body, workflowDefault) {
  const perms = jobPermissions(body) ?? workflowDefault;
  return Object.entries(perms)
    .filter(([, level]) => level === "write" || level === "write-all")
    .map(([scope]) => scope);
}

/**
 * Anything that installs dependencies, sets up a toolchain or compiles: the
 * steps that run third-party code (lifecycle scripts, build.rs, tauri-action).
 */
const RUNS_DEPENDENCY_CODE =
  /\b(pnpm|npm|npx|yarn|cargo|cross|pip3?|uvx?)\b|setup-(rust|node|pnpm|cross)\b|tauri-apps\/tauri-action@|rust-cache@|install-action@/;

/** parseWorkflowJobs plus release.yml's multi-line flow `needs:` lists. */
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

describe("release.yml token scope (CI2-007, #4730)", () => {
  const jobs = [...releaseJobs().keys()];

  it("defaults the workflow token to contents: read", () => {
    expect(RELEASE).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(RELEASE).not.toMatch(/^permissions:\n {2}contents: write/m);
  });

  it.each([
    "build-app",
    "agent-binaries-linux",
    "agent-binaries-macos",
    "agent-binaries-windows",
    "third-party-notices",
    "sbom-generate",
  ])("build job %s holds a read-only token and no OIDC", (id) => {
    expect(jobs).toContain(id);
    expect(jobPermissions(jobBody(RELEASE, id))).toEqual({ contents: "read" });
  });

  it("no job that installs dependencies or compiles holds a write token", () => {
    const offenders = jobs.filter((id) => {
      const body = jobBody(RELEASE, id);
      return (
        RUNS_DEPENDENCY_CODE.test(stripComments(body)) &&
        writeScopes(body, { contents: "read" }).length > 0
      );
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ["upload-app", "build-app"],
    ["upload-agent-binaries", "agent-binaries-linux"],
    ["upload-agent-binaries", "agent-binaries-macos"],
    ["upload-agent-binaries", "agent-binaries-windows"],
    ["upload-third-party-notices", "third-party-notices"],
  ])("%s publishes what %s built", (upload, build) => {
    expect(releaseJobs().get(upload)?.needs ?? []).toContain(build);
  });

  it.each(["upload-app", "upload-agent-binaries", "upload-third-party-notices"])(
    "%s checks nothing out and runs no repository or package-manager code",
    (id) => {
      const body = jobBody(RELEASE, id);
      expect(jobPermissions(body)).toEqual({
        contents: "write",
        "id-token": "write",
        attestations: "write",
      });
      const code = stripComments(body);
      const uses = [...code.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
      expect(uses.some((u) => u.startsWith("actions/download-artifact@"))).toBe(true);
      expect(uses.some((u) => u.startsWith("actions/attest-build-provenance@"))).toBe(true);
      for (const u of uses) expect(u, u).toMatch(/^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
      expect(uses.some((u) => u.startsWith("actions/checkout@"))).toBe(false);
      expect(code).not.toMatch(RUNS_DEPENDENCY_CODE);
      expect(code).not.toMatch(/\b(node|curl|wget)\b|\.\/|scripts\//);
      expect(code).toMatch(/gh release upload\b/);
    }
  );

  it("only the publishing jobs hold contents: write", () => {
    const writers = jobs.filter((id) =>
      writeScopes(jobBody(RELEASE, id), { contents: "read" }).includes("contents")
    );
    expect(writers.sort()).toEqual(
      [
        "create-release",
        "mark-latest",
        "publish-release",
        "sbom",
        "sign-agent-binaries",
        "upload-agent-binaries",
        "upload-app",
        "upload-third-party-notices",
        "verify-release",
      ].sort()
    );
  });

  it("grants id-token: write only to jobs that attest provenance", () => {
    for (const id of jobs) {
      const body = jobBody(RELEASE, id);
      if (writeScopes(body, { contents: "read" }).includes("id-token")) {
        expect(body, id).toMatch(/uses: actions\/attest-build-provenance@/);
      }
    }
  });
});
