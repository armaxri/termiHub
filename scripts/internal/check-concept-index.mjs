#!/usr/bin/env node
// Keep docs/concepts/README.md in step with the concept files (MKT2-008, #4924).
//
// The concept index is a hand-written table per status folder. It drifts two
// ways: a new concept lands without a row, or a concept moves/is renamed and the
// row keeps pointing at the old path. This check fails when:
//
//   1. a concept file `docs/concepts/<status>/<name>.html` is not linked from the
//      README;
//   2. the README links a relative path (file or folder) that does not exist;
//   3. a concept is linked under the wrong `## <status>/` section (for example a
//      `backlog/x.html` row in the `## implemented/` table).
//
// Sibling of check-doc-symbols.mjs / check-adr14-regions.mjs.
//
// Usage: node scripts/internal/check-concept-index.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-concept-index.test.mjs),
// which also runs the check against the real repo so CI enforces it.

import { existsSync, readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The concept folder, relative to the repo root. */
export const CONCEPTS_DIR = "docs/concepts";

/** Status folders that hold concepts (see docs/concepts/README.md). */
export const STATUS_DIRS = ["implemented", "partial", "backlog", "future"];

/** A Markdown inline link `[text](target)`. */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Extract every relative link from the index, with the `## <status>/` section
 * it sits under (null before the first status heading).
 *
 * @param {string} text - the README's Markdown.
 * @returns {{ target: string, section: string | null, line: number }[]}
 */
export function extractLinks(text) {
  const links = [];
  let section = null;
  let inFence = false;
  text.split(/\r?\n/).forEach((lineText, index) => {
    if (/^\s*(```|~~~)/.test(lineText)) inFence = !inFence;
    if (inFence) return;
    const heading = lineText.match(/^##\s+([a-z-]+)\/\s*$/);
    if (heading) {
      section = heading[1];
      return;
    }
    if (/^##\s/.test(lineText)) section = null;
    for (const match of lineText.matchAll(LINK_RE)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      links.push({ target, section, line: index + 1 });
    }
  });
  return links;
}

/**
 * Check the index against the concept files.
 *
 * @param {string} readme - the README's Markdown.
 * @param {string[]} concepts - concept paths relative to docs/concepts (`implemented/x.html`).
 * @param {(rel: string) => boolean} exists - whether a docs/concepts-relative path exists.
 * @returns {string[]} problems, empty when the index is clean.
 */
export function checkIndex(readme, concepts, exists) {
  const problems = [];
  const where = `${CONCEPTS_DIR}/README.md`;
  const links = extractLinks(readme);
  const linked = new Set();
  for (const { target, section, line } of links) {
    const rel = path.posix.normalize(target.split("#")[0]);
    linked.add(rel);
    if (!exists(rel)) {
      problems.push(`${where}:${line}: links \`${target}\`, which does not exist`);
      continue;
    }
    const status = rel.split("/")[0];
    if (section && STATUS_DIRS.includes(status) && rel.endsWith(".html") && status !== section) {
      problems.push(
        `${where}:${line}: \`${rel}\` is listed under \`## ${section}/\` but lives in \`${status}/\``
      );
    }
  }
  for (const concept of concepts) {
    if (!linked.has(concept)) {
      problems.push(
        `${where}: concept \`${concept}\` is not linked — add a row to its \`## ${concept.split("/")[0]}/\` table`
      );
    }
  }
  return problems;
}

/**
 * List the concept files under `root`.
 *
 * @param {string} root - repository root.
 * @returns {string[]} paths relative to docs/concepts, sorted.
 */
export function listConcepts(root) {
  const out = [];
  for (const status of STATUS_DIRS) {
    const dir = path.join(root, CONCEPTS_DIR, status);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".html")) out.push(`${status}/${entry.name}`);
    }
  }
  return out.sort();
}

/**
 * Check the real index under `root`.
 *
 * @param {string} root - repository root.
 * @returns {{ problems: string[], concepts: number }}
 */
export function checkRepo(root) {
  const readmePath = path.join(root, CONCEPTS_DIR, "README.md");
  if (!existsSync(readmePath)) {
    return { problems: [`${CONCEPTS_DIR}/README.md does not exist`], concepts: 0 };
  }
  const concepts = listConcepts(root);
  const exists = (rel) => existsSync(path.join(root, CONCEPTS_DIR, rel));
  const problems = checkIndex(readFileSync(readmePath, "utf8"), concepts, exists);
  return { problems, concepts: concepts.length };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { problems, concepts } = checkRepo(root);
  if (problems.length > 0) {
    console.error("Concept index drift (see scripts/internal/check-concept-index.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${concepts} concept(s) all linked from ${CONCEPTS_DIR}/README.md; no dead links.`);
}
