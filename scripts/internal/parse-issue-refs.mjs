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

/** A fenced code block delimiter: three or more backticks/tildes, up to 3 leading spaces. */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

/** A blockquote line: `>` after up to 3 leading spaces. */
const BLOCKQUOTE_LINE = /^ {0,3}>/;

/**
 * An inline code span: a run of backticks, then the shortest stretch that does
 * not contain that same run, then the matching run. Mirrors CommonMark closely
 * enough for PR prose; an unpaired backtick simply never matches.
 */
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*\1/g;

/** Words that negate a following closing keyword ("does not close #N"). */
const NEGATION = /\b(?:not|never|neither|nor|cannot|without|unless)\b|\w+n['’]t\b/i;

/**
 * How many words before the keyword are searched for a negation. Deliberately
 * short: English negation scope is not something a regex can truly resolve, so
 * we only claim the immediate, unambiguous cases ("does not close #N").
 */
const NEGATION_WINDOW_WORDS = 5;

/**
 * Blank out a stretch of text while preserving its length and line structure,
 * so masking never joins words across a removed region or shifts offsets.
 *
 * @param {string} chunk - Text to blank.
 * @returns {string} The same length, with everything but newlines replaced by spaces.
 */
function blank(chunk) {
  return chunk.replace(/[^\n]/g, " ");
}

/**
 * Mask the regions where a closing keyword is being *shown* rather than *used*:
 * fenced code blocks, blockquotes, and inline code spans.
 *
 * @param {string} text - Raw PR title/body.
 * @returns {string} Same-length text with those regions blanked out.
 */
function maskNonProse(text) {
  let inFence = false;
  const lines = text.split("\n").map((line) => {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      return blank(line);
    }
    if (inFence || BLOCKQUOTE_LINE.test(line)) {
      return blank(line);
    }
    return line;
  });

  // Code spans are resolved after fences so a fenced block's backticks cannot
  // pair up with prose backticks elsewhere in the body.
  return lines.join("\n").replace(CODE_SPAN, blank);
}

/**
 * Is the keyword at `index` directly negated by the words just before it?
 *
 * The lookback stops at the nearest sentence or line boundary, so a negation in
 * a previous sentence cannot suppress a later, genuine `Closes #N`.
 *
 * @param {string} text - Masked text being scanned.
 * @param {number} index - Start offset of the keyword match.
 * @returns {boolean} True when a negation sits within the preceding few words.
 */
function isNegated(text, index) {
  const sentence = text.slice(0, index).split(/[.!?;:\n]/).pop() ?? "";
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  return NEGATION.test(words.slice(-NEGATION_WINDOW_WORDS).join(" "));
}

/**
 * Extract the issue numbers a piece of text marks for closing.
 *
 * A keyword only counts when it is genuinely instructing a close. References
 * inside inline code spans, fenced code blocks, or blockquotes are ignored, as
 * is a keyword directly negated by the words in front of it. Backticks are the
 * reliable escape hatch when a PR body needs to *discuss* a reference —
 * negation handling is a best-effort convenience, not a guarantee.
 *
 * @param {string | null | undefined} text - PR title or body to scan.
 * @returns {number[]} Sorted, de-duplicated issue numbers (empty if none/invalid input).
 */
export function parseIssueRefs(text) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  const prose = maskNonProse(text);
  const numbers = new Set();
  for (const match of prose.matchAll(CLOSING_KEYWORD)) {
    if (isNegated(prose, match.index)) {
      continue;
    }
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
