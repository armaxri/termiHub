#!/usr/bin/env node
// Keep the vendored-fork register and the untrusted-input parser watchlist honest
// (SUP-005, SUP-012). Offline and dependency-free; runs in the Vendored Forks
// workflow whenever vendor/**, a lockfile or docs/supply-chain.md changes.
//
// Vendored forks (vendor/vendored-forks.json). Fails if:
//
//   1. a directory under a vendor root (vendor/, rdp-sidecar/vendor/) has no
//      register entry, or an entry points at a directory that does not exist;
//   2. an entry is missing a required field (upstream repo, base version/commit,
//      reviewed version/commit, at least one delta with a link, crates.io name);
//   3. the fork's Cargo.toml `[package]` name/version differ from the entry's
//      crate / base_version — a re-base must update the register too;
//   4. the fork's README.md does not record its fork base: the base version,
//      the base commit and the upstream repository URL.
//
// Parser watchlist (docs/supply-chain.md, "Untrusted-input parser watchlist"
// table). Fails if:
//
//   5. a row's crate has no locked version on the documented semver-compatible
//      line in the named lockfile(s) — i.e. a manifest bump left the doc stale
//      (`cargo update` stays on the line, so the weekly lockfile chore never
//      trips this);
//   6. a row's "1.0?" cell disagrees with the documented line;
//   7. a registered fork is missing from the watchlist (every fork parses
//      untrusted input — that is why it is tracked).
//
// Usage: node scripts/internal/check-vendored-forks.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-vendored-forks.test.mjs).

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The fork register, relative to the repo root. */
export const MANIFEST = "vendor/vendored-forks.json";

/** Directories whose immediate subdirectories are vendored crates. */
export const VENDOR_ROOTS = ["vendor", "rdp-sidecar/vendor"];

/** The doc holding the watchlist, relative to the repo root. */
export const WATCHLIST_DOC = "docs/supply-chain.md";

/** Heading of the watchlist section inside WATCHLIST_DOC. */
export const WATCHLIST_HEADING = "## Untrusted-input parser watchlist";

/** Lockfiles a watchlist row may name. */
export const LOCKFILES = ["Cargo.lock", "rdp-sidecar/Cargo.lock"];

const REQUIRED_FIELDS = [
  "path",
  "crate",
  "upstream_repo",
  "upstream_branch",
  "base_version",
  "base_commit",
  "reviewed_version",
  "reviewed_commit",
];

/**
 * Read `name` and `version` from the `[package]` table of a Cargo.toml.
 *
 * @param {string} toml - Cargo.toml text.
 * @returns {{ name: string | null, version: string | null }}
 */
export function cargoPackage(toml) {
  const out = { name: null, version: null };
  let inPackage = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const match = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (match && out[match[1]] === null) out[match[1]] = match[2];
  }
  return out;
}

/**
 * Map crate name -> every locked version in a Cargo.lock.
 *
 * @param {string} lockfile - Cargo.lock text.
 * @returns {Map<string, string[]>}
 */
export function lockedVersions(lockfile) {
  const out = new Map();
  let name = null;
  for (const raw of lockfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      name = null;
      continue;
    }
    const nameMatch = /^name = "([^"]+)"$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }
    const versionMatch = /^version = "([^"]+)"$/.exec(line);
    if (versionMatch && name !== null) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(versionMatch[1]);
      name = null;
    }
  }
  return out;
}

/**
 * Whether a documented line is a valid semver-compatible prefix: `0.y`
 * (or longer) for pre-1.0 crates, `x` (or longer) from 1.0 on.
 *
 * @param {string} line - e.g. "0.61", "11", "0.5.3".
 * @returns {boolean}
 */
export function isValidLine(line) {
  if (!/^\d+(\.\d+){0,2}$/.test(line)) return false;
  const parts = line.split(".");
  return parts[0] !== "0" || parts.length >= 2;
}

/**
 * Whether a concrete version sits on a documented compatible line.
 *
 * @param {string} version - e.g. "0.61.1".
 * @param {string} line - e.g. "0.61".
 * @returns {boolean}
 */
export function onLine(version, line) {
  const core = version.split(/[-+]/)[0];
  return core === line || core.startsWith(`${line}.`);
}

