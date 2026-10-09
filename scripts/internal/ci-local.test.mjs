import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_LOCAL_JOBS,
  coreFeatures,
  isShellScript,
  notReproducedLines,
  workflowJobIds,
} from "./ci-local.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Gate titles a ci-local script runs or skips, with check.sh/.cmd folded. */
function gateTitles(text) {
  const titles = [...text.matchAll(/:?(?:run_gate|skip_gate) "([^"]+)"/g)].map((m) => m[1]);
  return new Set(
    titles.map((title) => (title.startsWith("Quality checks") ? "Quality checks" : title))
  );
}

describe("workflowJobIds", () => {
  it("lists the top-level job ids only", () => {
    const text = [
      "name: X",
      "on: push",
      "jobs:",
      "  # a comment",
      "  first:",
      "    name: First",
      "    steps:",
      "      - run: echo",
      "  second-job:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    expect(workflowJobIds(text)).toEqual(["first", "second-job"]);
  });
});

describe("coreFeatures", () => {
  it("returns every termihub-core feature except default, sorted", () => {
    const metadata = {
      packages: [
        { name: "termihub", features: { default: [], other: [] } },
        { name: "termihub-core", features: { ssh: [], default: ["ssh"], "ftp-test-support": [] } },
      ],
    };
    expect(coreFeatures(metadata)).toEqual(["ftp-test-support", "ssh"]);
  });

  it("throws when termihub-core is missing", () => {
    expect(() => coreFeatures({ packages: [] })).toThrow(/termihub-core/);
  });
});

describe("isShellScript", () => {
  const head = (lines) => (file) => lines[file] ?? "";

  it("takes shell extensions and shebang-only executables", () => {
    const heads = head({ "scripts/hooks/pre-push": "#!/usr/bin/env bash", "bin/x": "#!/bin/sh" });
    expect(isShellScript("scripts/dev.sh", heads)).toBe(true);
    expect(isShellScript("scripts/hooks/pre-push", heads)).toBe(true);
    expect(isShellScript("bin/x", heads)).toBe(true);
  });

  it("skips other files, other interpreters and vendored trees", () => {
    const heads = head({ tool: "#!/usr/bin/env python3", Makefile: "all:" });
    expect(isShellScript("tool", heads)).toBe(false);
    expect(isShellScript("Makefile", heads)).toBe(false);
    expect(isShellScript("scripts/x.mjs", heads)).toBe(false);
    expect(isShellScript("graft/x.sh", heads)).toBe(false);
    expect(isShellScript("node_modules/a/b.sh", heads)).toBe(false);
  });
});

// The drift guard (#4358, TOOL2-004): ci-local had silently fallen behind
// code-quality.yml while still printing "ALL CI GATES PASSED".
describe("ci-local stays in sync with code-quality.yml", () => {
  const sh = read("scripts/ci-local.sh");
  const cmd = read("scripts/ci-local.cmd");

  it("maps every code-quality.yml job, and nothing else", () => {
    const jobs = workflowJobIds(read(".github/workflows/code-quality.yml"));
    expect(jobs.length).toBeGreaterThan(10);
    expect(Object.keys(CI_LOCAL_JOBS).sort()).toEqual([...jobs].sort());
  });

  it("gives each job either gates or a not-reproduced reason", () => {
    for (const [job, entry] of Object.entries(CI_LOCAL_JOBS)) {
      const hasGates = Array.isArray(entry.gates) && entry.gates.length > 0;
      expect(hasGates !== Boolean(entry.notReproduced), job).toBe(true);
    }
  });

  it.each([
    ["ci-local.sh", sh],
    ["ci-local.cmd", cmd],
  ])("%s runs every mapped gate", (_name, text) => {
    const titles = gateTitles(text);
    for (const entry of Object.values(CI_LOCAL_JOBS)) {
      for (const gate of entry.gates ?? []) expect(titles, gate).toContain(gate);
    }
  });

  it("runs the same gates in ci-local.sh and ci-local.cmd", () => {
    expect([...gateTitles(cmd)].sort()).toEqual([...gateTitles(sh)].sort());
  });

  it("derives the core feature list instead of hard-coding it", () => {
    // The old hand-kept list missed six features core/Cargo.toml defines.
    for (const text of [sh, cmd]) {
      expect(text).toContain("ci-local.mjs core-features");
      expect(text).not.toMatch(/mock-remote-desktop/);
    }
  });

  it("no longer claims to reproduce every CI gate", () => {
    for (const text of [sh, cmd]) {
      expect(text).not.toContain("ALL CI GATES PASSED");
      expect(text).toContain("ci-local.mjs not-reproduced");
    }
    expect(notReproducedLines().length).toBeGreaterThan(0);
  });
});
