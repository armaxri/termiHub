#!/usr/bin/env node
// Merge the nightly integration-lane lcov into the unified unit-test lcov
// (TOOL-005, #3656). Used by scripts/coverage.sh and scripts/coverage.cmd.
//
// The unified report (TOOL-001) is a plain concatenation of the frontend and
// Rust lcov files — valid because the two never share a source file. The
// integration lcov DOES share files with the Rust unit report (core/src/**), so
// concatenating it would count every core line twice. This script merges
// per source file instead: hit counts are summed line-by-line (DA), per
// function (FNDA) and per branch (BRDA). Each file keeps the base report's own
// LF/FNF/BRF totals, and its LH/FNH/BRH rise by what the integration run newly
// hit (see recordTotals), so the unit-only number is reproduced exactly when the
// overlay adds nothing.
//
// Two rules keep the merged number honest:
//
//   * The BASE report owns the denominator. An overlay (integration) record for
//     a file the base does not list is dropped, so integration runs can only
//     turn uncovered lines covered — they never add new files to the total.
//   * Stale files are skipped. The nightly lcov is measured on an older commit
//     than the one being reported; line numbers in a file that changed since
//     would land on the wrong lines. `--skip-list` names those files (one
//     repo-relative path per line, from `git diff --name-only <nightly> HEAD`)
//     and their overlay records are dropped entirely.
//
// Source paths are normalized to repo-relative (`--root` prefix stripped, `\`
// turned into `/`) so the absolute cargo-llvm-cov paths from two different
// runners, and vitest's relative paths, all key the same way.
//
// Usage:
//   node lcov-merge.mjs --base <unit.lcov> --overlay <integration.lcov>
//     [--skip-list <file>] [--root <repo root>] --out <merged.lcov>
//     [--report <gap.md>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Normalize an lcov SF path to a repo-relative, forward-slash key. */
export function normalizePath(sf, root) {
  let p = sf.replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (p.startsWith(r)) p = p.slice(r.length);
    else if (p.toLowerCase().startsWith(r.toLowerCase())) p = p.slice(r.length);
  }
  return p.replace(/^\.\//, "");
}

const TOTAL_KEYS = ["LF", "LH", "FNF", "FNH", "BRF", "BRH"];

/**
 * Parse lcov text into a Map<path, record>. A record keeps per-line hits,
 * function definitions/hits, branch hits, and the file's own LF/LH/FNF/FNH/
 * BRF/BRH totals. Repeated SF records for one file (lcov allows them) are
 * merged in.
 */
export function parseLcov(text, root) {
  const files = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "end_of_record") {
      cur = null;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);
    if (key === "SF") {
      const path = normalizePath(val, root);
      cur = files.get(path);
      if (!cur) {
        cur = emptyRecord();
        files.set(path, cur);
      }
    } else if (cur) {
      parseDetail(cur, key, val);
    }
  }
  return files;
}

function parseDetail(rec, key, val) {
  if (key === "DA") {
    const [ln, count] = val.split(",");
    addCount(rec.lines, ln, count);
  } else if (key === "FN") {
    // FN:<line>,<name>  (lcov 2.x may emit FN:<start>,<end>,<name>)
    const parts = val.split(",");
    const name = parts.slice(parts.length === 3 ? 2 : 1).join(",");
    if (!rec.fnDefs.has(name)) rec.fnDefs.set(name, val);
    if (!rec.fnHits.has(name)) rec.fnHits.set(name, 0);
  } else if (key === "FNDA") {
    const comma = val.indexOf(",");
    addCount(rec.fnHits, val.slice(comma + 1), val.slice(0, comma));
  } else if (key === "BRDA") {
    const parts = val.split(",");
    const taken = parts.pop();
    const id = parts.join(",");
    const prev = rec.branches.get(id);
    const n = taken === "-" ? null : Number.parseInt(taken, 10) || 0;
    if (prev === undefined) rec.branches.set(id, n);
    else if (n !== null) rec.branches.set(id, (prev ?? 0) + n);
  } else if (TOTAL_KEYS.includes(key)) {
    const n = Number.parseInt(val, 10);
    if (Number.isFinite(n)) rec.totals[key] = (rec.totals[key] ?? 0) + n;
  }
}

