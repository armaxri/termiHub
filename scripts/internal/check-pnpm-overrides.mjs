#!/usr/bin/env node
// Keep package.json `pnpm.overrides` documented and free of dead entries
// (WA-CI-020, SUP-008).
//
// Every override force-resolves a transitive dependency to an advisory-patched
// version. Undocumented, they rot: nobody knows which advisory a pin answers or
// when it can go. The register lives in docs/supply-chain.md ("Override
// register" table). This check fails if:
//
//   1. an override in package.json has no row in the register;
//   2. a register row names an override that package.json no longer has;
//   3. an override is dead — its target package (or, for a scoped
//      `parent>child` / `parent@major>child` key, its parent) no longer appears
//      in pnpm-lock.yaml, so it constrains nothing and should be removed.
//
// Usage: node scripts/internal/check-pnpm-overrides.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-pnpm-overrides.test.mjs).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The doc holding the register, relative to the repo root. */
export const REGISTER_DOC = "docs/supply-chain.md";

/** Heading of the register section inside REGISTER_DOC. */
const REGISTER_HEADING = "## Override register";

/**
 * Extract the override keys documented in the register table.
 *
 * @param {string} markdown - contents of docs/supply-chain.md.
 * @returns {string[] | null} keys in table order, or null if the section is missing.
 */
export function documentedOverrides(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === REGISTER_HEADING);
  if (start === -1) return null;
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * Split an override key into the package it pins and an optional parent selector.
 *
 * @param {string} key - e.g. "dompurify", "vite>picomatch", "minimatch@3>brace-expansion".
 * @returns {{ target: string, parent: { name: string, major: string | null } | null }}
 */
export function parseOverrideKey(key) {
  const segments = key.split(">");
  const target = segments[segments.length - 1];
  if (segments.length === 1) return { target, parent: null };
  const parentSpec = segments[segments.length - 2];
  const at = parentSpec.lastIndexOf("@");
  if (at > 0) {
    return { target, parent: { name: parentSpec.slice(0, at), major: parentSpec.slice(at + 1) } };
  }
  return { target, parent: { name: parentSpec, major: null } };
}

/**
 * Collect the resolved `name@version` package ids listed in a pnpm lockfile.
 *
 * @param {string} lockfile - pnpm-lock.yaml text (v9 layout).
 * @returns {Array<{ name: string, version: string }>}
 */
export function lockedPackages(lockfile) {
  const out = [];
  let inPackages = false;
  for (const line of lockfile.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === "packages:";
      continue;
    }
    if (!inPackages) continue;
    const match = /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^(:'\s]+)/.exec(line);
    if (match) out.push({ name: match[1], version: match[2] });
  }
  return out;
}

/**
 * Whether the lockfile contains a package matching name (and optional major).
 *
 * @param {Array<{ name: string, version: string }>} locked
 * @param {string} name
 * @param {string | null} [major]
 */
function isLocked(locked, name, major = null) {
  return locked.some(
    (p) => p.name === name && (major === null || p.version.split(".")[0] === major)
  );
}

/**
 * Run every rule against an in-memory view of the repo.
 *
 * @param {object} repo
 * @param {Record<string, string>} repo.overrides - package.json pnpm.overrides.
 * @param {string} repo.registerDoc - docs/supply-chain.md contents.
 * @param {string} repo.lockfile - pnpm-lock.yaml contents.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(repo) {
  const problems = [];
  const keys = Object.keys(repo.overrides);
  const documented = documentedOverrides(repo.registerDoc);
  if (documented === null) {
    return [`${REGISTER_DOC} has no "${REGISTER_HEADING}" section`];
  }

  for (const key of keys) {
    if (!documented.includes(key)) {
      problems.push(
        `override "${key}" has no row in ${REGISTER_DOC} — add its advisory and removal condition`
      );
    }
  }
  for (const key of documented) {
    if (!keys.includes(key)) {
      problems.push(`${REGISTER_DOC} documents "${key}" but package.json has no such override`);
    }
  }

  const locked = lockedPackages(repo.lockfile);
  for (const key of keys) {
    const { target, parent } = parseOverrideKey(key);
    if (!isLocked(locked, target)) {
      problems.push(`override "${key}" is dead: ${target} is not in pnpm-lock.yaml — remove it`);
    } else if (parent !== null && !isLocked(locked, parent.name, parent.major)) {
      const label = parent.major === null ? parent.name : `${parent.name}@${parent.major}`;
      problems.push(`override "${key}" is dead: no ${label} in pnpm-lock.yaml — remove it`);
    }
  }
  return problems;
}

/**
 * Load the repo view `findProblems` expects from disk.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return {
    overrides: manifest.pnpm?.overrides ?? {},
    registerDoc: readFileSync(path.join(root, REGISTER_DOC), "utf8"),
    lockfile: readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"),
  };
}

// CLI mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const repo = loadRepo(root);
  const problems = findProblems(repo);
  if (problems.length > 0) {
    console.error(`pnpm.overrides drift (see ${REGISTER_DOC}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `${Object.keys(repo.overrides).length} pnpm overrides: all documented in ${REGISTER_DOC}, none dead.`
  );
}
