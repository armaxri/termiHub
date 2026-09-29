#!/usr/bin/env node
/**
 * Classify a PR's changed files into the CI areas they can affect (#3325).
 *
 * The per-PR workflows (code-quality.yml, build.yml) run a tiny `changes` job
 * that feeds the PR's changed-file list through this script and gates each
 * downstream job on the resulting area flags — so a docs-only PR runs no code
 * jobs, a frontend-only PR skips the Rust test/build legs, and a Rust-only PR
 * skips the frontend suite.
 *
 * FAIL-OPEN BY DESIGN. Only paths we positively recognise are narrowed; any
 * file that matches no rule (or any CI-plumbing change under .github/) turns
 * EVERY area on. A new top-level directory therefore costs runner minutes, never
 * coverage. The workflows add a second fail-open layer: they gate on
 * `!= 'false'`, so if this script (or the changes job) fails, every job runs.
 *
 * Push / schedule / dispatch events never call this in narrowing mode — the
 * post-merge develop/main runs always run everything (`--all`).
 *
 * Areas:
 *   rust      workspace crates, manifests, toolchain/cargo config, ts-rs output
 *   frontend  React/TS app, vitest-covered scripts, JS toolchain config
 *   sidecar   the workspace-excluded rdp-sidecar crate (own lockfile)
 *   scripts   shell/cmd scripts (ShellCheck, .sh<->.cmd parity, --help smoke)
 *   harness   the Python system-test harness (tests/system, its generators)
 *   markdown  docs/** and *.md (Prettier + markdownlint in Frontend Code Quality)
 *   deps      dependency manifests/lockfiles (Security Audit on the PR)
 *   agent     anything the termihub-agent binary or its tests are built from
 *             (agent/, core/ and their workspace inputs) — gates the serial
 *             Windows live-agent job (#3615). Always a subset of `rust`.
 *   workflows GitHub Actions workflows (actionlint, #3327). Only a .github/
 *             change sets it, and any .github/ change already turns EVERY area
 *             on (fail-open), so it is off exactly when no CI plumbing changed.
 *   rustdoc   workspace Rust sources changed at all, code or comments: gates
 *             `cargo fmt --check` + the Rustdoc (-D warnings) job (#3903). Always
 *             a superset of `rust`.
 *
 * Comment-only Rust changes (#3903). With `--base <rev> --head <rev>`, each
 * changed workspace `.rs` file whose changed lines are ALL whole-line `//`
 * comments (see rust-comment-diff.mjs) sets only `rustdoc`, not `rust`/`agent`,
 * so a doc-comment fix skips the Rust test, cross-build, live and fixture lanes.
 * Any doubt (git error, new/renamed file, code line, doctest, ts-rs file) keeps
 * the file's full Rust classification.
 *
 * The `[skip-tests]` commit tag (#3915). On a pull_request event whose PR HEAD
 * commit (the PR branch tip, NOT the synthetic merge commit the checkout sits on)
 * carries `[skip-tests]` in its message, the `tests` output is `false` and
 * `test_matrix` is `[]`: the test and build lanes skip, while the quality, lint,
 * rustdoc and gate jobs still run on their area flags. Only the head commit
 * counts, so pushing a later untagged commit re-enables everything. Push,
 * schedule and dispatch runs ignore the tag, so a wrong tag is caught after
 * merge. Any doubt (no head sha, git error) keeps the tests on. The tag is
 * IGNORED (with a notice) when the PR changes CI itself: any `.github/` file or
 * the change-detection / gate scripts (see skipTestsBlockers).
 *
 * Usage:
 *   git diff --name-only HEAD^1 HEAD | node scripts/internal/ci-changes.mjs \
 *     [--base HEAD^1 --head HEAD] [--event pull_request --head-sha <sha>]
 *   node scripts/internal/ci-changes.mjs --all
 * Prints `key=value` lines suitable for appending to $GITHUB_OUTPUT, including
 * `tests` (false only under `[skip-tests]`) and `test_matrix` — the JSON OS list
 * for the "Run Tests" matrix on a PR.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";
import { isCommentOnlyChange } from "./rust-comment-diff.mjs";

export const AREAS = [
  "rust",
  "frontend",
  "sidecar",
  "scripts",
  "harness",
  "markdown",
  "deps",
  "agent",
  "workflows",
  "rustdoc",
];

/** Every OS the "Run Tests" matrix knows about (the post-merge set). */
export const ALL_TEST_OS = ["ubuntu-latest", "windows-latest", "macos-latest"];

const ALL = "ALL";

const RUST_ROOTS = [
  "src-tauri/",
  "core/",
  "agent/",
  "plugin-api/",
  "vendor/",
  "examples/",
  ".cargo/",
];
const RUST_FILES = new Set(["Cargo.toml", "Cargo.lock", "deny.toml", "Cross.toml"]);

