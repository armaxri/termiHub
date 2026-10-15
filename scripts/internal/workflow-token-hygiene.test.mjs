// Regression test for CI2-007 (#4360): the dev-build and release build jobs run
// third-party code (pnpm packages, every crate's build.rs) and used to do so
// with a contents: write token persisted in .git/config by actions/checkout.
// Pinned here:
//   - dev-build.yml defaults to contents: read; only publish-release writes;
//   - no checkout in dev-build.yml or release.yml persists its credentials;
//   - the app build jobs install frontend dependencies with --ignore-scripts.
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
    ["release.yml", "build-and-upload", RELEASE],
  ])("%s %s installs with --ignore-scripts", (_name, job, text) => {
    const installs = jobBody(text, job).match(/pnpm install[^\n]*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).toContain("--ignore-scripts");
  });
});
