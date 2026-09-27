#!/usr/bin/env node
// Coverage ratchet — fail-on-decrease gate against a committed baseline
// (audit findings CI-011, TBE-007, TOOL-011; #3740).
//
// Reads the UNIT-test lcov tracefiles that scripts/coverage.sh produces (the
// vitest frontend report and the cargo-llvm-cov Rust report), computes the line
// coverage of each gated component, and compares it with
// scripts/coverage-baseline.json:
//
//   frontend   src/**            (vitest/v8)
//   core       core/**           (cargo-llvm-cov)
//   agent      agent/**
//   src-tauri  src-tauri/**
//   unified    every record in the unit lcovs (incl. plugin-api, vendor, ...)
//
// A component fails when its line % drops more than `tolerance` percentage
// points below its baseline. The nightly integration overlay (TOOL-005) is
// deliberately NOT gated: whether a fresh integration lcov exists, and which of
// its files are stale, varies run to run, so it would make the gate flaky.
//
// Baselines are per platform (process.platform: linux / darwin / win32),
// because cfg-gated Rust code makes the numbers OS-dependent. CI grades
// `linux`; release-check grades whatever machine it runs on.
//
// Usage:
//   node scripts/internal/coverage-ratchet.mjs [--check]        (default)
//   node scripts/internal/coverage-ratchet.mjs --update [--allow-decrease]
// Options:
//   --lcov <file>        lcov to read (repeatable). Default: coverage/lcov.info
//                        and coverage-unified/rust.lcov.
//   --baseline <file>    Default: scripts/coverage-baseline.json
//   --root <dir>         Repo root used to relativize SF: paths. Default: cwd.
//   --platform <name>    Baseline key. Default: process.platform.
//   --report <file>      Also write the result table (markdown) here.
//
// --update raises each component's baseline to the current value (rounded
// DOWN to 2 decimals). It never lowers one unless --allow-decrease is given,
// so an accidental bump on a worse tree cannot loosen the gate.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS = ["frontend", "core", "agent", "src-tauri", "unified"];
const DIR_TO_COMPONENT = {
  src: "frontend",
  core: "core",
  agent: "agent",
  "src-tauri": "src-tauri",
};
export const DEFAULT_TOLERANCE = 0.25;

/** Map an lcov SF: path to its gated component (or null: unified only). */
export function componentFor(sfPath, root) {
  const norm = (p) => p.replace(/\\/g, "/");
  let p = norm(sfPath);
  const r = norm(root).replace(/\/+$/, "");
  if (r && (p.startsWith(r + "/") || p.toLowerCase().startsWith(r.toLowerCase() + "/"))) {
    p = p.slice(r.length + 1);
  }
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return null; // outside the repo
  const first = p.split("/")[0];
  return DIR_TO_COMPONENT[first] ?? null;
}

/** Sum LF/LH per component across lcov texts. Returns { comp: {found, hit} }. */
export function tallyLcov(texts, root) {
  const totals = Object.fromEntries(COMPONENTS.map((c) => [c, { found: 0, hit: 0 }]));
  for (const text of texts) {
    let comp = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        comp = componentFor(line.slice(3), root);
      } else if (line.startsWith("LF:") || line.startsWith("LH:")) {
        const n = Number.parseInt(line.slice(3), 10);
        if (!Number.isFinite(n)) continue;
        const key = line.startsWith("LF:") ? "found" : "hit";
        totals.unified[key] += n;
        if (comp) totals[comp][key] += n;
      } else if (line === "end_of_record") {
        comp = null;
      }
    }
  }
  return totals;
}

/** Percentages per component; null when a component has no lines at all. */
export function percentages(totals) {
  return Object.fromEntries(
    Object.entries(totals).map(([c, { found, hit }]) => [c, found > 0 ? (hit * 100) / found : null])
  );
}

const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

/**
 * Compare current percentages with a platform baseline.
 * Returns { ok, rows: [{component, baseline, current, delta, status}] }.
 */
export function check(current, platformBaseline, tolerance) {
  const rows = [];
  let ok = true;
  for (const component of COMPONENTS) {
    const baseline = platformBaseline[component];
    if (baseline === undefined) continue;
    const cur = current[component];
    let status;
    if (cur === null || cur === undefined) {
      status = "MISSING";
      ok = false;
    } else if (cur < baseline - tolerance) {
      status = "FAIL";
      ok = false;
    } else if (cur >= baseline + 0.5) {
      status = "ok (raise baseline)";
    } else {
      status = "ok";
    }
    rows.push({
      component,
      baseline,
      current: cur,
      delta: cur === null || cur === undefined ? null : cur - baseline,
      status,
    });
  }
  return { ok, rows };
}

