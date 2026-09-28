#!/usr/bin/env node
// Release marker scan (TOOL-011, #3750).
//
// A TODO / FIXME / HACK comment in shipped source is unfinished work. This scan
// BLOCKS the release gate (scripts/release-check.sh / .cmd) on every such marker
// that is not on the explicit allowlist in scripts/release-marker-allowlist.json.
// Before #3750 the TODO half was warn-only and FIXME/HACK had no allowlist, so a
// marker that is meant to stay (e.g. a quoted upstream comment) could not pass
// without deleting it, and a new TODO never blocked anything.
//
// Only a marker that OPENS a comment counts (`// TODO`, `/* FIXME`, ` * HACK`,
// `//! TODO`, `/// FIXME`, ...). A bare-word match would also hit string literals
// and test fixtures that merely mention the words (the syntax-highlighting rule
// editor's "\\b(TODO|FIXME)\\b" placeholder, for example), which are not markers.
//
// Allowlist entries name a file and a substring of the marker line, not a line
// number, so an unrelated edit above the marker does not invalidate the entry.
// Every entry needs a written reason, and an entry that no longer matches any
// marker FAILS the scan: a stale allowlist would otherwise silently pre-approve
// the next marker someone adds to that file.
//
// The logic lives here (not inline in the shell/cmd scripts) so both halves of
// the release check run the identical scan, and so it can be unit-tested — see
// release-marker-scan.test.mjs.
//
// Usage: node scripts/internal/release-marker-scan.mjs [--root <dir>] [--allowlist <file>]
// Exit codes: 0 no blocking markers, 1 blocking/stale/invalid, 2 usage or I/O error.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Source trees that ship in a release artifact (desktop app, core, agent, plugin API, RDP sidecar). */
export const SCAN_ROOTS = [
  "src",
  "src-tauri/src",
  "core/src",
  "agent/src",
  "plugin-api/src",
  "rdp-sidecar/src",
];

export const SCAN_EXTENSIONS = [".ts", ".tsx", ".rs"];

/** Directory names never descended into (build output, dependencies, vendored forks). */
const SKIP_DIRS = new Set(["node_modules", "target", "vendor", "dist"]);

/**
 * A marker that opens a comment: `//`, `/*` or a leading ` *` (block-comment
 * continuation), optionally followed by doc-comment characters (`/`, `!`, `*`),
 * then whitespace and the marker word.
 */
export const MARKER_RE = /(\/\/|\/\*|^\s*\*)[/!*]*\s*(TODO|FIXME|HACK)\b/;

export const DEFAULT_ALLOWLIST = "scripts/release-marker-allowlist.json";

/**
 * Find every comment marker in one file's text.
 *
 * @param {string} text
 * @param {string} relPath - repo-relative, forward-slash path used in reports.
 * @returns {Array<{ path: string, line: number, marker: string, text: string }>}
 */
export function findMarkers(text, relPath) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i]);
    if (m) {
      out.push({ path: relPath, line: i + 1, marker: m[2], text: lines[i].trim() });
    }
  }
  return out;
}

/**
 * Walk the scan roots under `repoRoot` and collect every comment marker.
 *
 * @param {string} repoRoot
 * @param {{ roots?: string[], extensions?: string[] }} [opts]
 */
export function scanTree(repoRoot, { roots = SCAN_ROOTS, extensions = SCAN_EXTENSIONS } = {}) {
  const found = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        return; // a scan root that does not exist in this checkout is not an error
      }
      throw err;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(abs, rel);
        }
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        found.push(...findMarkers(readFileSync(abs, "utf8"), rel));
      }
    }
  };
  for (const root of roots) {
    walk(path.join(repoRoot, root), root);
  }
  return found;
}

/**
 * Parse and validate the allowlist document.
 *
 * @param {unknown} doc - parsed JSON.
 * @returns {{ entries: Array<{ path: string, contains: string, reason: string }>, errors: string[] }}
 */
