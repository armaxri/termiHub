#!/usr/bin/env node
// Pre-release crate tripwire (SUP-002).
//
// The SSH stack (russh 0.61) and the rdp-sidecar's IronRDP stack pull a set of
// pre-release RustCrypto / Dalek crates. That set is an accepted, documented
// risk (deny.toml [bans], #2074) — but only the *reviewed* set. Nothing else
// stopped a new `-rc`/`-pre` crate, or a bump to a different pre-release,
// from landing in a lockfile unreviewed. This check does.
//
// It parses `Cargo.lock` and `rdp-sidecar/Cargo.lock` and fails if:
//
//   1. a locked crate version carries a semver pre-release part (a `-` before
//      any `+build` metadata, e.g. `0.10.0-rc.18`) and that exact
//      `name@version` is not in `.github/prerelease-allowlist.json`;
//   2. an allowlist entry matches no locked crate any more (stale) — so the
//      list shrinks as russh / IronRDP move to stable releases (#3734);
//   3. an allowlist entry is malformed (missing reason / tracker, or a version
//      that is not actually a pre-release).
//
// Build metadata alone (`toml 1.1.2+spec-1.1.0`) is NOT a pre-release.
//
// To accept a new pre-release: add `{ name, version, reason, tracker }` to the
// allowlist in the same PR that changes the lockfile, so the bump is reviewed.
//
// Usage: node scripts/internal/check-prerelease-crates.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-prerelease-crates.test.mjs).

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Lockfiles checked, repo-relative. */
export const LOCKFILES = ["Cargo.lock", "rdp-sidecar/Cargo.lock"];

/** The committed reviewed set, repo-relative. */
export const ALLOWLIST_PATH = ".github/prerelease-allowlist.json";

/**
 * Whether a semver version string has a pre-release part.
 *
 * Build metadata (after `+`) is stripped first, so `0.4.0+wasi-0.3.0-rc` is a
 * release while `0.10.0-rc.18` and `1.0.0-rc.1+build` are pre-releases.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isPrerelease(version) {
  const core = version.split("+", 1)[0];
  return core.includes("-");
}

/**
 * Extract `{ name, version }` for every `[[package]]` in a Cargo.lock.
 *
 * @param {string} text - Cargo.lock contents.
 * @returns {{ name: string, version: string }[]}
 */
export function parseLockfile(text) {
  const packages = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      if (current && current.name && current.version) packages.push(current);
      current = {};
      continue;
    }
    if (line.startsWith("[")) {
      if (current && current.name && current.version) packages.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const match = /^(name|version)\s*=\s*"([^"]*)"$/.exec(line);
    if (match) current[match[1]] = match[2];
  }
  if (current && current.name && current.version) packages.push(current);
  return packages;
}

/**
 * Compare the locked pre-releases against the allowlist.
 *
 * @param {Record<string, string | null>} lockfiles - repo-relative path -> contents (null = missing).
 * @param {unknown} allowlist - parsed allowlist JSON.
 * @returns {string[]} human-readable problems; empty when the check passes.
 */
export function findProblems(lockfiles, allowlist) {
  const problems = [];
  const entries =
    allowlist && typeof allowlist === "object" && Array.isArray(allowlist.crates)
      ? allowlist.crates
      : null;
  if (entries === null) {
    return [`${ALLOWLIST_PATH} must be an object with a "crates" array`];
  }

  const allowed = new Map();
  for (const [i, entry] of entries.entries()) {
    const where = `${ALLOWLIST_PATH} crates[${i}]`;
    if (!entry || typeof entry.name !== "string" || typeof entry.version !== "string") {
      problems.push(`${where}: needs string "name" and "version"`);
      continue;
    }
    const key = `${entry.name}@${entry.version}`;
    if (!isPrerelease(entry.version)) {
      problems.push(`${where} (${key}): version is not a pre-release — remove the entry`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`${where} (${key}): needs a non-empty "reason"`);
    }
    if (typeof entry.tracker !== "string" || !/^#\d+$/.test(entry.tracker)) {
      problems.push(`${where} (${key}): "tracker" must be an issue reference like "#1234"`);
    }
    if (allowed.has(key)) problems.push(`${where}: duplicate entry ${key}`);
    allowed.set(key, entry);
  }

  const seen = new Set();
  for (const [file, text] of Object.entries(lockfiles)) {
    if (text === null) {
      problems.push(`${file} not found`);
      continue;
    }
    for (const { name, version } of parseLockfile(text)) {
      if (!isPrerelease(version)) continue;
      const key = `${name}@${version}`;
      seen.add(key);
      if (!allowed.has(key)) {
        problems.push(
          `${file}: pre-release ${key} is not in the reviewed set — add it to ` +
            `${ALLOWLIST_PATH} with a reason and tracker, or pin a stable release`
        );
      }
    }
  }

  for (const key of allowed.keys()) {
    if (!seen.has(key)) {
      problems.push(
        `${ALLOWLIST_PATH}: ${key} is no longer in any lockfile — remove the stale entry`
      );
    }
  }
  return problems;
}

/**
 * Load the lockfiles and allowlist from disk.
 *
 * @param {string} root - repository root.
 * @returns {{ lockfiles: Record<string, string | null>, allowlist: unknown }}
 */
export function loadRepo(root) {
  const lockfiles = Object.fromEntries(
    LOCKFILES.map((file) => {
      const full = path.join(root, file);
      return [file, existsSync(full) ? readFileSync(full, "utf8") : null];
    })
  );
  const allowlistFile = path.join(root, ALLOWLIST_PATH);
  let allowlist = null;
  if (existsSync(allowlistFile)) {
    try {
      allowlist = JSON.parse(readFileSync(allowlistFile, "utf8"));
    } catch {
      allowlist = null;
    }
  }
  return { lockfiles, allowlist };
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { lockfiles, allowlist } = loadRepo(root);
  const problems = findProblems(lockfiles, allowlist);
  if (problems.length > 0) {
    console.error("Pre-release crate tripwire (SUP-002):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const count = allowlist.crates.length;
  console.log(
    `Pre-release crates: all ${count} locked pre-release versions in ` +
      `${LOCKFILES.join(" + ")} are in the reviewed set (${ALLOWLIST_PATH}).`
  );
}
