#!/usr/bin/env node
// Keep the pinned CI Rust toolchain and the crates' declared MSRV in lockstep
// (CI-005, SUP-011, WA-CI-016).
//
// Single source of truth: `.github/rust-version` (an exact X.Y.Z version). The
// `.github/actions/setup-rust` composite action installs exactly that version
// in EVERY CI job. This check fails if:
//
//   1. `.github/rust-version` is missing or not an exact X.Y.Z version;
//   2. the root `[workspace.package] rust-version` differs from it;
//   3. a first-party workspace member (anything not under `vendor/`) does not
//      inherit it via `rust-version.workspace = true`;
//   4. the workspace-excluded `rdp-sidecar` declares a different (or no)
//      `rust-version`;
//   5. a workflow under `.github/workflows/` calls `dtolnay/rust-toolchain`
//      directly instead of `./.github/actions/setup-rust` — which would
//      silently reintroduce a floating or second pin.
//
// There is deliberately no repo-root rust-toolchain.toml (#2549): local dev
// keeps its own toolchain. Bump procedure: docs/contributing.md ->
// "Rust toolchain version".
//
// Usage: node scripts/internal/check-rust-version.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-rust-version.test.mjs).

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Workspace-excluded crates that must declare the same rust-version literally. */
export const STANDALONE_CRATES = ["rdp-sidecar"];

/**
 * Parse the pinned toolchain version file's contents.
 *
 * @param {string | null | undefined} text - contents of `.github/rust-version`.
 * @returns {string | null} the exact X.Y.Z version, or null if malformed.
 */
export function parsePinnedVersion(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Return the body lines of one TOML table (up to the next table header).
 *
 * @param {string} toml - manifest text.
 * @param {string} table - table name without brackets, e.g. "workspace.package".
 * @returns {string | null} the table body, or null if the table is absent.
 */
export function tableBody(toml, table) {
  const lines = toml.split(/\r?\n/);
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Read a literal `rust-version = "..."` from a table.
 *
 * @param {string} toml - manifest text.
 * @param {string} table - e.g. "package" or "workspace.package".
 * @returns {string | null} the declared version, or null if absent.
 */
export function literalRustVersion(toml, table) {
  const body = tableBody(toml, table);
  if (body === null) return null;
  const match = body.match(/^\s*rust-version\s*=\s*"([^"]*)"/m);
  return match ? match[1] : null;
}

/**
 * Whether `[package]` inherits the workspace rust-version.
 *
 * @param {string} toml - member manifest text.
 * @returns {boolean}
 */
export function inheritsRustVersion(toml) {
  const body = tableBody(toml, "package");
  if (body === null) return false;
  return (
    /^\s*rust-version\.workspace\s*=\s*true\b/m.test(body) ||
    /^\s*rust-version\s*=\s*\{\s*workspace\s*=\s*true\s*\}/m.test(body)
  );
}

/**
 * Extract the `[workspace] members = [...]` list.
 *
 * @param {string} toml - root manifest text.
 * @returns {string[]} member paths.
 */
export function workspaceMembers(toml) {
  const body = tableBody(toml, "workspace");
  if (body === null) return [];
  const match = body.match(/^\s*members\s*=\s*\[([\s\S]*?)\]/m);
  if (!match) return [];
  return [...match[1].replace(/#.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Find workflow lines that install a toolchain without the shared action.
 *
 * @param {Record<string, string>} workflows - file name -> contents.
 * @returns {string[]} "file:line" locations of direct dtolnay/rust-toolchain uses.
 */
export function directToolchainUses(workflows) {
  const hits = [];
  for (const [name, text] of Object.entries(workflows)) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*-?\s*uses:\s*dtolnay\/rust-toolchain@/.test(line)) {
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
 * @param {string | null} repo.pinnedFile - contents of `.github/rust-version`.
 * @param {string} repo.rootManifest - root Cargo.toml.
 * @param {Record<string, string | null>} repo.memberManifests - member path -> Cargo.toml.
 * @param {Record<string, string | null>} repo.standaloneManifests - crate dir -> Cargo.toml.
 * @param {Record<string, string>} repo.workflows - workflow file -> contents.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(repo) {
  const problems = [];
  const pinned = parsePinnedVersion(repo.pinnedFile);
  if (pinned === null) {
    problems.push(
      `.github/rust-version must hold one exact X.Y.Z toolchain version (got ${JSON.stringify(
        repo.pinnedFile
      )})`
    );
    return problems;
  }

  const workspaceVersion = literalRustVersion(repo.rootManifest, "workspace.package");
  if (workspaceVersion !== pinned) {
    problems.push(
      `Cargo.toml [workspace.package] rust-version is ${JSON.stringify(
        workspaceVersion
      )}, expected "${pinned}" (.github/rust-version)`
    );
  }

  for (const [member, manifest] of Object.entries(repo.memberManifests)) {
    if (member.startsWith("vendor/")) continue; // vendored forks keep upstream's MSRV
    if (manifest === null) {
      problems.push(`${member}/Cargo.toml not found`);
    } else if (!inheritsRustVersion(manifest)) {
      problems.push(`${member}/Cargo.toml [package] must set \`rust-version.workspace = true\``);
    }
  }

  for (const [crate, manifest] of Object.entries(repo.standaloneManifests)) {
    const declared = manifest === null ? null : literalRustVersion(manifest, "package");
    if (declared !== pinned) {
      problems.push(
        `${crate}/Cargo.toml [package] rust-version is ${JSON.stringify(
          declared
        )}, expected "${pinned}" (.github/rust-version)`
      );
    }
  }

  for (const hit of directToolchainUses(repo.workflows)) {
    problems.push(
      `${hit}: uses dtolnay/rust-toolchain directly — use ./.github/actions/setup-rust so the ` +
        `pinned version in .github/rust-version applies`
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
  const rootManifest = readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const memberManifests = Object.fromEntries(
    workspaceMembers(rootManifest).map((m) => [m, readOrNull(path.join(root, m, "Cargo.toml"))])
  );
  const standaloneManifests = Object.fromEntries(
    STANDALONE_CRATES.map((c) => [c, readOrNull(path.join(root, c, "Cargo.toml"))])
  );
  const workflowDir = path.join(root, ".github", "workflows");
  const workflows = Object.fromEntries(
    readdirSync(workflowDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [`.github/workflows/${f}`, readFileSync(path.join(workflowDir, f), "utf8")])
  );
  return {
    pinnedFile: readOrNull(path.join(root, ".github", "rust-version")),
    rootManifest,
    memberManifests,
    standaloneManifests,
    workflows,
  };
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const problems = findProblems(loadRepo(root));
  if (problems.length > 0) {
    console.error("Rust toolchain / rust-version drift (see docs/contributing.md):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const pinned = parsePinnedVersion(
    readFileSync(path.join(root, ".github", "rust-version"), "utf8")
  );
  console.log(`Rust toolchain ${pinned}: CI pin, workspace and rdp-sidecar rust-version agree.`);
}
