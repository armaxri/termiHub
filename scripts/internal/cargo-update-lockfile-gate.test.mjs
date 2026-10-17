// Structural guard for the daily lockfile chore's pre-PR gate (#3755, #4465).
//
// Without a dedicated token (#4469), .github/workflows/cargo-update-lockfile.yml
// pushes its PR with GITHUB_TOKEN, and pushes made with GITHUB_TOKEN trigger no
// workflows: the PR carries no check runs, so "auto-merge once CI is green"
// merges it at once. That is how
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
//   - no step that compiles unreviewed crates can reach the write token: the
//     gate runs in a read-only job, and only the separate PR job holds secrets;
//   - the App token / PAT / GITHUB_TOKEN fallback order, and that the App token
//     is minted only after the gate, right before the PR step (#4469).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = readFileSync(
  path.join(ROOT, ".github/workflows/cargo-update-lockfile.yml"),
  "utf8"
);

/** The text of one top-level job, from its `  <id>:` line to the next job. */
function jobText(id) {
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  const start = jobs.indexOf(`\n  ${id}:\n`);
  expect(start, `job ${id}`).toBeGreaterThan(-1);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The gate job: compiles unreviewed crates, must never hold a write token. */
const GATE_JOB = "cargo-update";
/** The PR job: holds the write token, must compile nothing. */
const PR_JOB = "open-pr";

/**
 * Split a job's `steps:` list into `{ name, text }` chunks. Steps are the
 * `      - name:` items (six-space indent) under `jobs.<job>.steps`.
 */
function steps(job = GATE_JOB) {
  const text = jobText(job);
  const body = text.slice(text.indexOf("    steps:\n"));
  const chunks = body.split(/^(?= {6}- name: )/m).slice(1);
  return chunks.map((chunk) => ({
    name: chunk.match(/^ {6}- name: (.+)$/m)[1].trim(),
    text: chunk,
  }));
}

/** The one step in `job` whose name contains `needle`. */
function step(needle, job = GATE_JOB) {
  const found = steps(job).filter((s) => s.name.includes(needle));
  expect(found, `exactly one step named like "${needle}" in ${job}`).toHaveLength(1);
  return found[0];
}

/** Index of the step in `job` whose name contains `needle`. */
const indexOf = (needle, job = GATE_JOB) => steps(job).findIndex((s) => s.name.includes(needle));

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
    expect(g).toBeLessThan(indexOf("Stash the refreshed lockfiles"));
    expect(g).toBeLessThan(indexOf("Upload the refreshed lockfiles"));
    // The PR job only starts once the gate job has finished.
    expect(jobText(PR_JOB)).toMatch(/\n {4}needs: cargo-update\n/);
  });

  it("hands its verdict and the gated develop commit to the PR job", () => {
    const outputs = jobText(GATE_JOB);
    expect(outputs).toContain("base-sha: ${{ steps.base.outputs.sha }}");
    expect(outputs).toContain("changed: ${{ steps.diff.outputs.changed }}");
    expect(outputs).toContain("passed: ${{ steps.gate.outputs.passed }}");
    expect(outputs).toContain("failed: ${{ steps.gate.outputs.failed }}");
    expect(step("Checkout the gated develop commit", PR_JOB).text).toContain(
      "ref: ${{ needs.cargo-update.outputs.base-sha }}"
    );
    expect(jobText(PR_JOB)).toContain("if: needs.cargo-update.outputs.changed == 'true'");
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
    expect(step("Stash the refreshed lockfiles").text).toContain("cp rdp-sidecar/Cargo.lock");
    expect(step("Apply the refreshed lockfiles", PR_JOB).text).toContain(
      'rdp-sidecar.Cargo.lock" rdp-sidecar/Cargo.lock'
    );
    expect(step("Open or update pull request", PR_JOB).text).toContain(
      "git add Cargo.lock rdp-sidecar/Cargo.lock"
    );
  });
});

describe("cargo-update-lockfile.yml PR step honours the gate", () => {
  const pr = step("Open or update pull request", PR_JOB);
  const run = pr.text.slice(pr.text.indexOf("run: |"));

  it("reads the gate verdict and log", () => {
    expect(pr.text).toContain("GATE_PASSED: ${{ needs.cargo-update.outputs.passed }}");
    expect(pr.text).toContain("GATE_FAILED: ${{ needs.cargo-update.outputs.failed }}");
    expect(pr.text).toContain("GATE_LOG: ${{ runner.temp }}/lockfile-pr/lockfile-gate.log");
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
    const fail = step("Fail when the refreshed lockfile fails the gate", PR_JOB);
    expect(fail.text).toContain("if: needs.cargo-update.outputs.passed != 'true'");
    expect(fail.text).toMatch(/exit 1/);
    // Last in the PR job, so the draft PR is opened before the run goes red.
    expect(indexOf("Fail when the refreshed lockfile fails the gate", PR_JOB)).toBe(
      steps(PR_JOB).length - 1
    );
  });

  it("records the gate verdict instead of failing the gate job", () => {
    // A red gate job would skip open-pr, and the draft PR would never open.
    expect(jobText(GATE_JOB)).not.toMatch(/\bexit 1\b/);
  });
});

