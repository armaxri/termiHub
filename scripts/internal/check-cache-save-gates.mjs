#!/usr/bin/env node
// Keep every GitHub Actions cache save gated to develop and main (#5328).
//
// The repo's Actions caches share one 10 GB budget, and LRU eviction drops the
// oldest entries once it is full. The #3328 reader/writer split says every ref
// restores but only develop and main save: a feature-branch or PR entry is
// dead weight after merge, and it pushes develop's own entries out. Gating on
// `github.event_name != 'pull_request'` is not enough, because a
// `workflow_dispatch` proof run on a feature branch has that branch as
// `github.ref`. That gap filled the budget with 1+ GB feature-branch Rust
// caches on 2026-11-11.
//
// So every cache-saving step in a workflow or composite action must carry the
// gate `github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main'`,
// written exactly like that. It may be ANDed with other conditions, as in
// `inputs.x == 'true' && (<gate>)`, but never ORed:
//
//   - Swatinem/rust-cache: `save-if:` set to the gate, or to `false`;
//   - actions/cache: a step `if:` with the gate (the step restores AND saves,
//     so pair it with an actions/cache/restore step for the other refs);
//   - actions/cache/save: a step `if:` with the gate;
//   - astral-sh/setup-uv: `save-cache:` set to the gate, or to `false`;
//   - actions/setup-node: no `cache:` input at all. It saves on every ref and
//     has no save switch; use `./.github/actions/setup-pnpm` with `cache: "true"`.
//
// Usage: node scripts/internal/check-cache-save-gates.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-cache-save-gates.test.mjs).
// See docs/contributing.md -> "GitHub Actions caches".

import { fileURLToPath } from "url";
import path from "path";
import { loadFiles } from "./check-action-pins.mjs";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one accepted spelling of the develop/main save gate. */
export const GATE = "github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main'";

/** `uses: <action>@<ref>`, list or mapping form. */
const USES_LINE = /^(\s*)(-\s+)?uses:\s*['"]?([^\s'"@]+)@/;

const indentOf = (line) => line.length - line.trimStart().length;
const isBlankOrComment = (line) => line.trim() === "" || line.trim().startsWith("#");

/**
 * Read a mapping value starting at `lines[index]` (`key: value`), following a
 * `>-` / `|` block scalar onto its more-indented lines.
 *
 * @returns {string} the value, its lines joined by single spaces.
 */
export function readValue(lines, index) {
  const line = lines[index];
  const inline = line.slice(line.indexOf(":") + 1).trim();
  if (!/^[>|][-+]?$/.test(inline)) return inline;
  const parts = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= indentOf(line)) break;
    parts.push(lines[i].trim());
  }
  return parts.join(" ");
}

/**
 * Collect every step that uses an action, with its step-level keys and its
 * `with:` inputs.
 *
 * @param {Record<string, string>} files - path -> YAML text.
 * @returns {{ action: string, where: string, keys: Record<string, string>, inputs: Record<string, string> }[]}
 */
export function collectSteps(files) {
  const steps = [];
  for (const [name, text] of Object.entries(files)) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(USES_LINE);
      if (!match) return;
      const action = match[3];
      // The step's keys sit at `keyIndent`; its `- ` sits two columns left.
      const keyIndent = match[1].length + (match[2] ? match[2].length : 0);
      let start = index;
      if (!match[2]) {
        while (
          start > 0 &&
          !(indentOf(lines[start]) === keyIndent - 2 && lines[start].trimStart().startsWith("- "))
        ) {
          start--;
        }
      }
      let end = index + 1;
      while (
        end < lines.length &&
        (isBlankOrComment(lines[end]) || indentOf(lines[end]) >= keyIndent)
      ) {
        end++;
      }
      const keys = {};
      const inputs = {};
      let inWith = false;
      let withIndent = -1;
      for (let i = start; i < end; i++) {
        if (isBlankOrComment(lines[i])) continue;
        const body = i === start ? lines[i].replace(/^(\s*)-\s+/, (_, s) => s + "  ") : lines[i];
        const keyMatch = body.match(/^(\s*)([A-Za-z0-9_-]+):/);
        if (!keyMatch) continue;
        const indent = keyMatch[1].length;
        if (indent === keyIndent) {
          inWith = keyMatch[2] === "with";
          withIndent = -1;
          if (!inWith) keys[keyMatch[2]] = readValue(lines, i);
        } else if (inWith && indent > keyIndent) {
          if (withIndent === -1) withIndent = indent;
          if (indent === withIndent) inputs[keyMatch[2]] = readValue(lines, i);
        }
      }
      steps.push({ action, where: `${name}:${index + 1}`, keys, inputs });
    });
  }
  return steps;
}

