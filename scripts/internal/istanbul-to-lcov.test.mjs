// @vitest-environment node
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lineCoverage,
  mergeCoverageMaps,
  parseArgs,
  readDumps,
  toLcov,
} from "./istanbul-to-lcov.mjs";
import { mergeCoverage, parseLcov } from "./lcov-merge.mjs";

const ROOT = "/home/runner/work/termiHub/termiHub";
const SCRIPT = fileURLToPath(new URL("./istanbul-to-lcov.mjs", import.meta.url));

const loc = (line, col = 0) => ({ start: { line, column: col }, end: { line, column: col + 5 } });

function fileCov(counts = {}, { hash = "h1", file = "src/a.ts" } = {}) {
  return {
    [`${ROOT}/${file}`]: {
      path: `${ROOT}/${file}`,
      hash,
      statementMap: { 0: loc(1), 1: loc(2), 2: loc(2, 10), 3: loc(5) },
      fnMap: { 0: { name: "go", decl: loc(1), loc: loc(1), line: 1 } },
      branchMap: { 0: { loc: loc(2), type: "if", locations: [loc(2), loc(2)], line: 2 } },
      s: { 0: 1, 1: 0, 2: 3, 3: 0, ...counts.s },
      f: { 0: 1, ...counts.f },
      b: { 0: [0, 1], ...counts.b },
    },
  };
}

describe("lineCoverage", () => {
  it("takes the highest statement count per start line", () => {
    const { files } = mergeCoverageMaps([fileCov()], ROOT);
    expect([...lineCoverage(files.get("src/a.ts"))]).toEqual([
      [1, 1],
      [2, 3],
      [5, 0],
    ]);
  });
});

describe("mergeCoverageMaps", () => {
  it("sums hits across dumps of the same build, keyed repo-relative", () => {
    const { files, skipped } = mergeCoverageMaps(
      [fileCov(), fileCov({ s: { 3: 2 }, f: { 0: 4 }, b: { 0: [2, 0] } })],
      ROOT
    );
    expect(skipped).toBe(0);
    const fc = files.get("src/a.ts");
    expect(fc.s).toEqual({ 0: 2, 1: 0, 2: 6, 3: 2 });
    expect(fc.f).toEqual({ 0: 5 });
    expect(fc.b).toEqual({ 0: [2, 1] });
  });

  it("does not mutate its inputs", () => {
    const a = fileCov();
    mergeCoverageMaps([a, fileCov()], ROOT);
    expect(a[`${ROOT}/src/a.ts`].s[0]).toBe(1);
    expect(a[`${ROOT}/src/a.ts`].b[0]).toEqual([0, 1]);
  });

  it("skips a dump of the same file from a different build", () => {
    const { files, skipped } = mergeCoverageMaps(
      [fileCov(), fileCov({ s: { 3: 9 } }, { hash: "h2" })],
      ROOT
    );
    expect(skipped).toBe(1);
    expect(files.get("src/a.ts").s[3]).toBe(0);
  });

  it("normalizes Windows paths", () => {
    const win = {
      "C:\\r\\src\\w.ts": { ...fileCov()[`${ROOT}/src/a.ts`], path: "C:\\r\\src\\w.ts" },
    };
    const { files } = mergeCoverageMaps([win], "C:\\r");
    expect([...files.keys()]).toEqual(["src/w.ts"]);
  });
});

describe("toLcov", () => {
  it("writes lcovonly-shaped records that lcov-merge reads back", () => {
    const { files } = mergeCoverageMaps([fileCov()], ROOT);
    const text = toLcov(files);
    expect(text).toBe(
      [
        "TN:",
        "SF:src/a.ts",
        "FN:1,go",
        "FNF:1",
        "FNH:1",
        "FNDA:1,go",
        "DA:1,1",
        "DA:2,3",
        "DA:5,0",
        "LF:3",
        "LH:2",
        "BRDA:2,0,0,0",
        "BRDA:2,0,1,1",
        "BRF:2",
        "BRH:1",
        "end_of_record",
        "",
      ].join("\n")
    );
    const parsed = parseLcov(text);
    expect(parsed.get("src/a.ts").totals).toMatchObject({ LF: 3, LH: 2 });
  });

  it("only raises lines the unit report already counts when overlaid", () => {
    const base = parseLcov("TN:\nSF:src/a.ts\nDA:1,0\nDA:5,0\nLF:2\nLH:0\nend_of_record\n");
    const { files } = mergeCoverageMaps([fileCov({ s: { 3: 1 } })], ROOT);
    const { stats } = mergeCoverage(base, parseLcov(toLcov(files)));
    expect(stats.newlyCoveredLines).toBe(2); // lines 1 and 5; line 2 is not in the base
  });

  it("is empty for no files", () => {
    expect(toLcov(new Map())).toBe("");
  });
});

describe("CLI", () => {
  it("converts a directory of dumps and skips a corrupt one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "i2l-"));
    const dumps = path.join(dir, "frontend");
    mkdirSync(dumps);
    writeFileSync(path.join(dumps, "a.json"), JSON.stringify(fileCov()));
    writeFileSync(path.join(dumps, "b.json"), JSON.stringify(fileCov({ s: { 3: 1 } })));
    writeFileSync(path.join(dumps, "broken.json"), "{");
    const out = path.join(dir, "frontend.lcov");
    const stdout = execFileSync("node", [SCRIPT, "--in-dir", dumps, "--out", out, "--root", ROOT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toContain("2 dump(s), 1 file(s)");
    expect(readFileSync(out, "utf8")).toContain("DA:5,1");
  });

  it("writes nothing and exits 0 when there are no dumps", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "i2l-"));
    const out = path.join(dir, "x.lcov");
    execFileSync("node", [SCRIPT, "--in-dir", path.join(dir, "missing"), "--out", out]);
    expect(existsSync(out)).toBe(false);
    expect(readDumps(path.join(dir, "missing"))).toEqual([]);
  });

  it("requires --in-dir and --out", () => {
    expect(() => parseArgs(["--in-dir", "x"])).toThrow(/required/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/bad argument/);
  });
});
