#!/usr/bin/env node
// Forbid `cfg!(test)` in non-test Rust code (#5163).
//
// `cfg!(test)` in production code makes the tested binary differ from the
// shipped one: the branch a unit test runs is not the branch a user runs.
// That hid the sealed backup-restore apply path from every test (#5163). Inject
// the choice instead — a constructor argument, a flag or a trait — and test
// both arms.
//
// The check scans every `.rs` file of the repo (skipping `target/`,
// `node_modules/` and dot directories) and fails on a `cfg!(...)` whose
// predicate names `test` (`cfg!(test)`, `cfg!(not(test))`,
// `cfg!(any(test, ...))`) unless it is in test-only code:
//
//   - a test file: `tests.rs`, `*_tests.rs`, `*_test.rs`, or anything under a
//     `tests/`, `test_support/` or `benches/` directory;
//   - the body of an inline `#[cfg(test)] mod ... { }` block.
//
// The attribute form `#[cfg(test)]` is not affected: it compiles code out of
// the shipped binary, it does not fork the shipped code's behaviour.
//
// ALLOWED lists the documented exceptions, each by file and enclosing
// function. An entry that no longer matches fails too, so the list shrinks as
// soon as an exception is injected.
//
// Usage: node scripts/internal/check-no-cfg-test.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-no-cfg-test.test.mjs),
// which also runs the check against the real repo so CI enforces it.

import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Documented exceptions: `cfg!(test)` uses in non-test code that are allowed
 * until they are injected too.
 */
export const ALLOWED = [
  {
    file: "agent/src/handler/dispatch.rs",
    fn: "docker_probe_skipped",
    reason: "unit tests skip the Docker probe (CI-013, #3350)",
  },
];

/** Directory names never scanned. */
const SKIPPED_DIRS = new Set(["target", "node_modules"]);

/** Directory names whose contents are test-only code. */
const TEST_DIRS = new Set(["tests", "test_support", "benches"]);

/**
 * Whether a file is test-only code.
 *
 * @param {string} rel - path relative to the repo root, `/`-separated.
 * @returns {boolean}
 */
export function isTestFile(rel) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  return /(?:^|_)tests?\.rs$/.test(base) || parts.slice(0, -1).some((p) => TEST_DIRS.has(p));
}

/**
 * Blank out comments and string/char literals, keeping every newline and the
 * length of each line, so offsets and line numbers stay valid.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCommentsAndStrings(text) {
  let out = "";
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === "r" && /^r#*"/.test(text.slice(i, i + 258)) && !/\w/.test(text[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(text.slice(i))[1];
      const close = `"${hashes}`;
      const start = i + 2 + hashes.length;
      const end = text.indexOf(close, start);
      const stop = end === -1 ? text.length : end + close.length;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += blank(text.slice(i, j + 1));
      i = j + 1;
    } else if (c === "'" && /^'(?:\\.|[^\\'\n])'/.test(text.slice(i, i + 4))) {
      // A char literal such as '{' (not a lifetime such as 'a).
      const m = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(i));
      out += blank(m[0]);
      i += m[0].length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The `[start, end)` offsets of every `#[cfg(test)] mod name { ... }` body.
 *
 * @param {string} code - source with comments and strings blanked.
 * @returns {Array<[number, number]>}
 */
export function testModuleRanges(code) {
  const ranges = [];
  const re =
    /#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < code.length && depth > 0) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") depth--;
      j++;
    }
    ranges.push([m.index, j]);
  }
  return ranges;
}

/**
 * Every `cfg!(...)` whose predicate names `test`, outside inline test modules.
 *
 * @param {string} text - the Rust source.
 * @returns {Array<{line: number, fn: string | null, predicate: string}>}
 */
export function findCfgTest(text) {
  const code = stripCommentsAndStrings(text);
  const ranges = testModuleRanges(code);
  const hits = [];
  const re = /\bcfg!\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < code.length && depth > 0) {
      if (code[j] === "(") depth++;
      else if (code[j] === ")") depth--;
      j++;
    }
    const start = m.index + m[0].length;
    // Match on the blanked text (a string such as "test-hooks" never counts),
    // report the original.
    if (!/\btest\b/.test(code.slice(start, j - 1))) continue;
    const predicate = text.slice(start, j - 1).trim();
    if (ranges.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const before = code.slice(0, m.index);
    const fns = [...before.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
    hits.push({
      line: before.split("\n").length,
      fn: fns.length > 0 ? fns[fns.length - 1][1] : null,
      predicate,
    });
  }
  return hits;
}

/**
 * Every `.rs` file under `root`, relative and `/`-separated.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listRustFiles(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(childRel);
    }
  };
  walk(root, "");
  return files.sort();
}

/**
 * Check every non-test Rust file of the repo at `root`.
 *
 * @param {string} root
 * @param {typeof ALLOWED} [allowed]
 * @returns {{problems: string[], scanned: number}}
 */
export function checkRepo(root, allowed = ALLOWED) {
  const problems = [];
  const used = new Set();
  const files = listRustFiles(root).filter((rel) => !isTestFile(rel));
  for (const rel of files) {
    for (const hit of findCfgTest(readFileSync(path.join(root, rel), "utf8"))) {
      const entry = allowed.findIndex((a) => a.file === rel && a.fn === hit.fn);
      if (entry !== -1) {
        used.add(entry);
        continue;
      }
      problems.push(
        `${rel}:${hit.line}: \`cfg!(${hit.predicate})\` in non-test code` +
          (hit.fn ? ` (fn ${hit.fn})` : "") +
          " — inject a flag or trait instead (#5163)"
      );
    }
  }
  allowed.forEach((a, i) => {
    if (!used.has(i)) {
      problems.push(
        `stale allow-list entry ${a.file} (fn ${a.fn}): no \`cfg!(test)\` there any more — ` +
          "remove it from ALLOWED"
      );
    }
  });
  if (files.length === 0) problems.push("no Rust source files found");
  return { problems, scanned: files.length };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { problems, scanned } = checkRepo(root);
  if (problems.length > 0) {
    console.error("cfg!(test) in non-test code (see scripts/internal/check-no-cfg-test.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `No cfg!(test) in ${scanned} non-test Rust file(s) outside the ${ALLOWED.length} documented exception(s).`
  );
}