// What the termihub-agent crate and its integration tests compile from: the
// agent itself, core (a path dependency) and core's own path dependencies, plus
// the workspace-wide manifests/toolchain. src-tauri/ and examples/ are NOT here —
// the agent does not build from them.
const AGENT_ROOTS = ["agent/", "core/", "plugin-api/", "vendor/", ".cargo/"];
const AGENT_FILES = new Set(["Cargo.toml", "Cargo.lock"]);

const FRONTEND_ROOTS = ["src/", "public/"];
const FRONTEND_FILES = new Set([
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "eslint.config.js",
  "knip.json",
  ".prettierrc",
  ".prettierignore",
]);

// Files that change nothing any CI job checks (commit-lint always runs on a PR
// regardless, so commitlint.config.js needs no area of its own).
const INERT_ROOTS = ["audit/", ".claude/", ".agents/", ".vscode/", "graft/"];
const INERT_FILES = new Set([
  ".gitignore",
  ".ignore",
  ".mcp.json",
  "skills-lock.json",
  "LICENSE",
  "commitlint.config.js",
]);

const DEP_FILES = new Set([
  "Cargo.lock",
  "Cargo.toml",
  "package.json",
  "pnpm-lock.yaml",
  "deny.toml",
]);

const startsWithAny = (path, roots) => roots.some((root) => path.startsWith(root));
const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The location-based areas for one path (before the additive extension rules).
 * @param {string} path - repo-relative path, forward slashes.
 * @returns {string[] | typeof ALL} areas, or ALL for "unknown / CI plumbing".
 */
function locationAreas(path) {
  if (path.startsWith(".github/")) return ALL;
  if (startsWithAny(path, INERT_ROOTS) || INERT_FILES.has(path)) return [];

  // The sidecar is workspace-excluded; its own job gates it. Rust Code Quality
  // also runs for it because cargo-machete there scans rdp-sidecar/ too.
  if (path.startsWith("rdp-sidecar/")) return ["sidecar"];

  // ts-rs output is checked by the Rust job (staleness gate) and consumed by TS.
  if (path.startsWith("src/types/generated/")) return ["rust", "frontend"];

  if (path.startsWith("tests/system/")) return ["harness"];
  // The in-app test bridge: its command set is contract-tested against the
  // Python harness by the machinery suite (test_bridge_protocol_contract.py).
  if (path.startsWith("src/testbridge/")) return ["frontend", "harness"];
  // Container fixtures run in integration-fixtures.yml (own path trigger); the
  // only per-PR check that reads them is ShellCheck over their scripts.
  if (path.startsWith("tests/docker/")) return ["scripts"];

  if (path.startsWith("docs/") || path.endsWith(".md") || path.startsWith(".markdownlint")) {
    return ["markdown"];
  }

  // Tauri config (incl. platform/test overlays) carries the webview CSP, whose
  // allow-list guard is a vitest suite (src/security/cspConfig.test.ts, #3627).
  if (/^src-tauri\/tauri(\.[a-z]+)?\.conf\.json$/.test(path)) return ["rust", "frontend"];

  if (
    startsWithAny(path, RUST_ROOTS) ||
    RUST_FILES.has(path) ||
    path.startsWith("rust-toolchain")
  ) {
    return ["rust"];
  }
  if (startsWithAny(path, FRONTEND_ROOTS) || FRONTEND_FILES.has(path)) return ["frontend"];

  if (path.startsWith("scripts/")) {
    // Node helpers and their *.test.mjs are run by vitest (default include).
    if (/\.(mjs|cjs|js|ts)$/.test(path)) return ["frontend"];
    if (path.endsWith(".py")) return ["harness"];
    // Plugin packaging is exercised by Rust Code Quality.
    if (basename(path).startsWith("package-plugin.")) return ["rust", "scripts"];
    if (basename(path).startsWith("pnpm-audit-prod-gate.")) return ["deps", "scripts"];
    // The Rust test-leg driver (bulk/heavy/serial split) changes what the Rust
    // test jobs run, including the serial Windows live-agent job.
    if (basename(path).startsWith("ci-rust-tests.")) return ["rust", "agent", "scripts"];
    return ["scripts"];
  }

  return ALL;
}

const normalise = (raw) => raw.trim().replace(/\\/g, "/");

/**
 * Whether a path is a workspace Rust source whose comment-only change may be
 * narrowed to the rustdoc area (#3903): a `.rs` file that maps to exactly the
 * `rust` area (not ts-rs output, not the sidecar, not a CI file).
 * @param {string} path - normalised repo-relative path.
 */
