#!/usr/bin/env node
// Prompt a README review when the plugin security model changes (MKT2-001, #4924).
//
// README.md's plugin trust warning restates what the plugin ADRs in
// docs/architecture.md and SECURITY.md's plugin sections promise. When one of
// those sections changes in a PR and README.md does not, the README claim may
// now be wrong. This script never fails: it prints a GitHub `::warning`
// annotation (and a step-summary note) naming the changed sections, so the
// author re-reads the README warning.
//
// Watched sections:
//   - docs/architecture.md: every `### ADR-…` whose heading mentions "plugin";
//   - SECURITY.md: every `##` section whose heading mentions "plugin".
//
// Usage: node scripts/internal/check-security-claim-trigger.mjs [--base <ref>] [--head <ref>]
// Defaults: --base HEAD^1 --head HEAD (the PR merge commit's first parent, as in
// the Detect Changed Areas job, which runs this on pull requests).

import { appendFileSync } from "fs";
import { execFileSync } from "child_process";
import { isMainModule } from "./is-main-module.mjs";

export const README = "README.md";

/**
 * Watched files → the heading level that delimits a section and the test a
 * section heading must pass to count.
 */
export const WATCHED = {
  "docs/architecture.md": { level: 3, matches: (h) => /^ADR-/.test(h) && /plugin/i.test(h) },
  "SECURITY.md": { level: 2, matches: (h) => /plugin/i.test(h) },
};

/**
 * Lines of the new file touched by a `git diff -U0` (a pure deletion counts as
 * the line it follows).
 *
 * @param {string} diff - unified diff output with zero context.
 * @returns {number[]} 1-based line numbers in the new file.
 */
export function changedLines(diff) {
  const lines = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) lines.push(Math.max(start, 1));
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

/**
 * The heading of the section (at `level` or above) that encloses each line.
 *
 * @param {string} text - the file's Markdown.
 * @param {number[]} lines - 1-based line numbers.
 * @param {number} level - the section heading level.
 * @returns {Set<string>} the headings (without `#`), "" for text before any.
 */
export function enclosingHeadings(text, lines, level) {
  const headingAt = [];
  let current = "";
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.*)$/);
    if (m && m[1].length <= level) current = m[2].trim();
    headingAt.push(current);
  }
  return new Set(lines.map((n) => headingAt[Math.min(n, headingAt.length) - 1] ?? ""));
}

/**
 * Find the watched security sections a change touched.
 *
 * @param {string[]} changedFiles - files the change touched.
 * @param {(file: string) => string} diffOf - `git diff -U0` of one file.
 * @param {(file: string) => string} contentOf - the file's new contents.
 * @returns {{ sections: string[], readmeChanged: boolean }}
 */
export function findTriggers(changedFiles, diffOf, contentOf) {
  const sections = [];
  for (const [file, { level, matches }] of Object.entries(WATCHED)) {
    if (!changedFiles.includes(file)) continue;
    const headings = enclosingHeadings(contentOf(file), changedLines(diffOf(file)), level);
    for (const heading of headings) if (matches(heading)) sections.push(`${file} → ${heading}`);
  }
  return { sections, readmeChanged: changedFiles.includes(README) };
}

/**
 * The note to print, or null when nothing needs a review.
 *
 * @param {{ sections: string[], readmeChanged: boolean }} result
 * @returns {string | null}
 */
export function reviewNote({ sections, readmeChanged }) {
  if (sections.length === 0 || readmeChanged) return null;
  return (
    `Plugin security sections changed without a README.md change: ${sections.join("; ")}. ` +
    "Re-read README.md's plugin trust warning and update it if a claim no longer holds (#4924)."
  );
}

// CLI mode. Advisory: any error is reported and the exit code stays 0.
if (isMainModule(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : fallback;
  };
  const base = arg("--base", "HEAD^1");
  const head = arg("--head", "HEAD");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" });
  try {
    const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
    const result = findTriggers(
      changed,
      (file) => git("diff", "-U0", base, head, "--", file),
      (file) => git("show", `${head}:${file}`)
    );
    const note = reviewNote(result);
    if (note === null) {
      console.log(
        result.sections.length
          ? "Plugin security sections changed together with README.md."
          : "No plugin security section changed."
      );
    } else if (process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Review README security claims::${note}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Review README security claims\n\n${note}\n`
        );
      }
    } else {
      console.log(`WARNING: ${note}`);
    }
  } catch (error) {
    console.log(`Security-claim trigger skipped: ${error.message.split("\n")[0]}`);
  }
}
