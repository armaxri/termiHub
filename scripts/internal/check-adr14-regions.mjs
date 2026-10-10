#!/usr/bin/env node
// Verify ADR-14's projection-region list against the code (#4586).
//
// The ADR-14 "Status" paragraph in docs/architecture.md names every backend
// projection region: the shared ones seeded at boot (`tunnels`, `agents`, ...)
// and the client-scoped ones created on first subscribe (`layout@<clientId>`,
// ...). That list drifted once already (it missed `plugin-sandbox`). This check
// fails when:
//
//   1. a region the code registers is not named in the paragraph, or
//   2. the paragraph names a region the code does not register.
//
// The code side is extracted, not hard-coded:
//
//   - shared regions: every `*_REGION` constant (or string literal) passed to
//     `register_region` / `publish_with` in non-test `src-tauri/src` code, a
//     constant resolved through its `const NAME: &str = "value";` definition;
//   - client-scoped regions: every `fn *_region(client_id: &str) -> String`
//     whose body is `format!("<domain>@{client_id}")`.
//
// Test-only regions (`diag.counter`, seeded only by the test-bridge build) are
// excluded on both sides.
//
// Sibling of check-doc-symbols.mjs.
//
// Usage: node scripts/internal/check-adr14-regions.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-adr14-regions.test.mjs),
// which also runs the check against the real repo so CI enforces it.

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The doc that carries the ADR-14 region list. */
export const ARCHITECTURE_DOC = "docs/architecture.md";

/** The Rust source tree the regions are registered in. */
export const SOURCE_DIR = "src-tauri/src";

/** Regions that exist only in test builds and are not part of the ADR list. */
export const TEST_ONLY_REGIONS = ["diag.counter"];

/** `register_region(` / `publish_with(` whose first argument is a `*_REGION` const. */
const REGISTER_CALL_RE =
  /\b(?:register_region|publish_with)\s*\(\s*&?\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Z][A-Z0-9_]*_REGION)\b/g;

/** `register_region("literal", ...)` / `publish_with("literal", ...)`. */
const REGISTER_LITERAL_RE = /\b(?:register_region|publish_with)\s*\(\s*"([^"]+)"/g;

/** `const NAME_REGION: &str = "value";` (any visibility). */
const REGION_CONST_RE =
  /\bconst\s+([A-Z][A-Z0-9_]*_REGION)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"/g;

/** `fn x_region(client_id: &str) -> String { format!("domain@{client_id}") }`. */
const CLIENT_REGION_FN_RE =
  /\bfn\s+[a-z0-9_]+_region\s*\(\s*([a-z_][a-z0-9_]*)\s*:\s*&str\s*\)\s*->\s*String\s*\{\s*format!\(\s*"([a-z0-9.-]+)@\{([a-z_][a-z0-9_]*)\}"\s*\)/g;

/** A shared region named in the doc: a backticked lowercase kebab-case word. */
const DOC_SHARED_RE = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g;

/** A client-scoped region named in the doc: `` `domain@<clientId>` ``. */
const DOC_CLIENT_RE = /`([a-z][a-z0-9.-]*)@<clientId>`/g;

/**
 * Whether a source file is test-only code and must not contribute regions.
 *
 * @param {string} rel - path relative to the source dir, `/`-separated.
 * @returns {boolean}
 */
export function isTestFile(rel) {
  const base = path.posix.basename(rel);
  return (
    /(?:^|_)tests?\.rs$/.test(base) ||
    rel.split("/").some((part) => part === "tests" || part === "test_support")
  );
}

/**
 * Extract the shared regions registered in a set of Rust sources.
 *
 * @param {Record<string, string>} sources - path → file contents.
 * @returns {{ regions: string[], problems: string[] }}
 */
export function extractSharedRegions(sources) {
  /** const name → set of string values */
  const consts = new Map();
  /** const names passed to register_region / publish_with, with a call site */
  const used = new Map();
  /** string literals passed directly */
  const literals = new Set();
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(REGION_CONST_RE)) {
      if (!consts.has(m[1])) consts.set(m[1], new Set());
      consts.get(m[1]).add(m[2]);
    }
    if (isTestFile(file)) continue;
    for (const m of text.matchAll(REGISTER_CALL_RE)) {
      if (!used.has(m[1])) used.set(m[1], file);
    }
    for (const m of text.matchAll(REGISTER_LITERAL_RE)) literals.add(m[1]);
  }
  const problems = [];
  const regions = new Set(literals);
  for (const [name, file] of used) {
    const values = consts.get(name);
    if (!values) {
      problems.push(`${file}: \`${name}\` is registered but no \`const ${name}: &str\` defines it`);
    } else if (values.size > 1) {
      problems.push(`\`${name}\` has conflicting definitions: ${[...values].join(", ")}`);
    } else {
      regions.add([...values][0]);
    }
  }
  return { regions: [...regions].sort(), problems };
}

