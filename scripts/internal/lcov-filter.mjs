#!/usr/bin/env node
// Keep only the lcov records under one repo directory (#4341, TOOL2-003).
//
// The RDP sidecar is excluded from the workspace and gets its own
// `cargo llvm-cov` pass in scripts/coverage.sh / coverage.cmd. That pass also
// instruments the sidecar's path dependencies (termihub-core, win-security, the
// vendored IronRDP forks), so its report repeats files the workspace report
// already owns. Concatenated as-is, core's lines would be counted twice and
// diluted by the sidecar's partial use of them. This filter keeps the
// sidecar's own sources only, so the unit lcov never holds a file twice.
//
// Usage:
//   node scripts/internal/lcov-filter.mjs --in <lcov> --out <lcov> --root <dir>
//        --keep <dir/> [--drop <dir/>]...
//   A record is kept when its SF: path, relative to --root, starts with
//   --keep and with none of the --drop prefixes. Paths outside --root are
//   dropped.
import { readFileSync, writeFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";

const norm = (p) => p.replace(/\\/g, "/");

/** `sfPath` relative to `root` (forward slashes), or null when outside it. */
export function relativize(sfPath, root) {
  const p = norm(sfPath);
  const r = norm(root).replace(/\/+$/, "");
  if (r && p.toLowerCase().startsWith(r.toLowerCase() + "/")) return p.slice(r.length + 1);
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return null;
  return p;
}

/** Filter lcov `text` to the records under `keep` and outside every `drop`. */
export function filterLcov(text, root, keep, drop = []) {
  const wanted = (sf) => {
    const rel = relativize(sf, root);
    return rel !== null && rel.startsWith(keep) && !drop.some((d) => rel.startsWith(d));
  };
  const out = [];
  let record = [];
  let keepRecord = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    record.push(line);
    if (line.startsWith("SF:")) keepRecord = wanted(line.slice(3));
    if (line === "end_of_record") {
      if (keepRecord) out.push(...record);
      record = [];
      keepRecord = false;
    }
  }
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

export function parseArgs(argv) {
  const opts = { input: null, output: null, root: process.cwd(), keep: null, drop: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--in":
        opts.input = val();
        break;
      case "--out":
        opts.output = val();
        break;
      case "--root":
        opts.root = val();
        break;
      case "--keep":
        opts.keep = norm(val());
        break;
      case "--drop":
        opts.drop.push(norm(val()));
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.input || !opts.output || !opts.keep) {
    throw new Error("--in, --out and --keep are required");
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`lcov-filter: ${e.message}`);
    return 2;
  }
  const filtered = filterLcov(readFileSync(opts.input, "utf8"), opts.root, opts.keep, opts.drop);
  writeFileSync(opts.output, filtered);
  const records = filtered.split("\n").filter((l) => l === "end_of_record").length;
  console.log(`lcov-filter: kept ${records} record(s) under ${opts.keep} -> ${opts.output}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
