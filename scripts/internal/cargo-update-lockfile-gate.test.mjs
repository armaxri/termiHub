// Structural guard for the daily lockfile chore's pre-PR gate (#3755, #4465).
//
// .github/workflows/cargo-update-lockfile.yml pushes its PR with GITHUB_TOKEN,
// and pushes made with GITHUB_TOKEN trigger no workflows: the PR carries no
// check runs, so "auto-merge once CI is green" merges it at once. That is how
// #4460 landed a lockfile that did not compile (primefield 0.14.0 vs the -rc
// p256/p384/p521 stack) and failed the pre-release tripwire, breaking every
// Rust build of develop (#4465).
//
// The chore job therefore gates itself. These tests pin that wiring so a later
// edit cannot silently drop a check or arm auto-merge ahead of it:
//   - the gate step runs `cargo check --workspace --all-targets --all-features
//     --locked`, the pre-release tripwire and cargo-deny, after `cargo update`
//     and before the PR step;
//   - the PR step only marks the PR ready / enables auto-merge when the gate
//     passed, and otherwise opens a draft and disables auto-merge;
//   - a failed gate turns the job red;
//   - no step that compiles unreviewed crates can reach the write token.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = readFileSync(
  path.join(ROOT, ".github/workflows/cargo-update-lockfile.yml"),
  "utf8"
);

/**
 * Split the single job's `steps:` list into `{ name, text }` chunks. Steps are
 * the `      - name:` items (six-space indent) under `jobs.cargo-update.steps`.
 */
function steps() {
  const body = WORKFLOW.slice(WORKFLOW.indexOf("    steps:\n"));
  const chunks = body.split(/^(?= {6}- name: )/m).slice(1);
  return chunks.map((text) => ({
    name: text.match(/^ {6}- name: (.+)$/m)[1].trim(),
    text,
  }));
}

/** The one step whose name contains `needle`. */
function step(needle) {
  const found = steps().filter((s) => s.name.includes(needle));
  expect(found, `exactly one step named like "${needle}"`).toHaveLength(1);
  return found[0];
}

/** Index of the step whose name contains `needle`. */
const indexOf = (needle) => steps().findIndex((s) => s.name.includes(needle));

describe("cargo-update-lockfile.yml pre-PR gate", () => {
  const gate = step("Gate the refreshed lockfile");

  it("runs only when the lockfile changed and records its verdict as an output", () => {
    expect(gate.text).toContain("id: gate");
    expect(gate.text).toContain("if: steps.diff.outputs.changed == 'true'");
    expect(gate.text).toContain('echo "passed=true" >> "$GITHUB_OUTPUT"');
    expect(gate.text).toContain('echo "passed=false" >> "$GITHUB_OUTPUT"');
    // The outcome is an output, not a swallowed error.
    expect(gate.text).not.toMatch(/continue-on-error/);
  });

  it("compiles the whole workspace against the refreshed lock", () => {
    expect(gate.text).toMatch(
      /cargo check --workspace --all-targets --all-features --locked(\s|$)/
    );
  });

  it("runs the pre-release tripwire", () => {
    expect(gate.text).toContain("node scripts/internal/check-prerelease-crates.mjs");
  });

  it("runs the same cargo-deny checks as Security Audit", () => {
    expect(gate.text).toMatch(/cargo deny .*check advisories bans licenses sources/);
  });

  it("does not stop at the first failing check", () => {
    // `set -e` would abort on the first failure and hide the other verdicts.
    expect(gate.text).not.toMatch(/set -e(u|uo)?\b/);
    expect(gate.text).toMatch(/set -uo pipefail/);
  });

  it("sits after cargo update and its prerequisites, and before the PR step", () => {
    const g = indexOf("Gate the refreshed lockfile");
    expect(indexOf("Run cargo update")).toBeLessThan(g);
    expect(indexOf("Install cargo-deny")).toBeLessThan(g);
    expect(indexOf("Install system dependencies")).toBeLessThan(g);
    expect(g).toBeLessThan(indexOf("Open or update pull request"));
    expect(g).toBeLessThan(indexOf("Fail when the refreshed lockfile fails the gate"));
  });
});