export function parseAllowlist(doc) {
  const errors = [];
  const raw = doc && typeof doc === "object" && Array.isArray(doc.entries) ? doc.entries : null;
  if (!raw) {
    return { entries: [], errors: ['allowlist must be an object with an "entries" array'] };
  }
  const entries = [];
  raw.forEach((e, i) => {
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") {
      errors.push(`${where}: must be an object`);
      return;
    }
    const missing = ["path", "contains", "reason"].filter(
      (k) => typeof e[k] !== "string" || e[k].trim() === ""
    );
    if (missing.length > 0) {
      errors.push(`${where}: needs a non-empty ${missing.join(", ")}`);
      return;
    }
    entries.push({ path: e.path, contains: e.contains, reason: e.reason });
  });
  return { entries, errors };
}

/**
 * Split the found markers into allowed and blocking, and report stale entries.
 *
 * @param {ReturnType<typeof scanTree>} markers
 * @param {ReturnType<typeof parseAllowlist>["entries"]} entries
 */
export function evaluateMarkers(markers, entries) {
  const used = new Set();
  const allowed = [];
  const blocking = [];
  for (const m of markers) {
    const idx = entries.findIndex((e) => e.path === m.path && m.text.includes(e.contains));
    if (idx >= 0) {
      used.add(idx);
      allowed.push({ ...m, reason: entries[idx].reason });
    } else {
      blocking.push(m);
    }
  }
  const stale = entries.filter((_, i) => !used.has(i));
  return { allowed, blocking, stale, ok: blocking.length === 0 && stale.length === 0 };
}

/**
 * Render the verdict as report lines.
 *
 * @param {ReturnType<typeof evaluateMarkers>} verdict
 * @param {{ allowlistPath: string, errors?: string[] }} ctx
 */
export function formatReport(verdict, { allowlistPath, errors = [] }) {
  const lines = [];
  for (const err of errors) {
    lines.push(`FAIL: ${allowlistPath}: ${err}`);
  }
  for (const m of verdict.allowed) {
    lines.push(`allowed: ${m.path}:${m.line}: ${m.text}  (${m.reason})`);
  }
  for (const m of verdict.blocking) {
    lines.push(`FAIL: ${m.path}:${m.line}: ${m.text}`);
  }
  for (const e of verdict.stale) {
    lines.push(
      `FAIL: stale allowlist entry (matches no marker): ${e.path} contains "${e.contains}"`
    );
  }
  if (verdict.ok && errors.length === 0) {
    lines.push(
      `No un-allowlisted TODO/FIXME/HACK markers (${verdict.allowed.length} allowlisted in ${allowlistPath}).`
    );
  } else {
    lines.push(
      "",
      "A TODO/FIXME/HACK comment in shipped source blocks the release. Either finish the",
      "work (or move it to a GitHub issue and delete the comment), or, if the marker is",
      "meant to stay, add an entry with a written reason to",
      `${allowlistPath}. Remove entries that no longer match anything.`
    );
  }
  return lines;
}

/**
 * Run the scan end to end.
 *
 * @param {{ repoRoot: string, allowlistPath?: string, log?: (line: string) => void }} args
 * @returns {number} exit code
 */
export function runScan({ repoRoot, allowlistPath = DEFAULT_ALLOWLIST, log = console.log }) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path.resolve(repoRoot, allowlistPath), "utf8"));
  } catch (err) {
    log(`FAIL: cannot read allowlist ${allowlistPath}: ${err.message}`);
    return 2;
  }
  const { entries, errors } = parseAllowlist(doc);
  let markers;
  try {
    markers = scanTree(repoRoot);
  } catch (err) {
    log(`FAIL: scan error: ${err.message}`);
    return 2;
  }
  const verdict = evaluateMarkers(markers, entries);
  for (const line of formatReport(verdict, { allowlistPath, errors })) {
    log(line);
  }
  return verdict.ok && errors.length === 0 ? 0 : 1;
}

/** Parse `--root <dir>` / `--allowlist <file>`; returns null on a usage error. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag === "--root" || flag === "--allowlist") && argv[i + 1]) {
      out[flag.slice(2)] = argv[++i];
    } else {
      return null;
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: node scripts/internal/release-marker-scan.mjs [--root <dir>] [--allowlist <file>]"
    );
    process.exit(2);
  }
  const repoRoot = path.resolve(
    args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
  );
  process.exit(runScan({ repoRoot, allowlistPath: args.allowlist }));
}