function emptyRecord() {
  return {
    lines: new Map(),
    fnDefs: new Map(),
    fnHits: new Map(),
    branches: new Map(),
    totals: {},
    gained: { lines: 0, functions: 0, branches: 0 },
  };
}

function addCount(map, key, count) {
  const n = Number.parseInt(count, 10);
  map.set(key, (map.get(key) ?? 0) + (Number.isFinite(n) ? n : 0));
}

/**
 * A function's identity across builds. Rust symbol names embed a crate hash
 * that differs between binaries and builds (the lib and its test harness carry
 * two hashes even within one run; the unit report builds the whole workspace,
 * the nightly lane only termihub-core), so one function has several names.
 * Strip the v0 crate disambiguator (`Cs<hash>_`) and the legacy `17h<hex>E`
 * suffix; other names pass through unchanged.
 */
export function functionKey(name) {
  if (name.startsWith("_R")) return name.replace(/Cs[0-9A-Za-z]*_/g, "Cs_");
  if (name.startsWith("_ZN")) return name.replace(/17h[0-9a-f]{16}E$/, "E");
  return name;
}

/**
 * Merge `overlay` into a copy of `base`. Returns the merged map plus stats:
 * how many lines the overlay newly covered, which overlay files were skipped
 * as stale, and how many were dropped for not being in the base report.
 */
export function mergeCoverage(base, overlay, skip = new Set()) {
  const merged = new Map();
  for (const [path, rec] of base) merged.set(path, cloneRecord(rec));
  const stats = { newlyCoveredLines: 0, perFile: new Map(), staleSkipped: [], notInBase: 0 };
  for (const [path, rec] of overlay) {
    if (skip.has(path)) {
      stats.staleSkipped.push(path);
      continue;
    }
    const into = merged.get(path);
    if (!into) {
      stats.notInBase += 1;
      continue;
    }
    mergeRecord(into, rec);
    if (into.gained.lines > 0) {
      stats.newlyCoveredLines += into.gained.lines;
      stats.perFile.set(path, into.gained.lines);
    }
  }
  return { merged, stats };
}

/** Sum `rec`'s hits into `into`, counting what was 0 before and is hit now. */
function mergeRecord(into, rec) {
  // Only lines the base instruments count: a line the unit build never saw as
  // executable would widen the denominator.
  for (const [ln, n] of rec.lines) {
    if (!into.lines.has(ln)) continue;
    const before = into.lines.get(ln);
    into.lines.set(ln, before + n);
    if (before === 0 && n > 0) into.gained.lines += 1;
  }

  // Functions are counted per functionKey (all instantiations of one function
  // together), matching how the lcov FNF/FNH totals are deduplicated.
  const byKey = new Map();
  for (const name of into.fnHits.keys()) {
    const k = functionKey(name);
    byKey.set(k, [...(byKey.get(k) ?? []), name]);
  }
  const hitBefore = (k) => byKey.get(k).some((name) => into.fnHits.get(name) > 0);
  const newlyHit = new Set();
  for (const [name, n] of rec.fnHits) {
    const k = functionKey(name);
    const targets = byKey.get(k);
    if (!targets || n === 0) continue;
    if (!hitBefore(k)) newlyHit.add(k);
    into.fnHits.set(targets[0], into.fnHits.get(targets[0]) + n);
  }
  into.gained.functions += newlyHit.size;

  for (const [id, n] of rec.branches) {
    if (!into.branches.has(id) || !n) continue;
    const before = into.branches.get(id) ?? 0;
    into.branches.set(id, before + n);
    if (before === 0) into.gained.branches += 1;
  }
}

function cloneRecord(rec) {
  return {
    lines: new Map(rec.lines),
    fnDefs: new Map(rec.fnDefs),
    fnHits: new Map(rec.fnHits),
    branches: new Map(rec.branches),
    totals: { ...rec.totals },
    gained: { ...rec.gained },
  };
}

/**
 * The record's totals. When the source report carried its own totals they are
 * kept (cargo-llvm-cov's LF/FNF are computed from regions and deduplicated
 * instantiations, not from the DA/FN detail lines, so recomputing would shift
 * the unit baseline) and the hit counts are raised by what the merge gained,
 * capped at the found count. Records without totals get them computed.
 */
