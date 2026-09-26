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
 *
 * Usage:
 *   git diff --name-only HEAD^1 HEAD | node scripts/internal/ci-changes.mjs
 *   node scripts/internal/ci-changes.mjs --all
 * Prints `key=value` lines suitable for appending to $GITHUB_OUTPUT, including
 * `test_matrix` — the JSON OS list for the "Run Tests" matrix on a PR.
 */

import { readFileSync } from "node:fs";

export const AREAS = ["rust", "frontend", "sidecar", "scripts", "harness", "markdown", "deps"];

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
  // Container fixtures run in integration-fixtures.yml (own path trigger); the
  // only per-PR check that reads them is ShellCheck over their scripts.
  if (path.startsWith("tests/docker/")) return ["scripts"];

  if (path.startsWith("docs/") || path.endsWith(".md") || path.startsWith(".markdownlint")) {
    return ["markdown"];
  }

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
    return ["scripts"];
  }

  return ALL;
}

/**
 * Classify a list of changed paths into area flags.
 * @param {string[]} paths - repo-relative changed paths.
 * @returns {Record<string, boolean>} one boolean per entry of AREAS.
 */
export function classify(paths) {
  const flags = Object.fromEntries(AREAS.map((area) => [area, false]));
  for (const raw of paths) {
    const path = raw.trim().replace(/\\/g, "/");
    if (path.length === 0) continue;

    const areas = locationAreas(path);
    if (areas === ALL) return allAreas();
    for (const area of areas) flags[area] = true;

    // Additive rules, independent of location.
    if (/\.(sh|cmd)$/.test(path)) flags.scripts = true;
    if (DEP_FILES.has(basename(path)) && !path.startsWith("rdp-sidecar/")) flags.deps = true;
  }
  return flags;
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

/**
 * Render flags + matrix as GITHUB_OUTPUT lines.
 * @param {Record<string, boolean>} flags
 * @param {boolean} pullRequest
 * @returns {string}
 */
export function formatOutputs(flags, pullRequest) {
  const lines = AREAS.map((area) => `${area}=${flags[area]}`);
  lines.push(`test_matrix=${JSON.stringify(testMatrix(flags, pullRequest))}`);
  return `${lines.join("\n")}\n`;
}

// CLI mode.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--all")) {
    process.stdout.write(formatOutputs(allAreas(), false));
  } else {
    const paths = readFileSync(0, "utf8").split("\n");
    const flags = classify(paths);
    for (const path of paths.filter((p) => p.trim())) process.stderr.write(`changed: ${path}\n`);
    process.stdout.write(formatOutputs(flags, true));
  }
}
