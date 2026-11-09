#!/usr/bin/env node
// Keep the marketing drafts' "Last verified" stamps honest (MKT2-003, #4924).
//
// docs/marketing/*.md are review drafts that get folded into README.md and
// CHANGELOG.md at release time. Each one carries a stamp naming the commit it
// was last checked against:
//
//   > Last verified against `develop` at `652dff95f` (2026-10-24).
//
// Default mode (check.sh / CI, vitest): every draft must carry exactly one
// well-formed stamp, so the release-time check below always has something to
// compare.
//
// --release (release-check.sh / .cmd, a WARNING there): additionally list every
// draft whose stamped commit is behind HEAD (ignoring commits that touch only
// docs/marketing/) or unknown to this clone, so the drafts are re-verified
// against the app before they are folded in. Exits 1 when any draft is stale.
//
// Usage: node scripts/internal/check-marketing-drafts.mjs [--release] [--root <repo-dir>]

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MARKETING_DIR = "docs/marketing";

/** The stamp line. Captures the branch, the commit and the date. */
const STAMP_RE = /Last verified against `([^`]+)` at `([0-9a-f]{7,40})` \((\d{4}-\d{2}-\d{2})\)/g;

/**
 * Parse a draft's "Last verified" stamps.
 *
 * @param {string} text - the draft's Markdown.
 * @returns {{ branch: string, sha: string, date: string }[]}
 */
export function parseStamps(text) {
  return [...text.matchAll(STAMP_RE)].map((m) => ({ branch: m[1], sha: m[2], date: m[3] }));
}

/**
 * Check one draft's stamp.
 *
 * @param {string} file - repo-relative path, for messages.
 * @param {string} text - the draft's Markdown.
 * @returns {string[]} problems.
 */
export function checkStamp(file, text) {
  const stamps = parseStamps(text);
  if (stamps.length === 1) return [];
  if (stamps.length === 0) {
    return [
      `${file}: no "Last verified against \`<branch>\` at \`<sha>\` (YYYY-MM-DD)." stamp — ` +
        "add one after checking the draft against the app",
    ];
  }
  return [`${file}: ${stamps.length} "Last verified" stamps — keep exactly one`];
}

/**
 * Decide whether a stamped commit is behind HEAD.
 *
 * @param {string} sha - the stamped commit.
 * @param {(args: string[]) => string | null} git - runs git, returns stdout or null on failure.
 * @returns {string | null} why it is stale, or null when it is HEAD.
 */
export function staleReason(sha, git) {
  const full = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (full === null) return `commit ${sha} is unknown to this clone`;
  // The stamp cannot name the commit that adds it, so commits that touch only
  // the drafts themselves do not count.
  const behind = git([
    "rev-list",
    "--count",
    `${full.trim()}..HEAD`,
    "--",
    ".",
    `:(exclude)${MARKETING_DIR}`,
  ]);
  if (behind === null) return `cannot compare ${sha} with HEAD`;
  const n = Number(behind.trim());
  return n > 0 ? `verified at ${sha}; ${n} later commit(s) outside ${MARKETING_DIR}/` : null;
}

/**
 * List the drafts under `root`.
 *
 * @param {string} root - repository root.
 * @returns {string[]} repo-relative paths.
 */
export function listDrafts(root) {
  const dir = path.join(root, MARKETING_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => `${MARKETING_DIR}/${f}`);
}

/**
 * Check every draft under `root`.
 *
 * @param {string} root - repository root.
 * @param {{ release?: boolean, git?: (args: string[]) => string | null }} [options]
 * @returns {{ problems: string[], stale: string[], drafts: number }}
 */
export function checkRepo(root, { release = false, git = runGit(root) } = {}) {
  const problems = [];
  const stale = [];
  const drafts = listDrafts(root);
  for (const file of drafts) {
    const text = readFileSync(path.join(root, file), "utf8");
    const own = checkStamp(file, text);
    problems.push(...own);
    if (!release || own.length) continue;
    const reason = staleReason(parseStamps(text)[0].sha, git);
    if (reason) stale.push(`${file}: ${reason}`);
  }
  return { problems, stale, drafts: drafts.length };
}

/** A `git` runner rooted at `root`. */
function runGit(root) {
  return (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    } catch {
      return null;
    }
  };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const release = process.argv.includes("--release");
  const { problems, stale, drafts } = checkRepo(root, { release });
  if (problems.length > 0) {
    console.error(
      "Marketing draft stamp problems (see scripts/internal/check-marketing-drafts.mjs):"
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error("Marketing drafts not re-verified against this commit:");
    for (const line of stale) console.error(`  - ${line}`);
    console.error(
      `Re-check them against the app and update their "Last verified" stamps before folding ` +
        `them into README.md / CHANGELOG.md (docs/contributing.md → Pre-Release Checklist).`
    );
    process.exit(1);
  }
  console.log(
    release
      ? `${drafts} marketing draft(s) verified against HEAD.`
      : `${drafts} marketing draft(s) carry one "Last verified" stamp each.`
  );
}