/**
 * Whether an expression saves only on develop/main: it is the gate, or ANDs
 * `(<gate>)` with other conditions and has no top-level `||` besides.
 *
 * @param {string | undefined} expression - an `if:` / `save-if:` value.
 */
export function isGated(expression) {
  if (expression === undefined) return false;
  let expr = expression
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
  const wrapped = expr.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) expr = wrapped[1];
  expr = expr.replace(/\s+/g, " ").trim();
  if (expr === GATE || expr === `(${GATE})`) return true;
  const at = expr.indexOf(`(${GATE})`);
  if (at === -1) return false;
  if (expr.slice(0, at).trimEnd().endsWith("!")) return false;
  const rest = expr.slice(0, at) + "true" + expr.slice(at + GATE.length + 2);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "(") depth++;
    else if (rest[i] === ")") depth--;
    else if (depth === 0 && rest.startsWith("||", i)) return false;
  }
  return true;
}

const isFalse = (value) => value !== undefined && /^['"]?false['"]?$/.test(value.trim());

/**
 * Run every cache-save rule.
 *
 * @param {Record<string, string>} files - workflows + composite actions.
 * @returns {string[]} human-readable problems; empty when every save is gated.
 */
export function findProblems(files) {
  const problems = [];
  const need = `gate it with \`${GATE}\``;
  for (const step of collectSteps(files)) {
    const { action, where, keys, inputs } = step;
    if (action === "Swatinem/rust-cache") {
      if (!isFalse(inputs["save-if"]) && !isGated(inputs["save-if"])) {
        problems.push(
          `${where}: Swatinem/rust-cache saves on every ref; set save-if to false or ${need}`
        );
      }
    } else if (action === "actions/cache" || action === "actions/cache/save") {
      if (!isGated(keys.if)) {
        problems.push(`${where}: ${action} saves on every ref; ${need} in the step's if:`);
      }
    } else if (action === "astral-sh/setup-uv") {
      if (!isFalse(inputs["save-cache"]) && !isGated(inputs["save-cache"])) {
        problems.push(
          `${where}: astral-sh/setup-uv saves on every ref; set save-cache to false or ${need}`
        );
      }
    } else if (action === "actions/setup-node") {
      if (inputs.cache !== undefined && inputs.cache.replace(/['"]/g, "").trim() !== "") {
        problems.push(
          `${where}: actions/setup-node's cache: saves on every ref; drop it and use ` +
            `./.github/actions/setup-pnpm with cache: "true"`
        );
      }
    }
  }
  return problems;
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const files = loadFiles(root);
  const problems = findProblems(files);
  if (problems.length > 0) {
    console.error(
      "Ungated GitHub Actions cache saves (see docs/contributing.md -> GitHub Actions caches):"
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const cacheActions = new Set([
    "Swatinem/rust-cache",
    "actions/cache",
    "actions/cache/save",
    "astral-sh/setup-uv",
  ]);
  const count = collectSteps(files).filter((step) => cacheActions.has(step.action)).length;
  console.log(`${count} cache-saving steps, each gated to develop/main.`);
}
