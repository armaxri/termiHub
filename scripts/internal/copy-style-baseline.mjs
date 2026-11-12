// Copy style baseline tool (#5391): maintains scripts/internal/copy-style-baseline.json,
// the grandfathered violations of the copy-style lint (eslint-copy-style.mjs).
//
// The lint fails on any violation that is not in the baseline, so the baseline
// only ever shrinks: fix a string, then run `--prune` to delete its entry.
//
// Usage: node scripts/internal/copy-style-baseline.mjs [mode]
//   (no mode)  report the current violations grouped by area, as Markdown
//   --check    exit 1 when the baseline holds stale entries (already fixed)
//   --prune    delete stale entries; never adds one
//   --write    rewrite the baseline from scratch (grandfathers everything:
//              only for the initial baseline or a reviewed policy change)

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { ESLint } from "eslint";
import { isMainModule } from "./is-main-module.mjs";
import {
  DEFAULT_BASELINE_PATH,
  REPO_ROOT,
  baselineKey,
  parseMessage,
} from "./eslint-copy-style.mjs";

/**
 * Lint `src/` with the baseline turned off and return every copy-style
 * violation as `{ file, check, text }`.
 *
 * @returns {Promise<{ file: string, check: string, text: string }[]>}
 */
export async function collectViolations() {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: {
      files: ["src/**/*.{ts,tsx}"],
      ignores: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/testbridge/**"],
      rules: { "copy/copy-style": ["error", { baselinePath: null }] },
    },
  });
  const results = await eslint.lintFiles(["src/"]);
  const violations = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId !== "copy/copy-style") continue;
      const parsed = parseMessage(message.message);
      if (parsed) violations.push({ file: baselineKey(result.filePath), ...parsed });
    }
  }
  return violations;
}

/**
 * Build the baseline object `{ file: { check: { text: count } } }` with sorted
 * keys, so the JSON diff of a fix is a deleted line.
 */
export function toBaseline(violations) {
  const baseline = {};
  for (const { file, check, text } of violations) {
    const byCheck = (baseline[file] ??= {});
    const byText = (byCheck[check] ??= {});
    byText[text] = (byText[text] ?? 0) + 1;
  }
  return sortDeep(baseline);
}

function sortDeep(value) {
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortDeep(value[k])])
  );
}

/**
 * Intersect `baseline` with `current`: keep each entry only up to the number
 * of times it still occurs. Returns the pruned baseline and the dropped entries.
 */
export function pruneBaseline(baseline, current) {
  const pruned = {};
  const stale = [];
  for (const [file, byCheck] of Object.entries(baseline)) {
    for (const [check, byText] of Object.entries(byCheck)) {
      for (const [text, count] of Object.entries(byText)) {
        const still = Math.min(count, current[file]?.[check]?.[text] ?? 0);
        if (still < count) stale.push({ file, check, text, count: count - still });
        if (still > 0) ((pruned[file] ??= {})[check] ??= {})[text] = still;
      }
    }
  }
  return { pruned: sortDeep(pruned), stale };
}

/** The area a file belongs to: its first directory below src/components, or below src/. */
export function areaOf(file) {
  const parts = file.split("/");
  return parts[1] === "components" && parts.length > 3 ? parts[2] : parts[1];
}

/** Markdown report of the violations grouped by area, then check. */
export function formatReport(violations) {
  const byArea = new Map();
  for (const v of violations) {
    const area = areaOf(v.file);
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(v);
  }
  const lines = [];
  for (const area of [...byArea.keys()].sort()) {
    const list = byArea.get(area);
    lines.push(`### ${area} (${list.length})`, "");
    for (const v of list.sort(
      (a, b) => a.check.localeCompare(b.check) || a.file.localeCompare(b.file)
    )) {
      lines.push(`- \`${v.check}\` ${path.basename(v.file)}: ${JSON.stringify(v.text)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function readBaseline() {
  return JSON.parse(readFileSync(DEFAULT_BASELINE_PATH, "utf8"));
}

function writeBaseline(baseline) {
  writeFileSync(DEFAULT_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

async function main(argv) {
  const mode = argv[2] ?? "--report";
  const violations = await collectViolations();
  const current = toBaseline(violations);
  if (mode === "--write") {
    writeBaseline(current);
    console.log(`Wrote ${violations.length} grandfathered violations.`);
    return 0;
  }
  if (mode === "--report") {
    console.log(formatReport(violations));
    return 0;
  }
  const { pruned, stale } = pruneBaseline(readBaseline(), current);
  for (const s of stale) console.log(`stale: ${s.file} [${s.check}] ${JSON.stringify(s.text)}`);
  if (mode === "--prune") {
    writeBaseline(pruned);
    console.log(`Removed ${stale.length} stale baseline entries.`);
    return 0;
  }
  if (mode === "--check") {
    if (stale.length > 0) console.log("Run with --prune to delete the stale entries.");
    return stale.length > 0 ? 1 : 0;
  }
  console.error(`Unknown mode ${mode}. Use --check, --prune, --write or no argument.`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv);
}
