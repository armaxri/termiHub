import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePath,
  parseLcov,
  mergeCoverage,
  formatLcov,
  formatReport,
  functionKey,
  recordTotals,
  parseArgs,
  readSkipList,
} from "./lcov-merge.mjs";

const ROOT = "/home/runner/work/termiHub/termiHub";

const UNIT = [
  "TN:",
  `SF:${ROOT}/core/src/backends/ssh.rs`,
  "FN:10,connect",
  "FN:20,reconnect",
  "FNDA:3,connect",
  "FNDA:0,reconnect",
  "FNF:2",
  "FNH:1",
  "BRDA:11,0,0,2",
  "BRDA:11,0,1,0",
  "BRF:2",
  "BRH:1",
  "DA:10,3",
  "DA:11,3",
  "DA:20,0",
  "DA:21,0",
  "LF:4",
  "LH:2",
  "end_of_record",
  "TN:",
  "SF:src/App.tsx",
  "DA:1,1",
  "DA:2,0",
  "LF:2",
  "LH:1",
  "end_of_record",
].join("\n");

const INTEGRATION = [
  `SF:${ROOT}/core/src/backends/ssh.rs`,
  "FN:20,reconnect",
  "FNDA:5,reconnect",
  "BRDA:11,0,1,4",
  "DA:10,1",
  "DA:20,5",
  "DA:21,5",
  "DA:99,7",
  "end_of_record",
  `SF:${ROOT}/core/tests/ssh.rs`,
  "DA:1,1",
  "end_of_record",
  `SF:${ROOT}/core/src/backends/telnet.rs`,
  "DA:1,1",
  "end_of_record",
].join("\n");

function totals(lcov) {
  const t = {};
  for (const line of lcov.split("\n")) {
    const m = /^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/.exec(line);
    if (m) t[m[1]] = (t[m[1]] ?? 0) + Number(m[2]);
  }
  return t;
}

describe("normalizePath", () => {
  it("strips the root prefix and backslashes", () => {
    expect(normalizePath(`${ROOT}/core/src/a.rs`, ROOT)).toBe("core/src/a.rs");
    expect(normalizePath("D:\\a\\t\\core\\src\\a.rs", "D:\\a\\t")).toBe("core/src/a.rs");
    expect(normalizePath("./src/App.tsx", ROOT)).toBe("src/App.tsx");
  });

  it("leaves paths outside the root absolute", () => {
    expect(normalizePath("/elsewhere/x.rs", ROOT)).toBe("/elsewhere/x.rs");
  });
});

describe("parseLcov", () => {
  it("keys records by normalized path and keeps detail lines", () => {
    const files = parseLcov(UNIT, ROOT);
    expect([...files.keys()]).toEqual(["core/src/backends/ssh.rs", "src/App.tsx"]);
    const ssh = files.get("core/src/backends/ssh.rs");
    expect(ssh.lines.get("10")).toBe(3);
    expect(ssh.fnHits.get("reconnect")).toBe(0);
    expect(ssh.branches.get("11,0,1")).toBe(0);
  });

  it("merges repeated SF records for the same file", () => {
    const files = parseLcov(
      "SF:a.rs\nDA:1,1\nend_of_record\nSF:a.rs\nDA:1,2\nDA:2,0\nend_of_record\n"
    );
    expect(files.get("a.rs").lines).toEqual(
      new Map([
        ["1", 3],
        ["2", 0],
      ])
    );
  });

  it("accepts the lcov 2.x FN:<start>,<end>,<name> form", () => {
    const files = parseLcov("SF:a.rs\nFN:1,5,f\nFNDA:2,f\nend_of_record\n");
    expect(files.get("a.rs").fnHits.get("f")).toBe(2);
  });

  it("treats '-' branch counts as not-executed", () => {
    const files = parseLcov("SF:a.rs\nBRDA:1,0,0,-\nend_of_record\n");
    expect(files.get("a.rs").branches.get("1,0,0")).toBeNull();
  });
});

