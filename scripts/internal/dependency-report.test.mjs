// Guards for the report-only dependency model (#5011).
//
// Maintainer decision (2026-10-24, restated 2026-10-26): no automated job may
// create dependency-update branches or PRs, push anything, or merge. Checks
// only REPORT. These tests pin that:
//   - .github/workflows/dependency-report.yml is read-only, pushes nothing,
//     opens no PR and dispatches no other workflow;
//   - it reports pending cargo updates (dry run) and cargo-deny for both
//     lockfiles, and outdated npm packages, in the job summary;
//   - it fails only on a cargo-deny finding;
//   - no update bot config (Dependabot, Renovate) exists, and no workflow
//     opens or merges a PR or pushes a branch.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const REPORT = readFileSync(path.join(WORKFLOWS, "dependency-report.yml"), "utf8");

/** Workflow text with full-line comments removed, so prose cannot satisfy a check. */
function code(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Every workflow and composite action, as [repo-relative path, code text]. */
function allWorkflows() {
  const files = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
  const actions = path.join(ROOT, ".github/actions");
  for (const name of readdirSync(actions)) {
    for (const file of ["action.yml", "action.yaml"]) {
      if (existsSync(path.join(actions, name, file))) files.push(`.github/actions/${name}/${file}`);
    }
  }
  return files.map((file) => [file, code(readFileSync(path.join(ROOT, file), "utf8"))]);
}

describe("dependency-report.yml is report-only (#5011)", () => {
  const body = code(REPORT);

  it("grants a read-only token and nothing else", () => {
    expect(body).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(body).not.toMatch(/:\s*write\b/);
    expect(body).not.toMatch(/secrets\./);
  });

  it("does not persist checkout credentials", () => {
    expect(body).toMatch(/persist-credentials: false/);
    expect(body).not.toMatch(/persist-credentials: true/);
  });

  it("never pushes, commits, opens a PR or dispatches another workflow", () => {
    expect(body).not.toMatch(/git (push|commit)/);
    expect(body).not.toMatch(/gh (pr|workflow|api)\b/);
    expect(body).not.toMatch(/create-pull-request/);
  });

  it("runs cargo update only as a dry run, for both lockfiles", () => {
    const updates = body.match(/cargo update[^\n]*/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const line of updates) expect(line).toMatch(/--dry-run/);
    expect(body).toMatch(/report workspace\n/);
    expect(body).toMatch(/report rdp-sidecar --manifest-path rdp-sidecar\/Cargo\.toml/);
  });

  it("runs cargo-deny for the workspace and, from rdp-sidecar/, for the sidecar", () => {
    expect(body).toMatch(/cargo deny --color never check advisories bans licenses sources/);
    expect(body).toMatch(/deny workspace \.\n/);
    expect(body).toMatch(/deny rdp-sidecar rdp-sidecar\n/);
  });

  it("survives a failing check under the runner's `bash -e`", () => {
    // A bare failing command would abort the step before the sidecar check
    // and the summary; each check captures its exit code instead.
    expect(body).toMatch(/cargo update --dry-run --verbose "\$@" > "\$out" 2>&1 \|\| rc=\$\?/);
    expect(body.match(/2>&1 \|\| rc=\$\?/g) ?? []).toHaveLength(2);
    expect(body).not.toMatch(/local rc=\$\?/);
  });

  it("reports outdated npm packages without failing on them", () => {
    expect(body).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    expect(body).toMatch(/pnpm outdated --format json [^\n]*\|\| true/);
    expect(body).toMatch(/node scripts\/internal\/pnpm-outdated-summary\.mjs/);
  });

  it("writes its findings to the job summary", () => {
    expect((body.match(/GITHUB_STEP_SUMMARY/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("fails only on a cargo-deny finding", () => {
    const exits = body.match(/\bexit 1\b/g) ?? [];
    expect(exits).toHaveLength(1);
    const failStep = body.slice(body.indexOf("- name: Fail on actionable findings"));
    expect(failStep).toMatch(/if: steps\.deny\.outputs\.failed != ''/);
    expect(failStep).toMatch(/exit 1/);
  });

  it("has no schedule of its own; the dispatcher runs it weekly", () => {
    expect(body).not.toMatch(/^\s+schedule:/m);
    expect(body).toMatch(/workflow_dispatch:/);
  });
});

describe("no automation proposes or lands dependency updates (#5011)", () => {
  it("has no Dependabot or Renovate config", () => {
    for (const file of [
      ".github/dependabot.yml",
      ".github/dependabot.yaml",
      "renovate.json",
      ".github/renovate.json",
      ".renovaterc",
      ".renovaterc.json",
    ]) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(false);
    }
  });

  it("has no workflow that pushes a branch, opens a PR or merges one", () => {
    const offenders = allWorkflows()
      .filter(([, text]) =>
        /git\b[^\n]*\bpush\b|gh pr (create|merge)|create-pull-request|automerge/.test(text)
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