export function isNarrowableRustSource(path) {
  if (!path.endsWith(".rs")) return false;
  const areas = locationAreas(path);
  return areas !== ALL && areas.length === 1 && areas[0] === "rust";
}

/**
 * Classify a list of changed paths into area flags.
 * @param {string[]} paths - repo-relative changed paths.
 * @param {{ commentOnly?: Set<string> }} [options] - `commentOnly`: normalised
 *   paths of workspace `.rs` files whose change touches only comment lines.
 * @returns {Record<string, boolean>} one boolean per entry of AREAS.
 */
export function classify(paths, { commentOnly = new Set() } = {}) {
  const flags = Object.fromEntries(AREAS.map((area) => [area, false]));
  for (const raw of paths) {
    const path = normalise(raw);
    if (path.length === 0) continue;

    if (commentOnly.has(path) && isNarrowableRustSource(path)) {
      flags.rustdoc = true;
      continue;
    }

    const areas = locationAreas(path);
    if (areas === ALL) return allAreas();
    for (const area of areas) flags[area] = true;

    // Additive rules, independent of location.
    if (/\.(sh|cmd)$/.test(path)) flags.scripts = true;
    if (DEP_FILES.has(basename(path)) && !path.startsWith("rdp-sidecar/")) flags.deps = true;
    if (
      startsWithAny(path, AGENT_ROOTS) ||
      AGENT_FILES.has(path) ||
      path.startsWith("rust-toolchain")
    ) {
      flags.agent = true;
    }
  }
  if (flags.rust) flags.rustdoc = true;
  return flags;
}

/**
 * Find the workspace `.rs` files among `paths` whose change between two
 * revisions touches only comment lines. Any git failure for a file leaves it
 * out (fail-open: it keeps its full Rust classification).
 * @param {string[]} paths
 * @param {string} base
 * @param {string} head
 * @param {(args: string[]) => string} [git] - runs git, returns stdout; throws on failure.
 * @returns {Set<string>}
 */
