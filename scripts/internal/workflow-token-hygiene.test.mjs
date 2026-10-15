// Regression test for CI2-007 (#4360): the dev-build and release build jobs run
// third-party code (pnpm packages, every crate's build.rs) and used to do so
// with a contents: write token persisted in .git/config by actions/checkout.
// Pinned here:
//   - dev-build.yml defaults to contents: read; only publish-release writes;
//   - no checkout in any workflow or composite action persists its credentials
//     (#4729 extended this repo-wide), except an explicit allowlist of jobs that
//     push with the checkout's token, each with its reason;
//   - the app build jobs install frontend dependencies with --ignore-scripts;
//   - release.yml defaults to contents: read, and no job that installs
//     dependencies or compiles holds a write token: the build jobs hand their
//     outputs on as workflow artifacts to small write-scoped upload jobs that
//     check nothing out and run no package manager (#4730);
//   - a dispatched dry run of release.yml builds and checks every asset but can
//     never reach a write-scoped job (#4746);
//   - the split debug symbols take the same path: packaged by the read-only
//     build jobs, checked by check-release-assets, published by
//     upload-debug-symbols (#4504).
// Text-based like release-draft.test.mjs: the workflow layout is the contract.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Jobs whose checkout must keep the token in .git/config because a later step
 * pushes, tags or otherwise authenticates git with it. Key: `<file>#<job>`,
 * value: why. Empty today: cargo-update-lockfile.yml pushes with a step-scoped
 * credential, the dev/release publishers use the API (gh), and every git fetch
 * is anonymous against this public repo. A new entry must set
 * `persist-credentials: true` explicitly so the exception is visible in the YAML.
 */
const PERSISTING_ALLOWLIST = new Map([]);

/** Every workflow and composite action, as [repo-relative path, text]. */
function workflowFiles() {
  const files = [];
  const workflows = path.join(ROOT, ".github/workflows");
  for (const name of readdirSync(workflows).sort()) {
    if (/\.ya?ml$/.test(name)) files.push(`.github/workflows/${name}`);
  }
  const actions = path.join(ROOT, ".github/actions");
  for (const name of readdirSync(actions).sort()) {
    for (const file of ["action.yml", "action.yaml"]) {
      if (existsSync(path.join(actions, name, file))) files.push(`.github/actions/${name}/${file}`);
    }
  }
  return files.map((file) => [file, readFileSync(path.join(ROOT, file), "utf8")]);
}

/** The top-level job id a 1-based line belongs to ("(composite)" for actions). */
function jobAt(text, line) {
  const before = text.split("\n").slice(0, line - 1);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const match = before[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) return match[1];
    if (/^\S/.test(before[i]) && !/^jobs:/.test(before[i])) break;
  }
  return "(composite)";
}

/** Every checkout step in the repo, tagged with its file, line and job. */
const CHECKOUTS = workflowFiles().flatMap(([file, text]) =>
  checkoutSteps(text).map((step) => ({
    ...step,
    file,
    key: `${file.replace(/^\.github\/workflows\//, "")}#${jobAt(text, step.line)}`,
    where: `${file}:${step.line}`,
  }))
);

