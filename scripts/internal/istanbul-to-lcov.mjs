#!/usr/bin/env node
// Convert the system-test harness's frontend coverage dumps to one lcov file
// (TOOL-005 follow-up, #3657).
//
// Each harness app launch writes one Istanbul coverage JSON per window
// (`window.__coverage__`, see tests/system/termihub_harness/coverage.py) into
// --in-dir. This script sums them per source file and writes lcov in the same
// shape istanbul-reports' lcovonly reporter (and so vitest) produces:
//
//   * DA   — one line per statement start line, the line's hit count being the
//            highest of its statements (istanbul-lib-coverage getLineCoverage);
//   * FN / FNDA — per function, keyed by name at its declaration line;
//   * BRDA — `<line>,<block>,<index>,<taken>` per branch arm.
//
// The frontend is instrumented before esbuild strips its types
// (scripts/internal/vite-coverage-plugin.mjs), so the locations are already
// original-source locations and no source-map remapping is needed. Source paths
// are made repo-relative (`--root` stripped, `\` → `/`) so they key the same way
// as vitest's `src/**` paths in lcov-merge.mjs.
//
// Dumps of one file from a DIFFERENT build (another `hash`) cannot be summed;
// the first build seen wins and the rest are counted as skipped.
//
// Usage: node istanbul-to-lcov.mjs --in-dir <dir> --out <lcov> [--root <repo>]
// Exits 0 with no output file when --in-dir holds no dumps.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "./lcov-merge.mjs";
import { isMainModule } from "./is-main-module.mjs";

/** Sum `counts` into `into` (both `{id: n}` or `{id: [n...]}` maps). */
function addCounts(into, counts) {
  for (const [id, n] of Object.entries(counts ?? {})) {
    if (Array.isArray(n)) {
      const prev = into[id] ?? n.map(() => 0);
      into[id] = n.map((v, i) => (prev[i] ?? 0) + (Number(v) || 0));
    } else {
      into[id] = (into[id] ?? 0) + (Number(n) || 0);
    }
  }
}

/**
 * Merge a list of Istanbul coverage maps (`{ [path]: FileCoverage }`) into one,
 * keyed by repo-relative path. Returns `{ files, skipped }`.
 */
export function mergeCoverageMaps(maps, root) {
  const files = new Map();
  let skipped = 0;
  for (const map of maps) {
    for (const [key, fc] of Object.entries(map ?? {})) {
      if (!fc || typeof fc !== "object" || !fc.statementMap) continue;
      const rel = normalizePath(fc.path ?? key, root);
      const prev = files.get(rel);
      if (!prev) {
        files.set(rel, {
          statementMap: fc.statementMap,
          fnMap: fc.fnMap ?? {},
          branchMap: fc.branchMap ?? {},
          hash: fc.hash,
          s: { ...fc.s },
          f: { ...fc.f },
          b: Object.fromEntries(Object.entries(fc.b ?? {}).map(([k, v]) => [k, [...v]])),
        });
        continue;
      }
      if (prev.hash !== undefined && fc.hash !== undefined && prev.hash !== fc.hash) {
        skipped += 1;
        continue;
      }
      addCounts(prev.s, fc.s);
      addCounts(prev.f, fc.f);
      addCounts(prev.b, fc.b);
    }
  }
  return { files, skipped };
}

/** Per-line hit counts: the max over the statements starting on each line. */
export function lineCoverage(fc) {
  const lines = new Map();
  for (const [id, count] of Object.entries(fc.s)) {
    const loc = fc.statementMap[id];
    if (!loc) continue;
    const line = loc.start.line;
    const prev = lines.get(line);
    if (prev === undefined || prev < count) lines.set(line, count);
  }
  return new Map([...lines].sort((a, b) => a[0] - b[0]));
}

/** Serialize merged file coverage to lcov text. */
export function toLcov(files) {
  const out = [];
  for (const [rel, fc] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push("TN:", `SF:${rel}`);
    const fns = Object.entries(fc.fnMap);
    for (const [, meta] of fns) {
      const decl = meta.decl ?? meta.loc;
      out.push(`FN:${decl.start.line},${meta.name}`);
    }
    out.push(`FNF:${fns.length}`, `FNH:${fns.filter(([id]) => (fc.f[id] ?? 0) > 0).length}`);
    for (const [id, meta] of fns) out.push(`FNDA:${fc.f[id] ?? 0},${meta.name}`);
    const lines = lineCoverage(fc);
    for (const [line, n] of lines) out.push(`DA:${line},${n}`);
    out.push(`LF:${lines.size}`, `LH:${[...lines.values()].filter((n) => n > 0).length}`);
    let brf = 0;
    let brh = 0;
    for (const [id, arms] of Object.entries(fc.b)) {
      const meta = fc.branchMap[id];
      if (!meta) continue;
      arms.forEach((taken, i) => {
        out.push(`BRDA:${meta.loc.start.line},${id},${i},${taken}`);
        brf += 1;
        if (taken > 0) brh += 1;
      });
    }
    out.push(`BRF:${brf}`, `BRH:${brh}`, "end_of_record");
  }
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

/** Read every `*.json` dump in `dir` (a malformed one is reported and skipped). */
export function readDumps(dir, log = console.warn) {
  if (!existsSync(dir)) return [];
  const maps = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      maps.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
    } catch (e) {
      log(`istanbul-to-lcov: skipping unreadable dump ${name}: ${e.message}`);
    }
  }
  return maps;
}

export function parseArgs(argv) {
  const names = { "--in-dir": "inDir", "--out": "out", "--root": "root" };
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const name = names[argv[i]];
    if (!name || i + 1 >= argv.length) throw new Error(`bad argument: ${argv[i]}`);
    opts[name] = argv[++i];
  }
  if (!opts.inDir || !opts.out) throw new Error("--in-dir and --out are required");
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`istanbul-to-lcov: ${e.message}`);
    console.error("usage: istanbul-to-lcov.mjs --in-dir <dir> --out <lcov> [--root <repo>]");
    return 2;
  }
  const maps = readDumps(opts.inDir);
  if (maps.length === 0) {
    console.log(`istanbul-to-lcov: no coverage dumps in ${opts.inDir}; nothing written.`);
    return 0;
  }
  const { files, skipped } = mergeCoverageMaps(maps, opts.root ?? process.cwd());
  writeFileSync(opts.out, toLcov(files));
  console.log(
    `istanbul-to-lcov: ${maps.length} dump(s), ${files.size} file(s) -> ${opts.out}` +
      (skipped > 0 ? ` (${skipped} record(s) from a different build skipped)` : "")
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