// #4357 (SUP2-004): rdp-sidecar is workspace-excluded with its own lockfile, so
// the chore refreshes it too and must gate it the same way before the PR.
describe("cargo-update-lockfile.yml refreshes and gates rdp-sidecar/Cargo.lock", () => {
  const gate = step("Gate the refreshed lockfile");

  it("runs cargo update on the sidecar manifest", () => {
    expect(step("Run cargo update").text).toContain(
      "cargo update --manifest-path rdp-sidecar/Cargo.toml"
    );
  });

  it("detects a change to either lockfile", () => {
    const diff = step("Detect lockfile changes").text;
    expect(diff).toContain("git diff --quiet -- Cargo.lock");
    expect(diff).toContain("git diff --quiet -- rdp-sidecar/Cargo.lock");
  });

  it("compiles the sidecar against its refreshed lock", () => {
    expect(gate.text).toMatch(
      /cargo check --manifest-path rdp-sidecar\/Cargo\.toml --all-targets --locked(\s|$)/
    );
  });

  it("runs cargo-deny with the sidecar's own deny.toml", () => {
    expect(gate.text).toMatch(
      /cd rdp-sidecar && cargo deny .*check advisories bans licenses sources/
    );
  });

  it("commits the sidecar lockfile with the workspace one", () => {
    expect(step("Open or update pull request").text).toContain(
      "git add Cargo.lock rdp-sidecar/Cargo.lock"
    );
  });
});

describe("cargo-update-lockfile.yml PR step honours the gate", () => {
  const pr = step("Open or update pull request");
  const run = pr.text.slice(pr.text.indexOf("run: |"));

  it("reads the gate verdict and log", () => {
    expect(pr.text).toContain("GATE_PASSED: ${{ steps.gate.outputs.passed }}");
    expect(pr.text).toContain("GATE_FAILED: ${{ steps.gate.outputs.failed }}");
    expect(pr.text).toContain("GATE_LOG: ${{ runner.temp }}/lockfile-gate.log");
  });

  it("opens a new PR as a draft when the gate failed", () => {
    expect(run).toMatch(/if \[ "\$GATE_PASSED" != "true" \]; then DRAFT_FLAG=\(--draft\); fi/);
    expect(run).toContain('${DRAFT_FLAG[@]+"${DRAFT_FLAG[@]}"}');
  });

  it("marks an existing PR ready only when the gate passed", () => {
    const ready = run.indexOf('gh pr ready "$UPDATE_BRANCH" 2>');
    const guard = run.lastIndexOf('if [ "$GATE_PASSED" = "true" ]; then', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // Nothing between the guard and the ready call closes the if-block.
    expect(run.slice(guard, ready)).not.toMatch(/\bfi\b|\belse\b/);
    expect(run).toContain('gh pr ready "$UPDATE_BRANCH" --undo');
  });

  it("enables auto-merge only after the failing-gate branch has exited", () => {
    const failBlock = run.indexOf('if [ "$GATE_PASSED" != "true" ]; then\n            gh pr merge');
    expect(failBlock).toBeGreaterThan(-1);
    const block = run.slice(failBlock, run.indexOf("\n          fi", failBlock));
    expect(block).toContain('gh pr merge "$UPDATE_BRANCH" --disable-auto');
    expect(block).toContain("exit 0");

    const auto = run.indexOf('gh pr merge "$UPDATE_BRANCH" --auto --merge');
    expect(auto).toBeGreaterThan(failBlock);
    // Exactly one place arms auto-merge, and it is the merge-commit form.
    expect(run.match(/--auto\b/g)).toHaveLength(1);
    expect(run).not.toMatch(/--squash|--rebase/);
  });
});

describe("cargo-update-lockfile.yml failure visibility", () => {
  it("fails the job when the gate did not pass", () => {
    const fail = step("Fail when the refreshed lockfile fails the gate");
    expect(fail.text).toContain(
      "if: steps.diff.outputs.changed == 'true' && steps.gate.outputs.passed != 'true'"
    );
    expect(fail.text).toMatch(/exit 1/);
  });
});

describe("cargo-update-lockfile.yml keeps the write token away from the gate", () => {
  it("does not persist checkout credentials", () => {
    expect(step("Checkout develop").text).toContain("persist-credentials: false");
  });

  it("exposes GITHUB_TOKEN to the PR step only", () => {
    const holders = steps().filter((s) => s.text.includes("secrets.GITHUB_TOKEN"));
    expect(holders.map((s) => s.name)).toEqual(["Open or update pull request"]);
    // Not at job level either: the job env sits between `jobs:` and `steps:`.
    const job = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"), WORKFLOW.indexOf("    steps:\n"));
    expect(job).not.toContain("GH_TOKEN");
    expect(job).not.toContain("secrets.");
  });
});
