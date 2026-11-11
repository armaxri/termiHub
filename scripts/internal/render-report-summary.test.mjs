import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  compare,
  formatBudget,
  formatValue,
  legacyRows,
  loadReport,
  parseArgs,
  renderFiles,
  renderReport,
  verdictOf,
} from "./render-report-summary.mjs";

const PERF = {
  schema: 1,
  report: "plugin-sandbox-perf",
  title: "Plugin sandbox perf gate",
  release: true,
  rows: [
    {
      metric: "keystroke-to-echo p99 added",
      value: 41,
      unit: "µs",
      op: "<=",
      budget: 500,
      verdict: "pass",
    },
    {
      metric: "idle helper memory",
      value: 16000,
      unit: "KiB",
      op: "<=",
      budget: 15360,
      verdict: "fail",
    },
    { metric: "throughput vs in-process (reported only)", value: 3, unit: "%", verdict: "info" },
  ],
};

const AUDIT = {
  schema: 1,
  report: "shell-side-effects",
  title: "Injected shell setup side effects",
  rows: [
    {
      metric: "bash · PROMPT_COMMAND changed",
      value: 1,
      baseline: 0,
      baseline_label: "plain shell",
      verdict: "info",
    },
  ],
};

describe("formatValue / formatBudget", () => {
  it("joins value and unit, and says n/a for a missing value", () => {
    expect(formatValue(41, "µs")).toBe("41 µs");
    expect(formatValue(3)).toBe("3");
    expect(formatValue(null, "KiB")).toBe("n/a");
  });

  it("renders a budget with its operator, a baseline with its label, else a dash", () => {
    expect(formatBudget({ op: "<=", budget: 500, unit: "µs" })).toBe("≤ 500 µs");
    expect(formatBudget({ op: ">=", budget: 100, unit: "MB/s" })).toBe("≥ 100 MB/s");
    expect(formatBudget({ baseline: 0, baseline_label: "plain shell" })).toBe("plain shell: 0");
    expect(formatBudget({ baseline: 2 })).toBe("baseline: 2");
    expect(formatBudget({})).toBe("—");
  });
});

describe("verdictOf", () => {
  it("keeps the test's own verdict", () => {
    expect(verdictOf({ value: 1, op: "<=", budget: 0, verdict: "info" })).toBe("info");
    expect(verdictOf({ verdict: "fail" })).toBe("fail");
  });

  it("computes one from the budget when the test gave none", () => {
    expect(verdictOf({ value: 1, op: "<=", budget: 2 })).toBe("pass");
    expect(verdictOf({ value: 3, op: "<=", budget: 2 })).toBe("fail");
    expect(verdictOf({ value: 50, op: ">=", budget: 100 })).toBe("fail");
  });

  it("is reported-only when nothing can be compared", () => {
    expect(verdictOf({ value: null, op: "<=", budget: 2 })).toBe("info");
    expect(verdictOf({ value: 1 })).toBe("info");
    expect(compare(1, "~", 2)).toBeUndefined();
  });
});

describe("legacyRows", () => {
  it("turns the old flat perf report into reported-only rows", () => {
    expect(legacyRows({ latency_p99_added_us: 41, idle_rss_kib: null, nested: {} })).toEqual([
      { metric: "latency_p99_added_us", value: 41, verdict: "info" },
      { metric: "idle_rss_kib", value: null, verdict: "info" },
    ]);
  });
});

describe("renderReport", () => {
  it("renders the perf gate as a table with the commit and a breach count", () => {
    const md = renderReport(PERF, {
      name: "plugin-sandbox-perf.json",
      commit: "0123456789abcdef0123",
      label: "ubuntu-latest · develop",
    });
    expect(md).toContain("### Plugin sandbox perf gate (ubuntu-latest · develop) · `0123456789ab`");
    expect(md).toContain("**1 of 2 budgets breached.**");
    expect(md).toContain("| keystroke-to-echo p99 added | 41 µs | ≤ 500 µs | pass |");
    expect(md).toContain("| idle helper memory | 16000 KiB | ≤ 15360 KiB | **FAIL** |");
    expect(md).toContain("| throughput vs in-process (reported only) | 3 % | — | reported |");
  });

  it("says all budgets were met when none failed", () => {
    const ok = { ...PERF, rows: PERF.rows.filter((r) => r.verdict !== "fail") };
    expect(renderReport(ok, { name: "x.json" })).toContain("All 1 budgets met.");
  });

  it("flags a debug build", () => {
    expect(renderReport({ ...PERF, release: false }, { name: "x.json" })).toContain("Debug build");
  });

  it("renders the audit against the plain shell, with no budget line", () => {
    const md = renderReport(AUDIT, { name: "shell-side-effects.json" });
    expect(md).toContain("| bash · PROMPT_COMMAND changed | 1 | plain shell: 0 | reported |");
    expect(md).not.toContain("budgets");
  });

  it("escapes pipes in cells", () => {
    const md = renderReport({ rows: [{ metric: "a|b", value: 1 }] }, { name: "x.json" });
    expect(md).toContain("| a\\|b | 1 | — | reported |");
  });

  it("explains a missing, unreadable or empty report", () => {
    expect(renderReport(null, { name: "p.json" })).toContain("No report `p.json` written");
    expect(renderReport(null, { name: "p.json", error: "bad" })).toContain(
      "could not be read: bad"
    );
    expect(renderReport({ rows: [] }, { name: "p.json" })).toContain("has no rows");
  });
});

describe("loadReport / renderFiles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "render-report-"));
  const good = path.join(dir, "plugin-sandbox-perf.json");
  const bad = path.join(dir, "broken.json");
  writeFileSync(good, JSON.stringify(PERF));
  writeFileSync(bad, "{ not json");

  it("parses a report, reports a missing file as null and a broken one as an error", () => {
    expect(loadReport(good).report.title).toBe("Plugin sandbox perf gate");
    expect(loadReport(path.join(dir, "missing.json"))).toEqual({ report: null });
    expect(loadReport(bad).error).toBeTruthy();
  });

  it("renders every file in order", () => {
    const md = renderFiles({ files: [good, path.join(dir, "missing.json")], commit: "abc" });
    expect(md.indexOf("Plugin sandbox perf gate")).toBeLessThan(md.indexOf("missing.json"));
  });
});

describe("parseArgs", () => {
  it("reads options and files", () => {
    expect(parseArgs(["--commit", "abc", "--out", "s.md", "a.json", "b.json"])).toEqual({
      commit: "abc",
      out: "s.md",
      files: ["a.json", "b.json"],
    });
  });

  it("rejects a missing value, an unknown option and no files", () => {
    expect(() => parseArgs(["--commit"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nope", "a.json"])).toThrow(/unknown option/);
    expect(() => parseArgs([])).toThrow(/no report/);
  });
});