export function findCommentOnlyRust(paths, base, head, git = runGit) {
  const found = new Set();
  for (const raw of paths) {
    const path = normalise(raw);
    if (!isNarrowableRustSource(path)) continue;
    try {
      const diff = git(["diff", "--no-renames", "--no-ext-diff", "-U0", base, head, "--", path]);
      const oldSource = git(["show", `${base}:${path}`]);
      const newSource = git(["show", `${head}:${path}`]);
      if (isCommentOnlyChange(oldSource, newSource, diff)) found.add(path);
    } catch {
      // Fail-open: this file keeps its full Rust classification.
    }
  }
  return found;
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @returns {Record<string, boolean>} every area on. */
export function allAreas() {
  return Object.fromEntries(AREAS.map((area) => [area, true]));
}

/**
 * The "Run Tests" OS list for a PR. Ubuntu runs Rust and/or the frontend suite;
 * Windows runs only for Rust changes (it catches real Windows-only Rust bugs; the
 * platform-independent vitest suite is not repeated there on a PR). macOS runs
 * post-merge only — macOS runners are the scarcest in the pool.
 * @param {Record<string, boolean>} flags
 * @param {boolean} pullRequest - false for push/schedule: full matrix.
 * @returns {string[]}
 */
export function testMatrix(flags, pullRequest) {
  if (!pullRequest) return [...ALL_TEST_OS];
  const os = [];
  if (flags.rust || flags.frontend) os.push("ubuntu-latest");
  if (flags.rust) os.push("windows-latest");
  return os;
}

/** The commit-message tag that skips a PR's test and build lanes (#3915). */
export const SKIP_TESTS_TAG = "[skip-tests]";

/**
 * Whether a commit message carries the `[skip-tests]` tag (exact, anywhere).
 * @param {string | undefined} message
 */
export function hasSkipTestsTag(message) {
  return typeof message === "string" && message.includes(SKIP_TESTS_TAG);
}

// A revision we are willing to hand to git: a sha or a simple rev like HEAD^2.
// Never starts with `-`, so it cannot be read as an option.
const SAFE_REV = /^[0-9A-Za-z_][0-9A-Za-z_^~./-]*$/;

/**
 * Whether this run should skip the test and build lanes: only on a
 * pull_request event, and only when the PR's HEAD commit (`headSha` — the PR
 * branch tip, not the merge commit) carries the tag. Older commits in the PR do
 * not count. Fail-open: a missing/odd sha or a git error means "run the tests".
 * @param {{ eventName?: string, headSha?: string, git?: (args: string[]) => string }} options
 * @returns {boolean}
 */
export function skipTestsRequested({ eventName, headSha, git = runGit }) {
  if (eventName !== "pull_request") return false;
  if (!headSha || !SAFE_REV.test(headSha)) return false;
  try {
    return hasSkipTestsTag(git(["log", "-1", "--format=%B", headSha, "--"]));
  } catch {
    return false;
  }
}

// CI plumbing a [skip-tests] PR may not touch: a change here could itself break
// the lanes the tag would skip, so the tag is ignored and everything runs.
const SKIP_TESTS_BLOCKING_SCRIPTS =
  /^scripts\/internal\/(ci-changes[^/]*|rust-comment-diff[^/]*|ci-rust-tests\.sh|pr-gate[^/]*)$/;

/**
 * The changed paths that forbid honouring `[skip-tests]`: any `.github/` file
 * and the change-detection / test-driver / gate scripts under scripts/internal.
 * @param {string[]} paths - repo-relative changed paths.
 * @returns {string[]} normalised blocking paths (empty: the tag may apply).
 */
export function skipTestsBlockers(paths) {
  return paths
    .map(normalise)
    .filter((path) => path.startsWith(".github/") || SKIP_TESTS_BLOCKING_SCRIPTS.test(path));
}

/**
 * Resolve the tag for a PR run: requested on the head commit AND no CI change.
 * @param {{ eventName?: string, headSha?: string, paths: string[],
 *   git?: (args: string[]) => string }} options
 * @returns {{ skip: boolean, requested: boolean, blockedBy: string[] }}
 */
export function resolveSkipTests({ eventName, headSha, paths, git = runGit }) {
  const requested = skipTestsRequested({ eventName, headSha, git });
  const blockedBy = requested ? skipTestsBlockers(paths) : [];
  return { skip: requested && blockedBy.length === 0, requested, blockedBy };
}

/**
 * The notice printed when `[skip-tests]` was requested but a CI change blocks it.
 * @param {string[]} blockedBy
 */
export function skipTestsIgnoredNote(blockedBy) {
  const shown = blockedBy.slice(0, 5).join(", ");
  const more = blockedBy.length > 5 ? ` (+${blockedBy.length - 5} more)` : "";
  return `${SKIP_TESTS_TAG} ignored: this PR changes CI (${shown}${more}); running every lane`;
}

/**
 * The job-summary note printed when `[skip-tests]` skipped the tests.
 * @param {string} headSha
 */
export function skipTestsNote(headSha) {
  return `tests skipped by ${SKIP_TESTS_TAG} on ${headSha}`;
}

/**
 * Render flags + matrix as GITHUB_OUTPUT lines.
 * @param {Record<string, boolean>} flags
 * @param {boolean} pullRequest
 * @param {{ skipTests?: boolean }} [options] - `skipTests`: the PR head commit
 *   carries `[skip-tests]` (#3915): `tests=false` and an empty test matrix.
 * @returns {string}
 */
export function formatOutputs(flags, pullRequest, { skipTests = false } = {}) {
  const lines = AREAS.map((area) => `${area}=${flags[area]}`);
  lines.push(`tests=${!skipTests}`);
  const matrix = skipTests ? [] : testMatrix(flags, pullRequest);
  lines.push(`test_matrix=${JSON.stringify(matrix)}`);
  return `${lines.join("\n")}\n`;
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--all")) {
    process.stdout.write(formatOutputs(allAreas(), false));
  } else {
    const paths = readFileSync(0, "utf8").split("\n");
    const argValue = (name) => {
      const at = process.argv.indexOf(name);
      return at === -1 ? undefined : process.argv[at + 1];
    };
    const base = argValue("--base");
    const head = argValue("--head");
    const commentOnly = base && head ? findCommentOnlyRust(paths, base, head) : new Set();
    const flags = classify(paths, { commentOnly });
    for (const path of paths.filter((p) => p.trim())) {
      const tag = commentOnly.has(normalise(path)) ? " (comment-only Rust)" : "";
      process.stderr.write(`changed: ${path}${tag}\n`);
    }
    const headSha = argValue("--head-sha");
    const resolved = resolveSkipTests({ eventName: argValue("--event"), headSha, paths });
    const skipTests = resolved.skip;
    if (resolved.requested && !skipTests) {
      const note = skipTestsIgnoredNote(resolved.blockedBy);
      process.stderr.write(`::notice title=${SKIP_TESTS_TAG}::${note}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> [!WARNING]\n> **${note}**\n`);
      }
    }
    if (skipTests) {
      const note = skipTestsNote(headSha);
      process.stderr.write(`::notice title=${SKIP_TESTS_TAG}::${note}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `> [!NOTE]\n> **${note}** — the test and build lanes are off for this PR run; ` +
            `quality, lint, rustdoc and the gate still run. Pushes to develop/main run ` +
            `everything.\n`
        );
      }
    }
    process.stdout.write(formatOutputs(flags, true, { skipTests }));
  }
}
