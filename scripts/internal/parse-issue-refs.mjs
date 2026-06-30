#!/usr/bin/env node
// Parse GitHub issue-closing references ("Closes #N", "Fixes #N", "Resolves #N",
// and their variants) out of a pull-request title/body.
//
// GitHub only auto-closes referenced issues when a PR merges into the
// repository default branch (`main`). Because termiHub merges day-to-day work
// into `develop`, those issues would otherwise linger open. The
// `auto-close-issues` workflow uses this parser to reproduce GitHub's behaviour
// for `develop`-targeted PRs.
//
// The parsing logic lives here (rather than inline in the workflow YAML) so it
// can be unit-tested — see parse-issue-refs.test.mjs.

/**
 * The full set of GitHub issue-closing keywords, matched case-insensitively.
 * Mirrors https://docs.github.com/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]*#(\d+)/gi;

/**
 * Extract the issue numbers a piece of text marks for closing.
 *
 * @param {string | null | undefined} text - PR title or body to scan.
 * @returns {number[]} Sorted, de-duplicated issue numbers (empty if none/invalid input).
 */
export function parseIssueRefs(text) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  const numbers = new Set();
  for (const match of text.matchAll(CLOSING_KEYWORD)) {
    numbers.add(Number.parseInt(match[1], 10));
  }

  return [...numbers].sort((a, b) => a - b);
}

// CLI mode: read PR_TITLE and PR_BODY from the environment and print one issue
// number per line on stdout so the workflow can iterate over them in bash.
if (import.meta.url === `file://${process.argv[1]}`) {
  const combined = `${process.env.PR_TITLE ?? ""}\n${process.env.PR_BODY ?? ""}`;
  for (const num of parseIssueRefs(combined)) {
    process.stdout.write(`${num}\n`);
  }
}
