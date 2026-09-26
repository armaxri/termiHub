#!/usr/bin/env node
// Keep CI's uv version pinned in exactly one place (WA-CI-017).
//
// Single source of truth: `.github/uv-version` (an exact X.Y.Z version). The
// `.github/actions/setup-uv` composite action installs exactly that version.
// uv is pinned at all because astral-sh/setup-uv without an explicit version
// resolves "latest" through the GitHub Releases API, which flakes and fails
// unrelated jobs (#1552). This check fails if:
//
//   1. `.github/uv-version` is missing or not an exact X.Y.Z version;
//   2. a workflow under `.github/workflows/`, or any composite action other
//      than `.github/actions/setup-uv`, calls `astral-sh/setup-uv` directly —
//      which would reintroduce a duplicated (or floating) uv pin;
//   3. the `setup-uv` composite action no longer reads `.github/uv-version`.
//
// Sibling of check-rust-version.mjs (the same pattern for the Rust toolchain).
// Bump procedure: docs/contributing.md -> "uv version".
//
// Usage: node scripts/internal/check-uv-version.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-uv-version.test.mjs).

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one composite action allowed to call astral-sh/setup-uv. */
export const WRAPPER_ACTION = ".github/actions/setup-uv/action.yml";

/**
 * Parse the pinned uv version file's contents.
 *
 * @param {string | null | undefined} text - contents of `.github/uv-version`.
 * @returns {string | null} the exact X.Y.Z version, or null if malformed.
 */
export function parsePinnedVersion(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Find `uses: astral-sh/setup-uv@...` lines.
 *
 * @param {Record<string, string>} files - path -> YAML text.
 * @returns {string[]} `path:line` for each direct use.
 */
export function directSetupUvUses(files) {
  const hits = [];
  for (const [name, text] of Object.entries(files)) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*-?\s*uses:\s*['"]?astral-sh\/setup-uv@/.test(line)) {
        hits.push(`${name}:${index + 1}`);
      }
    });
  }
  return hits;
}

/**
 * Run every consistency rule against an in-memory view of the repo.
 *
 * @param {object} repo
 * @param {string | null} repo.pinnedFile - `.github/uv-version` contents.
 * @param {string | null} repo.wrapperAction - the setup-uv composite action YAML.
 * @param {Record<string, string>} repo.files - workflows + other composite actions.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(repo) {
  const problems = [];
  if (parsePinnedVersion(repo.pinnedFile) === null) {
    problems.push(
      `.github/uv-version must hold an exact X.Y.Z uv version, got ${JSON.stringify(
        repo.pinnedFile
      )}`
    );
  }

  if (repo.wrapperAction === null) {
    problems.push(`${WRAPPER_ACTION} not found`);
  } else if (!repo.wrapperAction.includes("uv-version")) {
    problems.push(`${WRAPPER_ACTION} must read the version from .github/uv-version`);
  }

  for (const hit of directSetupUvUses(repo.files)) {
    problems.push(
      `${hit}: uses astral-sh/setup-uv directly — use ./.github/actions/setup-uv so the ` +
        `pinned version in .github/uv-version applies`
    );
  }
  return problems;
}

/** @returns {string | null} file contents, or null if the file does not exist. */
function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Load the repo view `findProblems` expects from disk.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const files = {};
  const workflowDir = path.join(root, ".github", "workflows");
  for (const f of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    files[`.github/workflows/${f}`] = readFileSync(path.join(workflowDir, f), "utf8");
  }
  const actionsDir = path.join(root, ".github", "actions");
  for (const dir of existsSync(actionsDir) ? readdirSync(actionsDir) : []) {
    for (const name of ["action.yml", "action.yaml"]) {
      const rel = `.github/actions/${dir}/${name}`;
      if (rel === WRAPPER_ACTION) continue;
      const text = readOrNull(path.join(root, rel));
      if (text !== null) files[rel] = text;
    }
  }
  return {
    pinnedFile: readOrNull(path.join(root, ".github", "uv-version")),
    wrapperAction: readOrNull(path.join(root, WRAPPER_ACTION)),
    files,
  };
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const repo = loadRepo(root);
  const problems = findProblems(repo);
  if (problems.length > 0) {
    console.error("uv version pin drift (see docs/contributing.md -> uv version):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `uv ${parsePinnedVersion(repo.pinnedFile)}: every CI job installs it via ./.github/actions/setup-uv.`
  );
}