/**
 * Extract the client-scoped region domains (`layout` for `layout@<clientId>`).
 *
 * @param {Record<string, string>} sources - path → file contents.
 * @returns {string[]}
 */
export function extractClientRegions(sources) {
  const regions = new Set();
  for (const [file, text] of Object.entries(sources)) {
    if (isTestFile(file)) continue;
    for (const m of text.matchAll(CLIENT_REGION_FN_RE)) {
      // The formatted placeholder must be the function's own parameter.
      if (m[1] === m[3]) regions.add(m[2]);
    }
  }
  return [...regions].sort();
}

/**
 * Find the ADR-14 status paragraph (the one opening with `**Status:`).
 *
 * @param {string} doc - the architecture doc's Markdown.
 * @returns {{ text: string, line: number } | null}
 */
export function findStatusParagraph(doc) {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s+ADR-14:/.test(l));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) return null; // next section, no status found
    if (lines[i].startsWith("**Status:")) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
      return { text: lines.slice(i, end + 1).join("\n"), line: i + 1 };
    }
  }
  return null;
}

/**
 * Extract the regions the status paragraph names.
 *
 * @param {string} paragraph - the status paragraph.
 * @returns {{ shared: string[], client: string[] }}
 */
export function extractDocRegions(paragraph) {
  const shared = new Set([...paragraph.matchAll(DOC_SHARED_RE)].map((m) => m[1]));
  const client = new Set([...paragraph.matchAll(DOC_CLIENT_RE)].map((m) => m[1]));
  for (const t of TEST_ONLY_REGIONS) {
    shared.delete(t);
    client.delete(t);
  }
  return { shared: [...shared].sort(), client: [...client].sort() };
}

/**
 * Compare the code's regions with the doc's.
 *
 * @param {{ shared: string[], client: string[] }} code
 * @param {{ shared: string[], client: string[] }} doc
 * @param {string} where - `doc:line` prefix for messages.
 * @returns {string[]} problems
 */
export function compareRegions(code, doc, where) {
  const problems = [];
  const codeShared = code.shared.filter((r) => !TEST_ONLY_REGIONS.includes(r));
  const diff = (label, from, to, msg) => {
    for (const r of from) if (!to.includes(r)) problems.push(`${where}: ${label} \`${r}\` ${msg}`);
  };
  diff("shared region", codeShared, doc.shared, "is registered in code but missing from ADR-14");
  diff("shared region", doc.shared, codeShared, "is named in ADR-14 but not registered in code");
  const codeClient = code.client.map((r) => `${r}@<clientId>`);
  const docClient = doc.client.map((r) => `${r}@<clientId>`);
  diff("client-scoped region", codeClient, docClient, "exists in code but is missing from ADR-14");
  diff("client-scoped region", docClient, codeClient, "is named in ADR-14 but not defined in code");
  return problems;
}

/** Read every `.rs` file under `dir` into a path → text map (paths relative, `/`-separated). */
function readRustSources(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.name.endsWith(".rs")) out[childRel] = readFileSync(childAbs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Run the whole check against a repo.
 *
 * @param {string} root - repository root.
 * @returns {{ problems: string[], shared: string[], client: string[] }}
 */
export function checkRepo(root) {
  const docAbs = path.join(root, ARCHITECTURE_DOC);
  const srcAbs = path.join(root, SOURCE_DIR);
  if (!existsSync(docAbs))
    return { problems: [`${ARCHITECTURE_DOC} does not exist`], shared: [], client: [] };
  if (!existsSync(srcAbs))
    return { problems: [`${SOURCE_DIR} does not exist`], shared: [], client: [] };

  const sources = readRustSources(srcAbs);
  const extracted = extractSharedRegions(sources);
  const problems = extracted.problems;
  const shared = extracted.regions.filter((r) => !TEST_ONLY_REGIONS.includes(r));
  const client = extractClientRegions(sources);
  // An empty side means the extraction no longer matches the code's shape —
  // fail loudly rather than pass vacuously.
  if (shared.length === 0)
    problems.push(`no \`*_REGION\` passed to register_region found in ${SOURCE_DIR}`);
  if (client.length === 0) problems.push(`no client-scoped \`fn *_region\` found in ${SOURCE_DIR}`);

  const status = findStatusParagraph(readFileSync(docAbs, "utf8"));
  if (status === null) {
    problems.push(`${ARCHITECTURE_DOC}: no \`**Status:\` paragraph found under ADR-14`);
    return { problems, shared, client };
  }
  const where = `${ARCHITECTURE_DOC}:${status.line}`;
  problems.push(...compareRegions({ shared, client }, extractDocRegions(status.text), where));
  return { problems, shared, client };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { problems, shared, client } = checkRepo(root);
  if (problems.length > 0) {
    console.error("ADR-14 region list drift (see scripts/internal/check-adr14-regions.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `ADR-14 names all ${shared.length} shared and ${client.length} client-scoped projection region(s).`
  );
}