/** New platform baseline: raise-only unless allowDecrease. */
export function updatedBaseline(current, platformBaseline = {}, allowDecrease = false) {
  const next = { ...platformBaseline };
  for (const component of COMPONENTS) {
    const cur = current[component];
    if (cur === null || cur === undefined) continue;
    const measured = floor2(cur);
    const old = platformBaseline[component];
    next[component] = old === undefined || allowDecrease ? measured : Math.max(old, measured);
  }
  return next;
}

export function formatTable(rows, platform, tolerance) {
  const f = (x) => (x === null || x === undefined ? "-" : x.toFixed(2));
  const sign = (x) => (x === null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`);
  const lines = [
    `Coverage ratchet (platform: ${platform}, tolerance: ${tolerance} pp, line coverage)`,
    "",
    "| component | baseline % | current % | delta | status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.component} | ${f(r.baseline)} | ${f(r.current)} | ${sign(r.delta)} | ${r.status} |`
    ),
  ];
  return lines.join("\n");
}

export function parseArgs(argv) {
  const opts = {
    mode: "check",
    lcovs: [],
    baseline: "scripts/coverage-baseline.json",
    root: process.cwd(),
    platform: process.platform,
    report: null,
    allowDecrease: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--check":
        opts.mode = "check";
        break;
      case "--update":
        opts.mode = "update";
        break;
      case "--allow-decrease":
        opts.allowDecrease = true;
        break;
      case "--lcov":
        opts.lcovs.push(val());
        break;
      case "--baseline":
        opts.baseline = val();
        break;
      case "--root":
        opts.root = val();
        break;
      case "--platform":
        opts.platform = val();
        break;
      case "--report":
        opts.report = val();
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.lcovs.length === 0) {
    opts.lcovs = ["coverage/lcov.info", "coverage-unified/rust.lcov"];
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`coverage-ratchet: ${e.message}`);
    return 2;
  }

  const missing = opts.lcovs.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error(`coverage-ratchet: missing lcov input(s): ${missing.join(", ")}`);
    console.error("  Run ./scripts/coverage.sh (frontend + Rust) first; the gate needs both.");
    return 1;
  }
  const current = percentages(
    tallyLcov(
      opts.lcovs.map((f) => readFileSync(f, "utf8")),
      opts.root
    )
  );

  const doc = existsSync(opts.baseline)
    ? JSON.parse(readFileSync(opts.baseline, "utf8"))
    : { tolerance: DEFAULT_TOLERANCE, platforms: {} };
  doc.platforms ??= {};
  const tolerance = doc.tolerance ?? DEFAULT_TOLERANCE;
  const platformBaseline = doc.platforms[opts.platform];

  if (opts.mode === "update") {
    const next = updatedBaseline(current, platformBaseline, opts.allowDecrease);
    doc.platforms[opts.platform] = next;
    writeFileSync(opts.baseline, JSON.stringify(doc, null, 2) + "\n");
    const { rows } = check(current, next, tolerance);
    console.log(formatTable(rows, opts.platform, tolerance));
    console.log(`\nBaseline for '${opts.platform}' written to ${opts.baseline} — commit it.`);
    return 0;
  }

  if (!platformBaseline) {
    console.error(
      `coverage-ratchet: FAIL — no baseline for platform '${opts.platform}' in ${opts.baseline}.`
    );
    console.error("  Record one with: ./scripts/coverage.sh --update-baseline  (then commit it)");
    return 1;
  }
  const { ok, rows } = check(current, platformBaseline, tolerance);
  const table = formatTable(rows, opts.platform, tolerance);
  console.log(table);
  if (opts.report) writeFileSync(opts.report, table + "\n");
  if (!ok) {
    console.error(
      `\ncoverage-ratchet: FAIL — coverage dropped more than ${tolerance} pp below the baseline.`
    );
    console.error("  Add tests for the new/changed code, or — if the drop is intended and");
    console.error("  justified — lower the value in the baseline file in a reviewed commit");
    console.error("  (./scripts/coverage.sh --update-baseline never lowers it on its own).");
    return 1;
  }
  const raise = rows.some((r) => r.status.startsWith("ok (raise"));
  console.log(
    raise
      ? "\ncoverage-ratchet: PASS — coverage improved; lock it in: ./scripts/coverage.sh --update-baseline"
      : "\ncoverage-ratchet: PASS"
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