describe("mergeCoverage", () => {
  const base = parseLcov(UNIT, ROOT);
  const overlay = parseLcov(INTEGRATION, ROOT);

  it("sums hits so integration-only lines/functions/branches become covered", () => {
    const { merged, stats } = mergeCoverage(base, overlay);
    const ssh = merged.get("core/src/backends/ssh.rs");
    expect(ssh.lines.get("10")).toBe(4);
    expect(ssh.lines.get("20")).toBe(5);
    expect(ssh.fnHits.get("reconnect")).toBe(5);
    expect(ssh.branches.get("11,0,1")).toBe(4);
    expect(stats.newlyCoveredLines).toBe(2);
    expect(stats.perFile.get("core/src/backends/ssh.rs")).toBe(2);
  });

  it("keeps the base denominator: no new lines, no new files", () => {
    const { merged, stats } = mergeCoverage(base, overlay);
    expect(merged.get("core/src/backends/ssh.rs").lines.has("99")).toBe(false);
    expect(merged.has("core/tests/ssh.rs")).toBe(false);
    expect(merged.has("core/src/backends/telnet.rs")).toBe(false);
    expect(stats.notInBase).toBe(2);
    const t = totals(formatLcov(merged));
    expect(t.LF).toBe(6);
    expect(t.LH).toBe(5);
  });

  it("skips stale files entirely", () => {
    const { merged, stats } = mergeCoverage(base, overlay, new Set(["core/src/backends/ssh.rs"]));
    expect(merged.get("core/src/backends/ssh.rs").lines.get("20")).toBe(0);
    expect(stats.staleSkipped).toEqual(["core/src/backends/ssh.rs"]);
    expect(stats.newlyCoveredLines).toBe(0);
  });

  it("does not mutate the base map", () => {
    mergeCoverage(base, overlay);
    expect(base.get("core/src/backends/ssh.rs").lines.get("20")).toBe(0);
  });
});

describe("functionKey", () => {
  it("ignores the Rust crate hash so two builds' symbols match", () => {
    const a = "_RNvMNtCsiRBh1FGScaA_13termihub_core3ssh7connect";
    const b = "_RNvMNtCs9zzXy12_13termihub_core3ssh7connect";
    expect(functionKey(a)).toBe(functionKey(b));
    expect(functionKey("_ZN4core3ssh7connect17h0123456789abcdefE")).toBe(
      functionKey("_ZN4core3ssh7connect17hfedcba9876543210E")
    );
    expect(functionKey("renderApp")).toBe("renderApp");
  });

  it("merges function hits across differing crate hashes", () => {
    const base = parseLcov(
      "SF:a.rs\nFN:1,_RNvCsAAA_4core1f\nFNDA:0,_RNvCsAAA_4core1f\nDA:1,0\nend_of_record\n"
    );
    const overlay = parseLcov("SF:a.rs\nFNDA:4,_RNvCsBBB_4core1f\nDA:1,4\nend_of_record\n");
    const { merged } = mergeCoverage(base, overlay);
    expect(merged.get("a.rs").fnHits.get("_RNvCsAAA_4core1f")).toBe(4);
  });
});

describe("recordTotals", () => {
  // cargo-llvm-cov style: LF counts more lines than the DA detail, FNF counts
  // one function per source function although FN lists two crate-hash names.
  const LLVM = [
    "SF:core/src/a.rs",
    "FN:1,_RNvCsAAA_4core1f",
    "FN:1,_RNvCsBBB_4core1f",
    "FN:9,_RNvCsAAA_4core1g",
    "FNDA:0,_RNvCsAAA_4core1f",
    "FNDA:0,_RNvCsBBB_4core1f",
    "FNDA:1,_RNvCsAAA_4core1g",
    "FNF:2",
    "FNH:1",
    "DA:1,0",
    "DA:2,0",
    "DA:9,1",
    "LF:5",
    "LH:1",
    "end_of_record",
  ].join("\n");

  it("keeps the source report's own totals when nothing is merged", () => {
    const rec = parseLcov(LLVM).get("core/src/a.rs");
    expect(recordTotals(rec)).toEqual({ LF: 5, LH: 1, FNF: 2, FNH: 1, BRF: 0, BRH: 0 });
  });

  it("raises hits by what the overlay newly covered, per deduplicated function", () => {
    const overlay = parseLcov(
      "SF:core/src/a.rs\nFNDA:3,_RNvCsZZZ_4core1f\nFNDA:2,_RNvCsZZZ_4core1g\nDA:1,3\nDA:9,2\nend_of_record\n"
    );
    const { merged } = mergeCoverage(parseLcov(LLVM), overlay);
    expect(recordTotals(merged.get("core/src/a.rs"))).toEqual({
      LF: 5,
      LH: 2,
      FNF: 2,
      FNH: 2,
      BRF: 0,
      BRH: 0,
    });
  });

  it("caps hits at the found count", () => {
    const rec = parseLcov("SF:a\nDA:1,0\nLF:1\nLH:1\nend_of_record\n").get("a");
    rec.gained.lines = 3;
    expect(recordTotals(rec).LH).toBe(1);
  });
});