describe("cargo-update-lockfile.yml keeps the write token away from the gate", () => {
  it("does not persist checkout credentials in either job", () => {
    expect(step("Checkout develop").text).toContain("persist-credentials: false");
    expect(step("Checkout the gated develop commit", PR_JOB).text).toContain(
      "persist-credentials: false"
    );
  });

  it("defaults the workflow token to read-only and grants write to the PR job only", () => {
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(jobText(GATE_JOB)).not.toMatch(/permissions:|: write/);
    expect(jobText(PR_JOB)).toMatch(
      /\n {4}permissions:\n {6}contents: write\n {6}pull-requests: write\n/
    );
  });

  it("gives the gate job no secrets and no token", () => {
    const gateJob = jobText(GATE_JOB);
    expect(gateJob).not.toContain("secrets.");
    expect(gateJob).not.toContain("GH_TOKEN");
    expect(gateJob).not.toContain("github.token");
  });

  it("compiles nothing and installs no packages in the PR job", () => {
    const prJob = jobText(PR_JOB);
    // No toolchain, no dependency install, no build: only git, gh and cp run.
    expect(prJob).not.toMatch(/^\s*cargo\s/m);
    expect(prJob).not.toMatch(/setup-rust|rust-cache|apt-get|pnpm|npm (ci|install)|install-action/);
  });

  it("scopes each secret to the step that needs it", () => {
    const holders = steps(PR_JOB)
      .filter((s) => s.text.includes("secrets."))
      .map((s) => s.name);
    expect(holders).toEqual(["Mint the lockfile App token", "Open or update pull request"]);
    expect(step("Mint the lockfile App token", PR_JOB).text).not.toContain("GITHUB_TOKEN");
    // Not at job level either: the job env sits between the job id and `steps:`.
    const prJob = jobText(PR_JOB);
    const header = prJob.slice(0, prJob.indexOf("    steps:\n"));
    expect(header).not.toContain("GH_TOKEN");
    expect(header).not.toContain("secrets.");
    expect(WORKFLOW.slice(0, WORKFLOW.indexOf("\njobs:\n"))).not.toContain("secrets.");
  });
});

// #4469: an App token or PAT makes the PR run the normal per-PR CI, so
// `gh pr merge --auto` waits for the required checks; GITHUB_TOKEN stays the
// fallback that behaves exactly as before.
describe("cargo-update-lockfile.yml token selection (#4469)", () => {
  const mint = step("Mint the lockfile App token", PR_JOB);
  const pr = step("Open or update pull request", PR_JOB);

  it("mints the App token with a SHA-pinned create-github-app-token", () => {
    expect(mint.text).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d/);
    expect(mint.text).toContain("id: app-token");
  });

  it("mints only when the App is configured", () => {
    expect(mint.text).toContain("if: vars.LOCKFILE_APP_CLIENT_ID != ''");
    expect(mint.text).toContain("client-id: ${{ vars.LOCKFILE_APP_CLIENT_ID }}");
    expect(mint.text).toContain("private-key: ${{ secrets.LOCKFILE_APP_PRIVATE_KEY }}");
  });

  it("asks for contents and pull-requests write and nothing else", () => {
    const permissions = mint.text.match(/permission-[a-z-]+: \w+/g);
    expect(permissions).toEqual(["permission-contents: write", "permission-pull-requests: write"]);
    // This repository only: no owner/repositories widening.
    expect(mint.text).not.toMatch(/\n\s+(owner|repositories):/);
  });

  it("prefers the App token, then LOCKFILE_PAT, then GITHUB_TOKEN", () => {
    expect(pr.text).toContain(
      "GH_TOKEN: ${{ steps.app-token.outputs.token || secrets.LOCKFILE_PAT || secrets.GITHUB_TOKEN }}"
    );
    expect(pr.text).toContain(
      "TOKEN_KIND: ${{ steps.app-token.outputs.token && 'app' || secrets.LOCKFILE_PAT && 'pat' || 'github-token' }}"
    );
  });

  it("mints after the gate job and right before the PR step", () => {
    // After the gate: the gate lives in another job that open-pr needs.
    expect(steps(PR_JOB).some((s) => s.name.includes("Gate the refreshed lockfile"))).toBe(false);
    expect(jobText(PR_JOB)).toMatch(/\n {4}needs: cargo-update\n/);
    // Immediately followed by the one step that uses it.
    const m = indexOf("Mint the lockfile App token", PR_JOB);
    expect(indexOf("Open or update pull request", PR_JOB)).toBe(m + 1);
    expect(indexOf("Apply the refreshed lockfiles", PR_JOB)).toBeLessThan(m);
    // Only the PR step reads the minted token.
    const readers = steps(PR_JOB)
      .filter((s) => s.text.includes("steps.app-token.outputs.token"))
      .map((s) => s.name);
    expect(readers).toEqual(["Open or update pull request"]);
  });

  it("still pushes and arms auto-merge through the same single path", () => {
    const run = pr.text.slice(pr.text.indexOf("run: |"));
    expect(run).toContain("printf 'x-access-token:%s' \"$GH_TOKEN\"");
    expect(run.match(/--auto\b/g)).toHaveLength(1);
    // The PR body tells reviewers which CI the PR gets.
    expect(run).toContain('if [ "$TOKEN_KIND" = "github-token" ]; then');
  });
});
