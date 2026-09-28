import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSummary, pct, summarizeLcov } from "./lcov-summary.mjs";

const LCOV = [
  "SF:src/a.ts",
  "FNF:4",
  "FNH:3",
  "BRF:2",
  "BRH:1",
  "LF:10",
  "LH:8",
  "end_of_record",
  "SF:core/src/b.rs",
  "FNF:1",
  "FNH:0",
  "LF:10\r",
  "LH:2",
  "DA:1,5",
  "end_of_record",
].join("\n");

describe("summarizeLcov", () => {
  it("sums the per-record totals and ignores detail lines", () => {
    expect(summarizeLcov(LCOV)).toEqual({ LF: 20, LH: 10, FNF: 5, FNH: 3, BRF: 2, BRH: 1 });
  });

  it("returns zeros for an empty tracefile", () => {
    expect(summarizeLcov("")).toEqual({ LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 });
  });
});

describe("formatSummary", () => {
  it("prints the four summary lines coverage.sh writes to summary.txt", () => {
    expect(formatSummary(summarizeLcov(LCOV)).split("\n")).toEqual([
      "lines:     10/20  (50.00%)",
      "functions: 3/5  (60.00%)",
      "branches:  1/2  (50.00%)",
      "UNIFIED WHOLE-APP LINE COVERAGE: 50.00%",
    ]);
  });

  it("reports 0% instead of NaN when nothing was found", () => {
    expect(pct(0, 0)).toBe(0);
    expect(formatSummary(summarizeLcov(""))).toContain("COVERAGE: 0.00%");
  });
});

describe("CLI", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "lcov-summary.mjs");

  it("summarizes a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lcov-summary-"));
    const file = path.join(dir, "merged.lcov");
    writeFileSync(file, LCOV);
    const out = execFileSync(process.execPath, [script, file], { encoding: "utf8" });
    expect(out).toContain("UNIFIED WHOLE-APP LINE COVERAGE: 50.00%");
  });

  it("exits 2 without an argument", () => {
    expect(() => execFileSync(process.execPath, [script], { stdio: "pipe" })).toThrow(
      expect.objectContaining({ status: 2 })
    );
  });
});
