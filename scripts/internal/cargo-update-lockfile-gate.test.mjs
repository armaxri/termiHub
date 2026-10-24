// Structural guard for the daily lockfile chore's pre-PR gate (#3755, #4465).
//
// .github/workflows/cargo-update-lockfile.yml pushes its PR with GITHUB_TOKEN,
// and pushes made with GITHUB_TOKEN trigger no pull_request workflows. While
// the chore still auto-merged, that is how #4460 landed a lockfile that did not
// compile (primefield 0.14.0 vs the -rc p256/p384/p521 stack) and failed the
// pre-release tripwire, breaking every Rust build of develop (#4465).
//
// The chore job therefore gates itself, and since #4912 it never merges at all:
// a maintainer decides. These tests pin that wiring so a later edit cannot
// silently drop a check or bring auto-merge back:
//   - the gate step runs `cargo check --workspace --all-targets --all-features
//     --locked`, the pre-release tripwire and cargo-deny, after `cargo update`
//     and before the PR step;
//   - the PR step only marks the PR ready when the gate passed, and otherwise
//     opens a draft;
//   - nothing arms auto-merge or merges; the PR is assigned to the maintainer,
//     who is asked for review, and the per-PR CI is dispatched on it (#4912);
//   - a failed gate turns the job red;
//   - no step that compiles unreviewed crates can reach the write token: the
//     gate runs in a read-only job, and only the separate PR job holds secrets;
//   - GITHUB_TOKEN is the only token: the App/PAT machinery of #4469 is gone.

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

  it("never arms auto-merge or merges the PR (#4912)", () => {
    // The only `gh pr merge` left drops an auto-merge an older run armed.
    expect(WORKFLOW).not.toMatch(/--auto\b/);
    expect(WORKFLOW.match(/gh pr merge\b[^\n]*/g)).toEqual([
      'gh pr merge "$UPDATE_BRANCH" --disable-auto 2>/dev/null || true',
    ]);
    expect(WORKFLOW).not.toMatch(/--squash|--rebase|--admin/);
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
      /\n {4}permissions:\n {6}contents: write\n {6}pull-requests: write\n {6}actions: write\n/
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

  it("scopes the token to the steps that need it", () => {
    const holders = steps(PR_JOB)
      .filter((s) => s.text.includes("secrets."))
      .map((s) => s.name);
    expect(holders).toEqual([
      "Open or update pull request",
      "Dispatch per-PR CI on the lockfile branch",
    ]);
    // Not at job level either: the job env sits between the job id and `steps:`.
    const prJob = jobText(PR_JOB);
    const header = prJob.slice(0, prJob.indexOf("    steps:\n"));
    expect(header).not.toContain("GH_TOKEN");
    expect(header).not.toContain("secrets.");
    expect(WORKFLOW.slice(0, WORKFLOW.indexOf("\njobs:\n"))).not.toContain("secrets.");
  });
});

// #4912: GITHUB_TOKEN only. The App/PAT chain of #4469 existed to let an
// unattended auto-merge wait for real CI; with a human merging, it is gone.
describe("cargo-update-lockfile.yml uses GITHUB_TOKEN only (#4912)", () => {
  it("holds no App token, PAT or other secret", () => {
    expect(WORKFLOW).not.toMatch(/LOCKFILE_APP|LOCKFILE_PAT|create-github-app-token|TOKEN_KIND/);
    const secrets = new Set(WORKFLOW.match(/secrets\.[A-Za-z_]+/g));
    expect([...secrets]).toEqual(["secrets.GITHUB_TOKEN"]);
  });

  it("pushes with the step-scoped GITHUB_TOKEN", () => {
    const pr = step("Open or update pull request", PR_JOB);
    expect(pr.text).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(pr.text).toContain("printf 'x-access-token:%s' \"$GH_TOKEN\"");
  });
});

describe("cargo-update-lockfile.yml hands the PR to the maintainer (#4912)", () => {
  const pr = step("Open or update pull request", PR_JOB);
  const run = pr.text.slice(pr.text.indexOf("run: |"));

  it("assigns the PR to the maintainer and requests their review", () => {
    expect(jobText(PR_JOB)).toMatch(/\n {6}MAINTAINER: armaxri\n/);
    expect(run).toContain('gh pr edit "$UPDATE_BRANCH" --add-assignee "$MAINTAINER"');
    expect(run).toContain('gh pr edit "$UPDATE_BRANCH" --add-reviewer "$MAINTAINER"');
  });

  it("says plainly in the PR body that it waits for a maintainer decision", () => {
    expect(run).toContain("**Waiting for a maintainer decision.**");
    expect(run).toContain("never merged automatically");
  });
});

describe("cargo-update-lockfile.yml dispatches per-PR CI on its branch (#4912)", () => {
  const dispatch = step("Dispatch per-PR CI on the lockfile branch", PR_JOB);

  it("runs after the PR step, only on a passing gate", () => {
    expect(indexOf("Dispatch per-PR CI", PR_JOB)).toBe(
      indexOf("Open or update pull request", PR_JOB) + 1
    );
    expect(dispatch.text).toContain("if: needs.cargo-update.outputs.passed == 'true'");
  });

  it("dispatches Code Quality, Build and Security Audit on the chore branch", () => {
    expect(dispatch.text).toContain("for wf in code-quality.yml build.yml security-audit.yml; do");
    expect(dispatch.text).toContain(
      'gh workflow run "$wf" --repo "$GITHUB_REPOSITORY" --ref "$UPDATE_BRANCH"'
    );
  });

  it.each(["code-quality.yml", "build.yml", "security-audit.yml"])(
    "%s accepts workflow_dispatch",
    (file) => {
      const text = readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
      const on = text.slice(
        text.indexOf("\non:\n"),
        text.search(/\n(concurrency|permissions|jobs):/)
      );
      expect(on).toMatch(/\n {2}workflow_dispatch:/);
    }
  );
});
