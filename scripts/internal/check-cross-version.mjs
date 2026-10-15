#!/usr/bin/env node
// Keep the cross-rs pin in exactly one place (#4360, WA-CI2-006).
//
// Single source of truth: `.github/cross-version`, holding `version=X.Y.Z` and
// `sha256=<64 hex>` (the SHA256 of that release's
// cross-x86_64-unknown-linux-gnu.tar.gz). Two readers use it: the
// `.github/actions/setup-cross` composite action (every CI job that installs
// cross-rs) and `scripts/internal/build-system-test-agent.sh --install-cross`.
// Before #4360 the version + hash were copied into agent.yml, dev-build.yml,
// release.yml and that script with nothing keeping them in step. This check
// fails if:
//
//   1. `.github/cross-version` is missing or lacks a valid version/sha256 line;
//   2. either reader no longer reads `.github/cross-version`;
//   3. any other workflow, composite action or script downloads a cross-rs
//      release itself, or a workflow / the script hard-codes a CROSS_VERSION or
//      CROSS_SHA256 value — a duplicated pin that would drift.
//
// Sibling of check-uv-version.mjs and check-rust-version.mjs.
// Bump procedure: docs/contributing.md -> "cross-rs version".
//
// Usage: node scripts/internal/check-cross-version.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-cross-version.test.mjs).

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The pin file, relative to the repo root. */
export const PIN_FILE = ".github/cross-version";
/** The composite action that installs cross-rs on CI. */
export const WRAPPER_ACTION = ".github/actions/setup-cross/action.yml";
/** The local/CI script that installs cross-rs for the system-test agent build. */
export const AGENT_SCRIPT = "scripts/internal/build-system-test-agent.sh";

/** A direct download of a cross-rs release binary. */
const RELEASE_DOWNLOAD = /github\.com\/cross-rs\/cross\/releases\/download/;
/** A hard-coded value for CROSS_VERSION / CROSS_SHA256 (env: or shell assignment). */
const HARDCODED_PIN = /\bCROSS_(?:VERSION|SHA256)\s*[:=]\s*['"]?[0-9a-f.]{3,}/;

/**
 * Parse the pin file's contents.
 *
 * @param {string | null | undefined} text - contents of `.github/cross-version`.
 * @returns {{ version: string, sha256: string } | null} the pin, or null if malformed.
 */
export function parsePin(text) {
  if (typeof text !== "string") return null;
  const value = (key) => {
    const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim() : null;
  };
  const version = value("version");
  const sha256 = value("sha256");
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { version, sha256 };
}

/**
 * Find lines that pin cross-rs outside the pin file.
 *
 * @param {Record<string, string>} files - path -> text.
 * @param {{ allowDownload?: boolean }} [options] - allowDownload: only flag
 *   hard-coded values, not the download itself (for a reader of the pin file).
 * @returns {string[]} `path:line` for each duplicated pin.
 */
export function duplicatedPins(files, { allowDownload = false } = {}) {
  const hits = [];
  for (const [name, text] of Object.entries(files)) {
    text.split(/\r?\n/).forEach((line, index) => {
      if ((!allowDownload && RELEASE_DOWNLOAD.test(line)) || HARDCODED_PIN.test(line)) {
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
 * @param {string | null} repo.pinFile - `.github/cross-version` contents.
 * @param {string | null} repo.wrapperAction - the setup-cross composite action YAML.
 * @param {string | null} repo.agentScript - build-system-test-agent.sh contents.
 * @param {Record<string, string>} repo.files - workflows, other actions, scripts.
 * @returns {string[]} human-readable problems; empty when consistent.
 */
export function findProblems(repo) {
  const problems = [];
  if (parsePin(repo.pinFile) === null) {
    problems.push(
      `${PIN_FILE} must hold a version=X.Y.Z line and a sha256=<64 lowercase hex> line, got ${JSON.stringify(
        repo.pinFile
      )}`
    );
  }

  if (repo.wrapperAction === null) {
    problems.push(`${WRAPPER_ACTION} not found`);
  } else if (!repo.wrapperAction.includes("cross-version")) {
    problems.push(`${WRAPPER_ACTION} must read the pin from ${PIN_FILE}`);
  }

  if (repo.agentScript === null) {
    problems.push(`${AGENT_SCRIPT} not found`);
  } else {
    if (!repo.agentScript.includes(PIN_FILE)) {
      problems.push(`${AGENT_SCRIPT} must read the pin from ${PIN_FILE}`);
    }
    const script = { [AGENT_SCRIPT]: repo.agentScript };
    for (const hit of duplicatedPins(script, { allowDownload: true })) {
      problems.push(`${hit}: hard-codes a cross-rs pin — read it from ${PIN_FILE}`);
    }
  }

  for (const hit of duplicatedPins(repo.files)) {
    problems.push(
      `${hit}: pins or downloads cross-rs itself — use ./.github/actions/setup-cross so the ` +
        `pin in ${PIN_FILE} applies`
    );
  }
  return problems;
}

/** @returns {string | null} file contents, or null if the file does not exist. */
function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Add every file in `dir` (non-recursive) whose name matches `pattern`. */
function addDir(files, root, dir, pattern) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return;
  for (const f of readdirSync(abs).filter((f) => pattern.test(f))) {
    const rel = `${dir}/${f}`;
    if (rel === AGENT_SCRIPT) continue;
    files[rel] = readFileSync(path.join(abs, f), "utf8");
  }
}

/**
 * Load the repo view `findProblems` expects from disk.
 *
 * @param {string} root - repository root.
 */
export function loadRepo(root) {
  const files = {};
  addDir(files, root, ".github/workflows", /\.ya?ml$/);
  const actionsDir = path.join(root, ".github", "actions");
  for (const dir of existsSync(actionsDir) ? readdirSync(actionsDir) : []) {
    for (const name of ["action.yml", "action.yaml"]) {
      const rel = `.github/actions/${dir}/${name}`;
      if (rel === WRAPPER_ACTION) continue;
      const text = readOrNull(path.join(root, rel));
      if (text !== null) files[rel] = text;
    }
  }
  addDir(files, root, "scripts", /\.(sh|cmd|ps1)$/);
  addDir(files, root, "scripts/internal", /\.(sh|cmd|ps1)$/);
  return {
    pinFile: readOrNull(path.join(root, PIN_FILE)),
    wrapperAction: readOrNull(path.join(root, WRAPPER_ACTION)),
    agentScript: readOrNull(path.join(root, AGENT_SCRIPT)),
    files,
  };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const repo = loadRepo(root);
  const problems = findProblems(repo);
  if (problems.length > 0) {
    console.error("cross-rs pin drift (see docs/contributing.md -> cross-rs version):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `cross-rs ${parsePin(repo.pinFile).version}: pinned once in ${PIN_FILE} ` +
      `(setup-cross action + build-system-test-agent.sh).`
  );
}