export function recordTotals(rec) {
  const hits = (m) => [...m.values()].filter((n) => n > 0).length;
  const computed = {
    LF: rec.lines.size,
    LH: hits(rec.lines),
    FNF: new Set([...rec.fnHits.keys()].map(functionKey)).size,
    FNH: new Set([...rec.fnHits].filter(([, n]) => n > 0).map(([k]) => functionKey(k))).size,
    BRF: rec.branches.size,
    BRH: hits(rec.branches),
  };
  const t = rec.totals;
  const keep = (found, hit, gain) =>
    t[found] === undefined
      ? [computed[found], computed[hit]]
      : [t[found], Math.min(t[found], (t[hit] ?? 0) + gain)];
  const [LF, LH] = keep("LF", "LH", rec.gained.lines);
  const [FNF, FNH] = keep("FNF", "FNH", rec.gained.functions);
  const [BRF, BRH] = keep("BRF", "BRH", rec.gained.branches);
  return { LF, LH, FNF, FNH, BRF, BRH };
}

/** Serialize a merged map back to lcov. */
export function formatLcov(files) {
  const out = [];
  for (const [path, rec] of files) {
    const t = recordTotals(rec);
    out.push("TN:", `SF:${path}`);
    for (const def of rec.fnDefs.values()) out.push(`FN:${def}`);
    for (const [name, n] of rec.fnHits) out.push(`FNDA:${n},${name}`);
    out.push(`FNF:${t.FNF}`, `FNH:${t.FNH}`);
    for (const [id, n] of rec.branches) out.push(`BRDA:${id},${n === null ? "-" : n}`);
    out.push(`BRF:${t.BRF}`, `BRH:${t.BRH}`);
    for (const [ln, n] of rec.lines) out.push(`DA:${ln},${n}`);
    out.push(`LF:${t.LF}`, `LH:${t.LH}`, "end_of_record");
  }
  return out.join("\n") + "\n";
}

/** Markdown gap report: what the integration lane added, and what it could not. */
export function formatReport(
  stats,
  { top = 25, title = "Integration coverage (nightly fixtures lane)" } = {}
) {
  const lines = [
    `## ${title}`,
    "",
    `Lines covered ONLY by the integration lane: **${stats.newlyCoveredLines}**`,
  ];
  if (stats.staleSkipped.length > 0) {
    lines.push(
      `Files skipped as stale (changed since the nightly commit): ${stats.staleSkipped.length}`
    );
  }
  if (stats.notInBase > 0) {
    lines.push(`Overlay files ignored (not in the unit report): ${stats.notInBase}`);
  }
  const ranked = [...stats.perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length > 0) {
    lines.push("", "| File | Lines gained |", "| --- | ---: |");
    for (const [path, n] of ranked.slice(0, top)) lines.push(`| \`${path}\` | ${n} |`);
    if (ranked.length > top) lines.push(`| … ${ranked.length - top} more | |`);
  }
  return lines.join("\n") + "\n";
}

const FLAGS = {
  "--base": "base",
  "--overlay": "overlay",
  "--skip-list": "skipList",
  "--root": "root",
  "--out": "out",
  "--report": "report",
};

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = FLAGS[flag];
    if (!name || i + 1 >= argv.length) throw new Error(`bad argument: ${flag}`);
    opts[name] = argv[++i];
  }
  if (!opts.base || !opts.overlay || !opts.out) {
    throw new Error("--base, --overlay and --out are required");
  }
  return opts;
}

export function readSkipList(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\\/g, "/"))
      .filter(Boolean)
  );
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`lcov-merge: ${e.message}`);
    console.error(
      "usage: lcov-merge.mjs --base <lcov> --overlay <lcov> [--skip-list <file>] " +
        "[--root <dir>] --out <lcov> [--report <md>]"
    );
    return 2;
  }
  const base = parseLcov(readFileSync(opts.base, "utf8"), opts.root);
  const overlay = parseLcov(readFileSync(opts.overlay, "utf8"), opts.root);
  const skip =
    opts.skipList && existsSync(opts.skipList)
      ? readSkipList(readFileSync(opts.skipList, "utf8"))
      : new Set();
  const { merged, stats } = mergeCoverage(base, overlay, skip);
  writeFileSync(opts.out, formatLcov(merged));
  const report = formatReport(stats);
  if (opts.report) writeFileSync(opts.report, report);
  process.stdout.write(report);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
