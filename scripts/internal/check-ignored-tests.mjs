#!/usr/bin/env node
// Bind every ignored Rust test to something that runs it (#5177).
//
// An `#[ignore]` is a claim that someone runs the test somewhere. Nothing
// checked that claim, so ignored tests sat for months in no lane. This check
// scans every `.rs` file of the repo (the workspace and rdp-sidecar/, skipping
// `target/`, `node_modules/` and dot directories) for `#[ignore]` and
// `#[cfg_attr(..., ignore = "...")]` and requires the reason string to carry
// at least one binding:
//
//   lane: <workflow>.yml#<job>   a CI job that runs the test with --ignored /
//                                --include-ignored / --run-ignored. It must be
//                                in LANES below, the job must exist, its run
//                                steps (or a script it calls, `via`) must pass
//                                such a flag outside comments, and they must
//                                name the test (or its `--test <binary>`).
//   manual: MT-<AREA>-<n>        a manual-test id defined in docs/testing.md.
//   quarantine: #<n>             the open issue tracking a quarantined test.
//   helper: <test fn>            a child-process helper, not a test: the named
//                                test in the same file runs it with --ignored.
//
// A bare `#[ignore]` or a reason with no binding fails. So does a test missing
// from the inventory table in docs/testing.md (between the
// `ignored-tests:begin` / `ignored-tests:end` markers), or a stale row there.
//
// Usage: node scripts/internal/check-ignored-tests.mjs [--root <repo-dir>]
// The pure helpers are exported for unit testing (check-ignored-tests.test.mjs),
// which also runs the check against the real repo.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";
import { listRustFiles } from "./check-no-cfg-test.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The lanes an ignore reason may name, as `<workflow file>#<job id>`. `via`
 * lists the scripts the job calls that hold the actual `--ignored` run.
 */
export const LANES = {
  "code-quality.yml#tests": { via: ["scripts/internal/real-keychain-tests.sh"] },
  "integration-fixtures.yml#core-integration": {},
  "integration-fixtures.yml#native-sshd": {},
  "plugin-lpac-per-machine.yml#per-machine-lpac": {
    via: ["scripts/internal/verify-plugin-lpac-per-machine.ps1"],
  },
  "plugin-sandbox-nightly.yml#plugin-sandbox-perf": {},
  "plugin-sandbox-nightly.yml#plugin-tls-handshake": {},
  "system-integration.yml#agent-docker-integration": {},
};

/** A test-runner flag that runs ignored tests (libtest or nextest). */
const IGNORED_FLAG = /--(?:ignored|include-ignored|run-ignored)\b/;

const DOCS = "docs/testing.md";
const BEGIN = "<!-- ignored-tests:begin -->";
const END = "<!-- ignored-tests:end -->";

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** Whether `index` sits after a `//` on its line (a comment, not code). */
function inLineComment(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(start, index).includes("//");
}

/**
 * Read a Rust string literal (`"…"` or `r#"…"#`) starting at `text[i]`.
 *
 * @returns {{ value: string, end: number } | null} the decoded value and the
 *   index just past the literal, or null when `text[i]` starts none.
 */
export function readStringLiteral(text, i) {
  const raw = /^r(#*)"/.exec(text.slice(i, i + 10));
  if (raw) {
    const close = `"${raw[1]}`;
    const start = i + raw[0].length;
    const stop = text.indexOf(close, start);
    if (stop === -1) return null;
    return { value: text.slice(start, stop), end: stop + close.length };
  }
  if (text[i] !== '"') return null;
  let value = "";
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '"') return { value, end: j + 1 };
    if (c !== "\\") {
      value += c;
      continue;
    }
    const next = text[j + 1];
    if (next === "\n" || next === "\r") {
      // Line continuation: drop the newline and the next line's indentation.
      j += 1;
      while (j + 1 < text.length && /\s/.test(text[j + 1])) j++;
    } else {
      value += { n: "\n", t: "\t", r: "\r", 0: "\0" }[next] ?? next;
      j += 1;
    }
  }
  return null;
}

/** Index just past the `)` that closes the `(` at `text[open]`, or -1. */
function closeParen(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '"') {
      const lit = readStringLiteral(text, j);
      if (!lit) return -1;
      j = lit.end - 1;
    } else if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Parse `ignore` or `ignore = "<reason>"` at `text[i]`.
 *
 * @returns {{ reason: string | null } | null} null when no `ignore` is there.
 */
