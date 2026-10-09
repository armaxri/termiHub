#!/usr/bin/env node
// Keep every first-party Rust crate under the workspace's safety policy
// (ERR2-005, TOOL2-002, PKG2-008 — #4343).
//
// Two policies are declared in one place but must hold for crates that the
// root workspace cannot reach, so a crate added later (or a workspace-excluded
// one) silently escapes them. This check fails if:
//
//   1. the root `[profile.release]` does not set `overflow-checks = true`
//      (ERR-010: a silent integer wrap is worse than a fail-fast panic);
//   2. a workspace-excluded crate (`rdp-sidecar`, which has its own Cargo.lock
//      and therefore its own profiles) declares a `[profile.release]`
//      `overflow-checks` or `strip` that differs from the root's — the root
//      profile does NOT apply to it;
//   3. a first-party crate root — `src/lib.rs`, `src/main.rs` and every
//      `[[bin]] path` of each workspace member outside `vendor/`, `examples/`
//      and `tests/`, plus the excluded crates — does not carry the TOOL-010
//      no-panic header
//        #![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]
//      Clippy's restriction lints are off by default, so a root without it is
//      linted with none of them even under CI's `clippy -D warnings`.
//
// Sibling of check-rust-version.mjs (rust-version drift for the same crates).
//
// Usage: node scripts/internal/check-crate-policy.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-crate-policy.test.mjs).

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";
import { STANDALONE_CRATES, tableBody, workspaceMembers } from "./check-rust-version.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Release-profile keys an excluded crate must restate with the root's value. */
export const MIRRORED_RELEASE_KEYS = ["overflow-checks", "strip"];

/**
 * Workspace-member path prefixes that are not first-party shipped code: vendored
 * forks keep upstream's lint policy, example plugins and test probes are not
 * shipped.
 */
export const NON_POLICY_PREFIXES = ["vendor/", "examples/", "tests/"];

/**
 * Read a `key = value` literal from one TOML table, as its raw text.
 *
 * @param {string} toml - manifest text.
 * @param {string} table - table name without brackets, e.g. "profile.release".
 * @param {string} key - the key, e.g. "overflow-checks".
 * @returns {string | null} the raw value (`true`, `"debuginfo"`), or null.
 */
