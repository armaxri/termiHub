// Regression test for CI2-007 (#4360): the dev-build and release build jobs run
// third-party code (pnpm packages, every crate's build.rs) and used to do so
// with a contents: write token persisted in .git/config by actions/checkout.
// Pinned here:
//   - dev-build.yml defaults to contents: read; only publish-release writes;
//   - no checkout in any workflow or composite action persists its credentials
//     (#4729 extended this repo-wide), except an explicit allowlist of jobs that
//     push with the checkout's token, each with its reason;
//   - the app build jobs install frontend dependencies with --ignore-scripts.
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
        !PERSISTING_ALLOWLIST.has(step.key) &&
        !/\n\s+persist-credentials: false\b/.test(step.body)
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
    ["release.yml", "build-and-upload", RELEASE],
  ])("%s %s installs with --ignore-scripts", (_name, job, text) => {
    const installs = jobBody(text, job).match(/pnpm install[^\n]*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).toContain("--ignore-scripts");
  });
});