function readIgnore(text, i) {
  const m = /^ignore\b\s*/.exec(text.slice(i, i + 40));
  if (!m) return null;
  let j = i + m[0].length;
  if (text[j] !== "=") return { reason: null };
  j++;
  while (/\s/.test(text[j])) j++;
  const lit = readStringLiteral(text, j);
  return { reason: lit ? lit.value : null };
}

/** Split the top-level comma-separated arguments of `cfg_attr(…)`. */
function topLevelArgs(inner) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (c === '"') {
      const lit = readStringLiteral(inner, j);
      if (!lit) break;
      j = lit.end - 1;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      args.push({ text: inner.slice(start, j), offset: start });
      start = j + 1;
    }
  }
  args.push({ text: inner.slice(start), offset: start });
  return args;
}

/**
 * Find every ignore attribute in a Rust source.
 *
 * @param {string} text - the file contents.
 * @returns {{ line: number, test: string | null, reason: string | null }[]}
 */
export function findIgnores(text) {
  const hits = [];
  const attr = /#\[\s*(ignore\b|cfg_attr\s*\()/g;
  let m;
  while ((m = attr.exec(text))) {
    if (inLineComment(text, m.index)) continue;
    let found = null;
    let after = m.index + m[0].length;
    if (m[1].startsWith("ignore")) {
      found = readIgnore(text, m.index + m[0].length - m[1].length);
    } else {
      const open = m.index + m[0].length - 1;
      const close = closeParen(text, open);
      if (close === -1) continue;
      after = close;
      const inner = text.slice(open + 1, close - 1);
      // The first argument is the predicate; any later one may be `ignore`.
      for (const arg of topLevelArgs(inner).slice(1)) {
        const lead = arg.text.length - arg.text.trimStart().length;
        found = readIgnore(inner, arg.offset + lead);
        if (found) break;
      }
    }
    if (!found) continue;
    const fn = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(after));
    hits.push({ line: lineAt(text, m.index), test: fn ? fn[1] : null, reason: found.reason });
  }
  return hits;
}

/**
 * The bindings a reason string names.
 *
 * @param {string} reason
 * @returns {{ lanes: string[], manual: string[], quarantine: string[], helpers: string[] }}
 */
export function parseBindings(reason) {
  const all = (re) => [...reason.matchAll(re)].map((x) => x[1]);
  return {
    lanes: all(/\blane:\s*([\w.-]+#[\w-]+)/g),
    manual: all(/\bmanual:\s*(MT-[A-Z]+-\d+)\b/g),
    quarantine: all(/\bquarantine:\s*#(\d+)\b/g),
    helpers: all(/\bhelper:\s*([A-Za-z_][A-Za-z0-9_]*)/g),
  };
}

/** Drop whole-line `#` comments (YAML, shell, PowerShell). */
const stripHashComments = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

/**
 * The lines of job `job` in a workflow (`jobs:` → `  <job>:` until the next
 * job), or null when the job is not there.
 */
export function jobBlock(workflowText, job) {
  const lines = workflowText.split(/\r?\n/);
  const jobs = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobs === -1) return null;
  const head = lines.findIndex((l, i) => i > jobs && l === `  ${job}:`);
  if (head === -1) return null;
  let end = head + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (/^ {0,2}\S/.test(l) && !l.trimStart().startsWith("#")) break;
    end++;
  }
  return lines.slice(head, end).join("\n");
}

/**
 * Resolve a lane to the text that runs its tests (comments stripped).
 *
 * @returns {{ text: string } | { problem: string }}
 */
export function laneText(root, lane, lanes = LANES) {
  const entry = lanes[lane];
  if (!entry) return { problem: `lane ${lane} is not in the LANES registry` };
  const [workflow, job] = lane.split("#");
  const file = path.join(root, ".github", "workflows", workflow);
  if (!existsSync(file))
    return { problem: `lane ${lane}: no workflow .github/workflows/${workflow}` };
  const block = jobBlock(readFileSync(file, "utf8"), job);
  if (block === null) return { problem: `lane ${lane}: no job \`${job}\` in ${workflow}` };
  let text = stripHashComments(block);
  for (const script of entry.via ?? []) {
    if (
      !text.includes(
        script
          .split("/")
          .pop()
          .replace(/\.[^.]+$/, "")
      )
    ) {
      return { problem: `lane ${lane}: the job does not call ${script}` };
    }
    const scriptFile = path.join(root, script);
    if (!existsSync(scriptFile)) return { problem: `lane ${lane}: no script ${script}` };
    text += "\n" + stripHashComments(readFileSync(scriptFile, "utf8"));
  }
  if (!IGNORED_FLAG.test(text)) {
    return { problem: `lane ${lane}: never runs ignored tests (no --ignored / --run-ignored)` };
  }
  return { text };
}

/** Whether a lane's text selects `test` of `file`, by name or by binary. */
export function laneSelects(text, file, test) {
  if (new RegExp(`\\b${test}\\b`).test(text)) return true;
  const binary = /(?:^|\/)tests\/([A-Za-z0-9_]+)\.rs$/.exec(file);
  return binary !== null && new RegExp(`--test\\s+${binary[1]}\\b`).test(text);
}

/** `file::test` keys of the inventory table rows in docs/testing.md. */
export function inventoryRows(docsText) {
  const start = docsText.indexOf(BEGIN);
  const end = docsText.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  const rows = new Set();
  for (const line of docsText.slice(start, end).split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) rows.add(`${m[1]}::${m[2]}`);
  }
  return rows;
}