export function tableValue(toml, table, key) {
  const body = tableBody(toml, table);
  if (body === null) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^\\s*${escaped}\\s*=\\s*([^#\\r\\n]*?)\\s*(?:#.*)?$`, "m"));
  return match ? match[1] : null;
}

/**
 * Whether a crate-root source carries the TOOL-010 no-panic header.
 *
 * Requires an inner `#![cfg_attr(not(test), deny(...))]` naming all three of
 * `clippy::unwrap_used`, `clippy::expect_used` and `clippy::panic` (any order,
 * any whitespace). Commented-out headers do not count.
 *
 * @param {string} source - the crate root's Rust source.
 * @returns {boolean}
 */
export function hasNoPanicHeader(source) {
  const code = source.replace(/\/\/[^\n]*/g, "");
  const attrs = code.matchAll(
    /#!\[\s*cfg_attr\(\s*not\(\s*test\s*\)\s*,\s*deny\(([^)]*)\)\s*\)\s*\]/g
  );
  for (const attr of attrs) {
    const lints = attr[1].split(",").map((lint) => lint.trim());
    if (
      ["clippy::unwrap_used", "clippy::expect_used", "clippy::panic"].every((l) =>
        lints.includes(l)
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * List the `path = "..."` of every `[[bin]]` table in a manifest.
 *
 * @param {string} toml - crate manifest text.
 * @returns {string[]} bin source paths relative to the crate directory.
 */
export function binPaths(toml) {
  const paths = [];
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "[[bin]]") continue;
    for (const line of lines.slice(i + 1)) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*path\s*=\s*"([^"]+)"/);
      if (match) paths.push(match[1]);
    }
  }
  return paths;
}

/**
 * The first-party crates the no-panic policy covers.
 *
 * @param {string} rootManifest - root Cargo.toml.
 * @returns {string[]} crate directories relative to the repo root.
 */
export function policyCrates(rootManifest) {
  const members = workspaceMembers(rootManifest).filter(
    (member) => !NON_POLICY_PREFIXES.some((prefix) => member.startsWith(prefix))
  );
  return [...members, ...STANDALONE_CRATES];
}

/**
 * Run every policy rule against an in-memory view of the repo.
 *
 * @param {object} repo
 * @param {string} repo.rootManifest - root Cargo.toml.
 * @param {Record<string, string | null>} repo.standaloneManifests - crate dir -> Cargo.toml.
 * @param {Record<string, Record<string, string | null> | null>} repo.crateRoots -
 *   crate dir -> (root source path relative to the crate -> its source), or
 *   null when the crate's Cargo.toml is missing.
 * @returns {string[]} human-readable problems; empty when compliant.
 */
export function findProblems(repo) {
  const problems = [];

  const rootOverflow = tableValue(repo.rootManifest, "profile.release", "overflow-checks");
  if (rootOverflow !== "true") {
    problems.push(
      `Cargo.toml [profile.release] must set \`overflow-checks = true\` (ERR-010), got ${JSON.stringify(
        rootOverflow
      )}`
    );
  }

  for (const [crate, manifest] of Object.entries(repo.standaloneManifests)) {
    if (manifest === null) {
      problems.push(`${crate}/Cargo.toml not found`);
      continue;
    }
    for (const key of MIRRORED_RELEASE_KEYS) {
      const expected = tableValue(repo.rootManifest, "profile.release", key);
      const actual = tableValue(manifest, "profile.release", key);
      if (actual !== expected) {
        problems.push(
          `${crate}/Cargo.toml [profile.release] ${key} is ${JSON.stringify(actual)}, expected ` +
            `${JSON.stringify(expected)} (the root profile does not apply to a workspace-excluded crate)`
        );
      }
    }
  }

  for (const [crate, roots] of Object.entries(repo.crateRoots)) {
    if (roots === null) {
      problems.push(`${crate}/Cargo.toml not found`);
      continue;
    }
    if (Object.keys(roots).length === 0) {
      problems.push(`${crate}: no crate root found (src/lib.rs, src/main.rs or a [[bin]] path)`);
    }
    for (const [file, source] of Object.entries(roots)) {
      if (source === null) {
        problems.push(`${crate}/${file}: [[bin]] path does not exist`);
      } else if (!hasNoPanicHeader(source)) {
        problems.push(
          `${crate}/${file}: missing the TOOL-010 header ` +
            "`#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]`"
        );
      }
    }
  }
  return problems;
}

/** @returns {string | null} file contents, or null if the file does not exist. */
function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Collect one crate's root sources: src/lib.rs and src/main.rs when present,
 * plus every `[[bin]] path` (null when that path is missing).
 *
 * @param {string} root - repository root.
 * @param {string} crate - crate directory relative to the root.
 * @returns {Record<string, string | null> | null} null when Cargo.toml is missing.
 */
function crateRootSources(root, crate) {
  const manifest = readOrNull(path.join(root, crate, "Cargo.toml"));
  if (manifest === null) return null;
  const roots = {};
  for (const file of ["src/lib.rs", "src/main.rs"]) {
    const source = readOrNull(path.join(root, crate, file));
    if (source !== null) roots[file] = source;
  }
  for (const file of binPaths(manifest)) {
    const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
    if (!(normalized in roots)) roots[normalized] = readOrNull(path.join(root, crate, normalized));
  }
  return roots;
}

/**
 * Load the repo view `findProblems` expects from disk.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const rootManifest = readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const standaloneManifests = Object.fromEntries(
    STANDALONE_CRATES.map((c) => [c, readOrNull(path.join(root, c, "Cargo.toml"))])
  );
  const crateRoots = Object.fromEntries(
    policyCrates(rootManifest).map((c) => [c, crateRootSources(root, c)])
  );
  return { rootManifest, standaloneManifests, crateRoots };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const repo = loadRepo(root);
  const problems = findProblems(repo);
  if (problems.length > 0) {
    console.error("First-party crate policy drift (ERR-010 / TOOL-010, see #4343):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const roots = Object.values(repo.crateRoots).reduce(
    (n, r) => n + (r === null ? 0 : Object.keys(r).length),
    0
  );
  console.log(
    `Crate policy: release overflow-checks/strip mirrored in ${STANDALONE_CRATES.join(", ")}; ` +
      `no-panic header on all ${roots} first-party crate roots.`
  );
}
