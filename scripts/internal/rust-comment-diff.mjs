/**
 * Decide whether a change to one Rust source file touches only comment lines
 * (#3903), so the slim PR lane can treat it like a docs change: `cargo fmt` +
 * Rustdoc instead of the whole Rust test/build matrix.
 *
 * A change is comment-only when EVERY changed line (removed lines of the old
 * file and added lines of the new file) is a whole-line `//` comment, i.e. the
 * line's first non-blank text is `//`, `///` or `//!` in code context. A code
 * line, including code with a trailing comment, makes the change a code change.
 *
 * FAIL-OPEN BY DESIGN: every doubt answers "not comment-only", which keeps the
 * full Rust classification. In particular:
 *   - A `//` line inside a string literal or a block comment is NOT a comment
 *     line: a small lexer tracks strings, raw strings, char literals and nested
 *     block comments across the whole file.
 *   - A doc-comment line inside a fenced code block (or a fence line itself) is
 *     a doctest, which `cargo test --doc` runs, so it counts as code.
 *   - A file that uses ts-rs copies its doc comments into the generated
 *     TypeScript (src/types/generated), whose staleness gate lives in the Rust
 *     job, so any change to it counts as code.
 *   - An added, deleted or renamed file, an unparseable diff, or a diff with no
 *     changed lines counts as code.
 */

/** Doc-comment prefixes whose text rustdoc renders (and whose fences are doctests). */
const isDocMarker = (trimmed) =>
  (trimmed.startsWith("///") && !trimmed.startsWith("////")) || trimmed.startsWith("//!");

const isIdentChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * Which lines of a Rust source start in code context (not inside a string
 * literal or block comment).
 * @param {string} source
 * @returns {boolean[]} one entry per line (split on "\n").
 */
export function lineStartsInCode(source) {
  const chars = Array.from(source);
  const result = [];
  // state: "code" | "block" | "string" | "raw"
  let state = "code";
  let blockDepth = 0;
  let rawHashes = 0;
  let atLineStart = true;

  for (let i = 0; i <= chars.length; i++) {
    if (atLineStart) {
      result.push(state === "code");
      atLineStart = false;
    }
    if (i === chars.length) break;
    const ch = chars[i];
    const next = chars[i + 1];

    if (ch === "\n") {
      atLineStart = true;
      continue;
    }

    if (state === "block") {
      if (ch === "/" && next === "*") {
        blockDepth++;
        i++;
      } else if (ch === "*" && next === "/") {
        blockDepth--;
        i++;
        if (blockDepth === 0) state = "code";
      }
      continue;
    }

    if (state === "string") {
      if (ch === "\\") {
        // Skip the escaped char, but keep a line-continuation newline visible.
        if (next !== "\n") i++;
      } else if (ch === '"') {
        state = "code";
      }
      continue;
    }

    if (state === "raw") {
      if (ch === '"') {
        let n = 0;
        while (n < rawHashes && chars[i + 1 + n] === "#") n++;
        if (n === rawHashes) {
          i += n;
          state = "code";
        }
      }
      continue;
    }

    // state === "code"
    if (ch === "/" && next === "/") {
      // Line comment: skip to the end of the line.
      while (i + 1 < chars.length && chars[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      i++;
      continue;
    }
    if (ch === '"') {
      state = "string";
      continue;
    }
    if (ch === "r" && (next === '"' || next === "#")) {
      // r"..." / r#"..."# (also br / cr prefixes), but not an identifier's
      // trailing r (`for"` is not Rust) and not a raw identifier (`r#type`).
      const prev = chars[i - 1];
      const prefixed = (prev === "b" || prev === "c") && !isIdentChar(chars[i - 2]);
      if (!isIdentChar(prev) || prefixed) {
        let n = 0;
        while (chars[i + 1 + n] === "#") n++;
        if (chars[i + 1 + n] === '"') {
          state = "raw";
          rawHashes = n;
          i += 1 + n;
          continue;
        }
      }
    }
    if (ch === "'") {
      if (next === "\\") {
        // Escaped char literal ('\n', '\'', '\u{1F600}'): find the closing quote.
        let j = i + 3;
        while (j < chars.length && chars[j] !== "'" && chars[j] !== "\n") j++;
        i = j;
      } else if (next !== undefined && next !== "\n" && chars[i + 2] === "'") {
        i += 2; // 'x'
      }
      // Otherwise a lifetime or loop label ('a, 'outer): nothing to skip.
      continue;
    }
  }
  return result;
}

/**
 * Which lines are whole-line comments that are safe to treat as docs: first
 * non-blank text is `//` in code context, and not part of a fenced code block
 * (doctest) inside a doc comment.
 * @param {string} source
 * @returns {boolean[]} one entry per line.
 */
export function commentOnlyLines(source) {
  const lines = source.split("\n");
  const inCode = lineStartsInCode(source);
  const result = [];
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isComment = inCode[i] === true && trimmed.startsWith("//");
    if (!isComment) {
      // Real code ends any doc block (rustdoc closes an open fence there too).
      // Blank lines and attributes can sit inside an item's docs, so they don't.
      if (trimmed !== "" && !trimmed.startsWith("#")) fenceOpen = false;
      result.push(false);
      continue;
    }
    if (!isDocMarker(trimmed)) {
      result.push(true);
      continue;
    }
    const text = trimmed.slice(3).trim();
    const isFence = text.startsWith("```") || text.startsWith("~~~");
    if (isFence) fenceOpen = !fenceOpen;
    result.push(!isFence && !fenceOpen);
  }
  return result;
}

/**
 * Parse the hunk headers of a `git diff -U0` for one file into the 1-based line
 * numbers removed from the old file and added to the new one.
 * @param {string} diff
 * @returns {{ removed: number[], added: number[] } | null} null when unparseable
 *   or when the diff is not a plain in-place modification.
 */
export function changedLineNumbers(diff) {
  const removed = [];
  const added = [];
  let hunks = 0;
  for (const line of diff.split("\n")) {
    if (
      /^(new file|deleted file|rename from|rename to|similarity index|Binary files|old mode|new mode)/.test(
        line
      )
    ) {
      return null;
    }
    if (!line.startsWith("@@")) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) return null;
    hunks++;
    const [oldStart, oldCount, newStart, newCount] = [
      Number(m[1]),
      m[2] === undefined ? 1 : Number(m[2]),
      Number(m[3]),
      m[4] === undefined ? 1 : Number(m[4]),
    ];
    for (let k = 0; k < oldCount; k++) removed.push(oldStart + k);
    for (let k = 0; k < newCount; k++) added.push(newStart + k);
  }
  if (hunks === 0 || removed.length + added.length === 0) return null;
  return { removed, added };
}

/** ts-rs copies doc comments into the generated TypeScript bindings. */
const usesTsRs = (source) => /\bts_rs\b|\bts\s*\(\s*export\b/.test(source);

/**
 * @param {string} oldSource the file at the PR base
 * @param {string} newSource the file at the PR head
 * @param {string} diff `git diff -U0` of this one file between the two
 * @returns {boolean} true only when every changed line is a whole-line comment.
 */
export function isCommentOnlyChange(oldSource, newSource, diff) {
  if (typeof oldSource !== "string" || typeof newSource !== "string") return false;
  if (usesTsRs(oldSource) || usesTsRs(newSource)) return false;
  const changed = changedLineNumbers(diff);
  if (changed === null) return false;
  const oldMask = commentOnlyLines(oldSource);
  const newMask = commentOnlyLines(newSource);
  return (
    changed.removed.every((n) => oldMask[n - 1] === true) &&
    changed.added.every((n) => newMask[n - 1] === true)
  );
}