describe("checkouts never persist the token (CI2-007, #4729)", () => {
  it("finds the checkouts it guards, in dev-build.yml and release.yml too", () => {
    const files = new Set(CHECKOUTS.map((step) => step.file));
    expect(files).toContain(".github/workflows/dev-build.yml");
    expect(files).toContain(".github/workflows/release.yml");
    expect(CHECKOUTS.length).toBeGreaterThan(50);
  });

  it("sets persist-credentials: false on every checkout outside the allowlist", () => {
    const persisting = CHECKOUTS.filter(
      (step) =>
        !PERSISTING_ALLOWLIST.has(step.key) && !/\n\s+persist-credentials: false\b/.test(step.body)
    ).map((step) => `${step.where} (${step.key})`);
    expect(persisting).toEqual([]);
  });

  it("keeps each allowlist entry live, explicit and explained", () => {
    for (const [key, reason] of PERSISTING_ALLOWLIST) {
      expect(reason, key).toMatch(/\S{10,}/);
      const steps = CHECKOUTS.filter((step) => step.key === key);
      expect(steps.length, `${key} has no checkout`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.body, step.where).toMatch(/\n\s+persist-credentials: true\b/);
      }
    }
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
    ["upload-debug-symbols", "build-app"],
    ["upload-debug-symbols", "agent-binaries-linux"],
    ["upload-debug-symbols", "agent-binaries-macos"],
    ["upload-debug-symbols", "agent-binaries-windows"],
  ])("%s publishes what %s built", (upload, build) => {
    expect(releaseJobs().get(upload)?.needs ?? []).toContain(build);
  });

  it.each([
    "upload-app",
    "upload-agent-binaries",
    "upload-third-party-notices",
    "upload-debug-symbols",
  ])("%s checks nothing out and runs no repository or package-manager code", (id) => {
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
  });

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
        "upload-debug-symbols",
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

const TAG_PUSH_ONLY = "github.event_name == 'push'";

describe("release.yml dry run never reaches a write token (#4746)", () => {
  const jobs = releaseJobs();
  const ids = [...jobs.keys()];
  /**
   * Jobs a dispatched dry run can start: a job is skipped when its own `if` is
   * tag-push-only or any job it needs is skipped (no write job may override
   * that with an `if`, pinned below).
   */
  const reached = new Map();
  const runsInDryRun = (id) => {
    if (!reached.has(id)) {
      reached.set(id, false);
      const job = jobs.get(id);
      reached.set(id, job.if !== TAG_PUSH_ONLY && job.needs.every((n) => runsInDryRun(n)));
    }
    return reached.get(id);
  };
  const dryRunJobs = ids.filter((id) => runsInDryRun(id));

  it("is dispatchable only with a boolean dry_run input that defaults to true", () => {
    expect(RELEASE).toMatch(
      /\n {2}workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n(?: {8}[^\n]*\n)*? {8}type: boolean\n/
    );
    expect(RELEASE).toMatch(/\n {6}dry_run:\n(?: {8}[^\n]*\n)*? {8}default: true\n/);
    const triggers = RELEASE.slice(RELEASE.indexOf("\non:\n"), RELEASE.indexOf("\npermissions:\n"));
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual([
      "push",
      "workflow_dispatch",
    ]);
  });

  it("verify-version refuses a dispatch that is not a dry run", () => {
    const body = jobBody(RELEASE, "verify-version");
    expect(body).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.dry_run != true"
    );
  });

  it("create-release runs on a tag push only", () => {
    expect(jobs.get("create-release").if).toBe(TAG_PUSH_ONLY);
  });

  it("every other write-scoped job directly needs create-release and has no if", () => {
    for (const id of ids) {
      if (id === "create-release") continue;
      if (writeScopes(jobBody(RELEASE, id), { contents: "read" }).length === 0) continue;
      expect(jobs.get(id).needs, id).toContain("create-release");
      expect(jobs.get(id).if, id).toBeUndefined();
    }
  });

  it("every job a dry run reaches is read-only", () => {
    const writers = dryRunJobs.filter(
      (id) => writeScopes(jobBody(RELEASE, id), { contents: "read" }).length > 0
    );
    expect(writers).toEqual([]);
  });

  it("a dry run builds every artifact and checks the asset set", () => {
    expect(dryRunJobs).toEqual(
      expect.arrayContaining([
        "verify-version",
        "verify-supply-chain",
        "verify-integration",
        "release-version",
        "build-app",
        "agent-binaries-linux",
        "agent-binaries-macos",
        "agent-binaries-windows",
        "third-party-notices",
        "sbom-generate",
        "check-release-assets",
      ])
    );
    for (const id of dryRunJobs) {
      expect(jobBody(RELEASE, id), id).not.toContain("needs.create-release");
    }
    expect(jobPermissions(jobBody(RELEASE, "check-release-assets"))).toEqual({
      contents: "read",
    });
  });

  it("release-version resolves the stand-in version without a token", () => {
    const body = jobBody(RELEASE, "release-version");
    expect(body).toMatch(/\n {4}permissions: \{\}\n/);
    expect(body).toContain("version=0.0.0-dryrun");
  });

  it("a dry run generates the SBOMs read-only and checks they are well-formed (#4484)", () => {
    expect(jobs.get("sbom-generate").needs).toContain("release-version");
    expect(jobs.get("sbom-generate").needs).not.toContain("create-release");
    expect(jobPermissions(jobBody(RELEASE, "sbom-generate"))).toEqual({ contents: "read" });
    expect(jobs.get("check-release-assets").needs).toContain("sbom-generate");
    const check = stripComments(jobBody(RELEASE, "check-release-assets"));
    expect(check).toMatch(/name: release-sboms\n/);
    expect(check).toMatch(/for c in desktop agent rdp-sidecar frontend; do/);
    expect(check).toMatch(/jq -e '\.bomFormat == "CycloneDX"/);
    // Attest + upload stay tag-only: sbom needs create-release, so a dry run skips it.
    expect(dryRunJobs).not.toContain("sbom");
    expect(jobs.get("sbom").needs).toContain("create-release");
  });

  it("a dry run packages and checks the debug symbols read-only (#4504)", () => {
    for (const id of [
      "build-app",
      "agent-binaries-linux",
      "agent-binaries-macos",
      "agent-binaries-windows",
    ]) {
      const body = stripComments(jobBody(RELEASE, id));
      expect(body, id).toMatch(/name: release-symbols-/);
      expect(body, id).toMatch(/debug-symbols\.mjs stage/);
      expect(jobs.get("upload-debug-symbols").needs).toContain(id);
    }
    const check = stripComments(jobBody(RELEASE, "check-release-assets"));
    expect(check).toMatch(/pattern: release-symbols-\*\n/);
    expect(check).toMatch(/debug-symbols\.mjs check /);
    expect(check).toMatch(/persist-credentials: false/);
    // Attest + upload stay tag-only.
    expect(dryRunJobs).not.toContain("upload-debug-symbols");
    expect(jobs.get("upload-debug-symbols").needs).toContain("create-release");
    expect(jobs.get("verify-release").needs).toContain("upload-debug-symbols");
  });

  it.each([
    "upload-app",
    "upload-agent-binaries",
    "upload-third-party-notices",
    "upload-debug-symbols",
    "sbom",
  ])("%s publishes only an asset set check-release-assets passed", (id) => {
    expect(jobs.get(id).needs).toContain("check-release-assets");
  });
});