/**
 * Check every ignore attribute under `root`.
 *
 * @returns {{ problems: string[], ignores: object[] }}
 */
export function checkRepo(root, lanes = LANES) {
  const problems = [];
  const ignores = [];
  const docsFile = path.join(root, DOCS);
  const docsText = existsSync(docsFile) ? readFileSync(docsFile, "utf8") : "";
  const laneCache = new Map();
  const resolveLane = (lane) => {
    if (!laneCache.has(lane)) laneCache.set(lane, laneText(root, lane, lanes));
    return laneCache.get(lane);
  };

  for (const rel of listRustFiles(root)) {
    const text = readFileSync(path.join(root, rel), "utf8");
    for (const hit of findIgnores(text)) {
      const where = `${rel}:${hit.line}`;
      ignores.push({ file: rel, ...hit });
      if (!hit.test) {
        problems.push(`${where}: ignore attribute on no test fn`);
        continue;
      }
      if (hit.reason === null) {
        problems.push(`${where} (${hit.test}): bare #[ignore] — give it a reason with a binding`);
        continue;
      }
      const b = parseBindings(hit.reason);
      const count = b.lanes.length + b.manual.length + b.quarantine.length + b.helpers.length;
      if (count === 0) {
        problems.push(
          `${where} (${hit.test}): the reason names no \`lane:\`, \`manual:\`, ` +
            `\`quarantine:\` or \`helper:\` binding: "${hit.reason}"`
        );
      }
      for (const lane of b.lanes) {
        const resolved = resolveLane(lane);
        if (resolved.problem) problems.push(`${where} (${hit.test}): ${resolved.problem}`);
        else if (!laneSelects(resolved.text, rel, hit.test)) {
          problems.push(`${where} (${hit.test}): lane ${lane} never names this test or its binary`);
        }
      }
      for (const id of b.manual) {
        if (!new RegExp(`\\b${id}\\b`).test(docsText)) {
          problems.push(`${where} (${hit.test}): manual id ${id} is not defined in ${DOCS}`);
        }
      }
      for (const parent of b.helpers) {
        if (!new RegExp(`\\bfn\\s+${parent}\\b`).test(text)) {
          problems.push(`${where} (${hit.test}): helper parent ${parent} is not in this file`);
        } else if (!text.includes('"--ignored"')) {
          problems.push(
            `${where} (${hit.test}): nothing in this file runs the helper with --ignored`
          );
        }
      }
    }
  }

  const rows = inventoryRows(docsText);
  if (rows === null) {
    problems.push(`${DOCS}: no inventory table between ${BEGIN} and ${END}`);
  } else {
    const keys = new Set(ignores.filter((i) => i.test).map((i) => `${i.file}::${i.test}`));
    for (const key of keys) {
      if (!rows.has(key)) problems.push(`${DOCS}: inventory table is missing ${key}`);
    }
    for (const key of rows) {
      if (!keys.has(key))
        problems.push(`${DOCS}: stale inventory row ${key} (no such ignored test)`);
    }
  }
  return { problems, ignores };
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const { problems, ignores } = checkRepo(root);
  if (problems.length > 0) {
    console.error("Unbound ignored Rust tests (see scripts/internal/check-ignored-tests.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `All ${ignores.length} ignored Rust test(s) are bound to a lane, manual id or issue.`
  );
}