describe("formatLcov", () => {
  it("round-trips unit coverage with identical totals", () => {
    const out = formatLcov(parseLcov(UNIT, ROOT));
    expect(totals(out)).toEqual(totals(UNIT));
    expect(out).toContain("SF:core/src/backends/ssh.rs");
    expect(out.trim().endsWith("end_of_record")).toBe(true);
  });
});

describe("formatReport", () => {
  it("lists newly covered lines, stale and ignored files", () => {
    const { stats } = mergeCoverage(
      parseLcov(UNIT, ROOT),
      parseLcov(INTEGRATION, ROOT),
      new Set(["src/App.tsx"])
    );
    stats.staleSkipped.push("x.rs");
    const md = formatReport(stats);
    expect(md).toContain("covered ONLY by the integration lane: **2**");
    expect(md).toContain("skipped as stale");
    expect(md).toContain("not in the unit report): 2");
    expect(md).toContain("| `core/src/backends/ssh.rs` | 2 |");
  });

  it("truncates the per-file table", () => {
    const perFile = new Map(Array.from({ length: 5 }, (_, i) => [`f${i}.rs`, i + 1]));
    const md = formatReport(
      { newlyCoveredLines: 15, perFile, staleSkipped: [], notInBase: 0 },
      { top: 2 }
    );
    expect(md).toContain("| `f4.rs` | 5 |");
    expect(md).not.toContain("`f0.rs`");
    expect(md).toContain("… 3 more");
  });
});

describe("parseArgs / readSkipList", () => {
  it("requires base, overlay and out", () => {
    expect(() => parseArgs(["--base", "a"])).toThrow(/required/);
    expect(() => parseArgs(["--bogus", "a"])).toThrow(/bad argument/);
    expect(parseArgs(["--base", "a", "--overlay", "b", "--out", "c", "--root", "r"])).toEqual({
      base: "a",
      overlay: "b",
      out: "c",
      root: "r",
    });
  });

  it("reads one path per line, ignoring blanks", () => {
    expect(readSkipList("a.rs\r\n\n core\\b.rs \n")).toEqual(new Set(["a.rs", "core/b.rs"]));
  });
});

describe("CLI", () => {
  it("writes the merged lcov and the gap report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lcov-merge-"));
    const f = (n, body) => {
      const p = path.join(dir, n);
      writeFileSync(p, body);
      return p;
    };
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "lcov-merge.mjs");
    const stdout = execFileSync(
      process.execPath,
      [
        script,
        "--base",
        f("unit.lcov", UNIT),
        "--overlay",
        f("int.lcov", INTEGRATION),
        "--skip-list",
        f("stale.txt", "src/App.tsx\n"),
        "--root",
        ROOT,
        "--out",
        path.join(dir, "merged.lcov"),
        "--report",
        path.join(dir, "gap.md"),
      ],
      { encoding: "utf8" }
    );
    expect(stdout).toContain("**2**");
    expect(readFileSync(path.join(dir, "gap.md"), "utf8")).toBe(stdout);
    expect(totals(readFileSync(path.join(dir, "merged.lcov"), "utf8")).LH).toBe(5);
  });
});