/**
 * Parse the watchlist table.
 *
 * Columns: Crate | Line | Lockfile | Parses | 1.0? | Hardening | Tests.
 * Only the first five are machine-read; the rest are prose.
 *
 * @param {string} markdown - contents of docs/supply-chain.md.
 * @returns {Array<{ crate: string, line: string, lockfiles: string[], stable: string }> | null}
 *   rows in table order, or null if the section is missing.
 */
export function watchlistRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === WATCHLIST_HEADING);
  if (start === -1) return null;
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    const match = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const cells = match[2].split("|").map((cell) => cell.trim());
    rows.push({
      crate: match[1],
      line: (cells[0] ?? "").replace(/`/g, ""),
      lockfiles: (cells[1] ?? "")
        .replace(/`/g, "")
        .split(/[\s,]+/)
        .filter(Boolean),
      stable: (cells[3] ?? "").toLowerCase(),
    });
  }
  return rows;
}

/**
 * Compute every problem in the register and the watchlist.
 *
 * @param {object} repo
 * @param {{ forks: object[] }} repo.manifest - parsed vendored-forks.json.
 * @param {string[]} repo.vendorDirs - vendored crate dirs on disk (repo-relative).
 * @param {Map<string, { cargoToml: string | null, readme: string | null }>} repo.forkFiles
 *   per registered path: its Cargo.toml and README.md text (null when absent).
 * @param {string} repo.doc - docs/supply-chain.md text.
 * @param {Map<string, Map<string, string[]>>} repo.locks - lockfile path -> locked versions.
 * @returns {string[]} human-readable problems; empty when everything is consistent.
 */
