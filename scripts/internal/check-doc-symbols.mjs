#!/usr/bin/env node
// Verify the symbol-based code references in opted-in docs (DOC2-008, #4369).
//
// Some docs ("current, authoritative reference" docs such as
// docs/session-lifecycle-state-machine.md) cite code as `file` → `Symbol`
// instead of `file:line`, so the reference survives code moving inside the
// file. This check keeps that promise honest. For every opted-in doc it fails
// when:
//
//   1. a cited `file` → `Symbol` pair names a file that does not exist, or a
//      symbol that is not defined (or re-exported) in that file. `Type::item`
//      checks both halves; a bare file name (`store.rs`) resolves to the one
//      full path with that base name cited elsewhere in the same doc;
//   2. the doc carries a `file:line` anchor again (`foo.rs:42`), which is the
//      drift-prone form this check replaces.
//
// Sibling of check-invoke-contract.mjs / scripts/check-testid-drift.py.
//
// Usage: node scripts/internal/check-doc-symbols.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-doc-symbols.test.mjs),
// which also runs the check against the real repo so CI enforces it.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Docs whose code references must be symbol-based and resolvable. */
export const CHECKED_DOCS = ["docs/session-lifecycle-state-machine.md"];

/** Source extensions a reference may point at. */
const SOURCE_EXT = "(?:rs|ts|tsx|mjs|js|py)";

/** `` `path/to/file.rs` → `Symbol` `` (the arrow may be `→` or `->`). */
const REFERENCE_RE = new RegExp(
  "`([A-Za-z0-9_./-]+\\." +
    SOURCE_EXT +
    ")`\\s*(?:→|->)\\s*`([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)`",
  "g"
);

/** A drift-prone `file.ext:line` anchor. */
const LINE_ANCHOR_RE = new RegExp("[A-Za-z0-9_-]+\\." + SOURCE_EXT + ":\\d+", "g");

/**
 * Extract every `file` → `Symbol` reference from a doc.
 *
 * @param {string} text - the doc's Markdown.
 * @returns {{ file: string, symbol: string, line: number }[]}
 */
export function extractReferences(text) {
  const refs = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(REFERENCE_RE)) {
      refs.push({ file: match[1], symbol: match[2], line: index + 1 });
    }
  });
  return refs;
}

/**
 * Find `file:line` anchors in a doc.
 *
 * @param {string} text - the doc's Markdown.
 * @returns {{ anchor: string, line: number }[]}
 */
export function findLineAnchors(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(LINE_ANCHOR_RE)) {
      hits.push({ anchor: match[0], line: index + 1 });
    }
  });
  return hits;
}

/**
 * Resolve a cited file to a repo path. A path containing `/` is taken as is;
 * a bare base name resolves to the unique full path with that base name cited
 * in the same doc.
 *
 * @param {string} file - the cited file.
 * @param {string[]} fullPaths - every full path cited in the doc.
 * @returns {string | null} the repo-relative path, or null if ambiguous/unknown.
 */
export function resolveFile(file, fullPaths) {
  if (file.includes("/")) return file;
  const matches = [...new Set(fullPaths.filter((p) => path.posix.basename(p) === file))];
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Whether `name` is defined or re-exported in `source`.
 *
 * @param {string} source - the file's contents.
 * @param {string} name - one path segment of the cited symbol.
 * @returns {boolean}
 */
export function definesSymbol(source, name) {
  const n = name.replace(/[$]/g, "\\$&");
  const patterns = [
    // Rust items, incl. `pub(crate)`, `async fn`, generics.
    `\\b(?:fn|struct|enum|trait|type|const|static|mod|union)\\s+${n}\\b`,
    // Rust re-export / import: `use a::b::Name;` or `use a::{X, Name}`.
    `\\buse\\s[^;]*\\b${n}\\b[^;]*;`,
    // TS / JS / Python declarations.
    `\\b(?:function|class|interface|let|var|def)\\s+${n}\\b`,
    `\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:const|type|enum)\\s+${n}\\b`,
  ];
  return patterns.some((p) => new RegExp(p).test(source));
}

/**
 * Check one doc against the repo.
 *
 * @param {string} docPath - repo-relative doc path (for messages).
 * @param {string} text - the doc's Markdown.
 * @param {(rel: string) => string | null} readSource - returns a file's text, or null.
 * @returns {string[]} problems, empty when the doc is clean.
 */
export function checkDoc(docPath, text, readSource) {
  const problems = [];
  for (const { anchor, line } of findLineAnchors(text)) {
    problems.push(
      `${docPath}:${line}: drift-prone line anchor \`${anchor}\` — cite \`file\` → \`Symbol\` instead`
    );
  }
  const refs = extractReferences(text);
  const fullPaths = refs.map((r) => r.file).filter((f) => f.includes("/"));
  for (const { file, symbol, line } of refs) {
    const resolved = resolveFile(file, fullPaths);
    if (resolved === null) {
      problems.push(
        `${docPath}:${line}: cannot resolve \`${file}\` — cite its full path once in this doc`
      );
      continue;
    }
    const source = readSource(resolved);
    if (source === null) {
      problems.push(`${docPath}:${line}: \`${resolved}\` does not exist`);
      continue;
    }
    for (const part of symbol.split("::")) {
      if (!definesSymbol(source, part)) {
        problems.push(
          `${docPath}:${line}: \`${part}\` (from \`${symbol}\`) is not defined in \`${resolved}\``
        );
      }
    }
  }
  return problems;
}

/**
 * Check every opted-in doc under `root`.
 *
 * @param {string} root - repository root.
 * @param {string[]} [docs] - repo-relative docs to check.
 * @returns {{ problems: string[], references: number }}
 */
export function checkRepo(root, docs = CHECKED_DOCS) {
  const readSource = (rel) => {
    const abs = path.join(root, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };
  const problems = [];
  let references = 0;
  for (const doc of docs) {
    const text = readSource(doc);
    if (text === null) {
      problems.push(`${doc}: opted-in doc does not exist`);
      continue;
    }
    references += extractReferences(text).length;
    problems.push(...checkDoc(doc, text, readSource));
  }
  return { problems, references };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { problems, references } = checkRepo(root);
  if (problems.length > 0) {
    console.error("Doc code-reference drift (see scripts/internal/check-doc-symbols.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `${references} symbol reference(s) in ${CHECKED_DOCS.length} doc(s) resolve; no line anchors.`
  );
}