export function findProblems({ manifest, vendorDirs, forkFiles, doc, locks }) {
  const problems = [];
  const forks = Array.isArray(manifest?.forks) ? manifest.forks : [];
  if (forks.length === 0) problems.push(`${MANIFEST} has no "forks" entries.`);

  const registered = new Set(forks.map((fork) => fork.path));
  for (const dir of vendorDirs) {
    if (!registered.has(dir)) {
      problems.push(`${dir}: vendored directory has no entry in ${MANIFEST}.`);
    }
  }

  for (const fork of forks) {
    const label = fork.path ?? "(entry without path)";
    for (const field of REQUIRED_FIELDS) {
      if (typeof fork[field] !== "string" || fork[field].trim() === "") {
        problems.push(`${label}: register entry is missing "${field}".`);
      }
    }
    for (const field of ["base_commit", "reviewed_commit"]) {
      if (typeof fork[field] === "string" && !/^[0-9a-f]{40}$/.test(fork[field])) {
        problems.push(`${label}: "${field}" must be a full 40-hex commit sha.`);
      }
    }
    if (typeof fork.watch?.crates_io !== "string" || fork.watch.crates_io === "") {
      problems.push(`${label}: register entry is missing "watch.crates_io".`);
    }
    const deltas = Array.isArray(fork.deltas) ? fork.deltas : [];
    if (deltas.length === 0) {
      problems.push(`${label}: register entry lists no "deltas" (what the fork changes).`);
    }
    for (const delta of deltas) {
      if (!delta.summary || !Array.isArray(delta.refs) || delta.refs.length === 0) {
        problems.push(`${label}: every delta needs a "summary" and at least one link in "refs".`);
        break;
      }
    }
    for (const ack of fork.acknowledged_advisories ?? []) {
      if (!ack?.id || !ack?.reason) {
        problems.push(`${label}: every acknowledged advisory needs an "id" and a "reason".`);
        break;
      }
    }

    const files = forkFiles.get(fork.path);
    if (!files || (files.cargoToml === null && files.readme === null)) {
      problems.push(`${label}: registered fork directory does not exist.`);
      continue;
    }
    if (files.cargoToml === null) {
      problems.push(`${label}: fork has no Cargo.toml.`);
    } else {
      const pkg = cargoPackage(files.cargoToml);
      if (pkg.name !== fork.crate) {
        problems.push(
          `${label}: Cargo.toml name is "${pkg.name}", register says crate "${fork.crate}".`
        );
      }
      if (pkg.version !== fork.base_version) {
        problems.push(
          `${label}: Cargo.toml version is "${pkg.version}", register says base_version ` +
            `"${fork.base_version}" — update the register when re-basing the fork.`
        );
      }
    }
    if (files.readme === null) {
      problems.push(`${label}: fork has no README.md recording its fork base.`);
    } else {
      for (const [what, needle] of [
        ["base version", fork.base_version],
        ["base commit", fork.base_commit],
        ["upstream repository URL", fork.upstream_repo],
      ]) {
        if (needle && !files.readme.includes(needle)) {
          problems.push(`${label}: README.md does not record the ${what} (${needle}).`);
        }
      }
    }
  }

  const rows = watchlistRows(doc);
  if (rows === null) {
    problems.push(`${WATCHLIST_DOC} has no "${WATCHLIST_HEADING}" section.`);
    return problems;
  }
  if (rows.length === 0) problems.push(`${WATCHLIST_DOC}: the parser watchlist table is empty.`);

  for (const row of rows) {
    const label = `watchlist \`${row.crate}\``;
    if (!isValidLine(row.line)) {
      problems.push(
        `${label}: line "${row.line}" is not a semver-compatible line ` +
          `(use 0.y for pre-1.0 crates, x from 1.0 on).`
      );
      continue;
    }
    const expectStable = !row.line.startsWith("0.");
    if (!["yes", "no"].includes(row.stable)) {
      problems.push(`${label}: "1.0?" cell must be "yes" or "no".`);
    } else if ((row.stable === "yes") !== expectStable) {
      problems.push(`${label}: "1.0?" says "${row.stable}" but line ${row.line} says otherwise.`);
    }
    if (row.lockfiles.length === 0) {
      problems.push(`${label}: names no lockfile.`);
    }
    for (const lockPath of row.lockfiles) {
      const locked = locks.get(lockPath);
      if (!locked) {
        problems.push(
          `${label}: unknown lockfile "${lockPath}" (expected ${LOCKFILES.join(" or ")}).`
        );
        continue;
      }
      const versions = locked.get(row.crate) ?? [];
      if (versions.length === 0) {
        problems.push(`${label}: not in ${lockPath} — drop the row or fix the lockfile column.`);
      } else if (!versions.some((version) => onLine(version, row.line))) {
        problems.push(
          `${label}: documented line ${row.line}, but ${lockPath} locks ${versions.join(", ")} ` +
            `— update the watchlist row (and re-review the crate).`
        );
      }
    }
  }

  const watched = new Set(rows.map((row) => row.crate));
  for (const fork of forks) {
    if (fork.crate && !watched.has(fork.crate)) {
      problems.push(`watchlist: registered fork \`${fork.crate}\` has no watchlist row.`);
    }
  }
  return problems;
}

/**
 * Read everything findProblems needs from a checkout.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const readOrNull = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8"));

  const vendorDirs = [];
  for (const vendorRoot of VENDOR_ROOTS) {
    const abs = path.join(root, vendorRoot);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs).sort()) {
      if (statSync(path.join(abs, entry)).isDirectory()) vendorDirs.push(`${vendorRoot}/${entry}`);
    }
  }

  const forkFiles = new Map();
  for (const fork of manifest.forks ?? []) {
    if (typeof fork.path !== "string") continue;
    forkFiles.set(fork.path, {
      cargoToml: readOrNull(path.join(root, fork.path, "Cargo.toml")),
      readme: readOrNull(path.join(root, fork.path, "README.md")),
    });
  }

  const locks = new Map();
  for (const lockPath of LOCKFILES) {
    const text = readOrNull(path.join(root, lockPath));
    if (text !== null) locks.set(lockPath, lockedVersions(text));
  }

  const doc = readFileSync(path.join(root, WATCHLIST_DOC), "utf8");
  return { manifest, vendorDirs, forkFiles, doc, locks };
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? DEFAULT_ROOT : path.resolve(argv[rootFlag + 1]);
  const problems = findProblems(loadRepo(root));
  if (problems.length > 0) {
    console.error("Vendored-fork register / parser watchlist check failed:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\nSee ${WATCHLIST_DOC} ("Vendored forks" and "${WATCHLIST_HEADING.slice(3)}").`);
    return 1;
  }
  console.log("Vendored-fork register and parser watchlist are consistent.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
