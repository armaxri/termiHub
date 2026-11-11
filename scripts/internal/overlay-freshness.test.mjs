import { describe, it, expect } from "vitest";
import {
  ageDays,
  lcovFiles,
  staleShare,
  evaluateOverlay,
  evaluateStatus,
  formatSummary,
  darkMessage,
  latestRunLink,
  parseArgs,
  MAX_OVERLAY_AGE_DAYS,
  MAX_STALE_SHARE,
} from "./overlay-freshness.mjs";

const NOW = Date.parse("2026-11-09T07:30:00Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000).toISOString();

const lane = (over = {}) => ({
  lane: "integration fixtures",
  workflow: "integration-fixtures.yml",
  workflowUrl: "https://github.com/o/r/actions/workflows/integration-fixtures.yml",
  latestRun: { id: 42, url: "https://github.com/o/r/actions/runs/42", conclusion: "failure" },
  present: true,
  sha: "9030c5f".padEnd(40, "0"),
  measuredAt: daysAgo(1),
  behindBy: 12,
  changedFiles: 30,
  overlayFiles: 200,
  staleOverlayFiles: 10,
  ...over,
});

describe("thresholds", () => {
  it("are the issue's limits: 3 days and 10 %", () => {
    expect(MAX_OVERLAY_AGE_DAYS).toBe(3);
    expect(MAX_STALE_SHARE).toBe(0.1);
  });
});

describe("ageDays", () => {
  it("measures fractional days and rejects an unknown time", () => {
    expect(ageDays(daysAgo(2.5), NOW)).toBeCloseTo(2.5);
    expect(ageDays("2026-11-09T07:30:00Z", NOW)).toBe(0);
    expect(ageDays(new Date(NOW + 1000).toISOString(), NOW)).toBe(0);
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays("not a date", NOW)).toBeNull();
  });
});

describe("lcovFiles / staleShare", () => {
  it("counts the overlay's files that changed since, root-relative", () => {
    const text = [
      "SF:/w/repo/core/src/a.rs",
      "DA:1,1",
      "end_of_record",
      "SF:/w/repo/core/src/b.rs",
      "end_of_record",
      "SF:/w/repo/core/src/a.rs",
      "end_of_record",
      "SF:src/c.ts",
      "end_of_record",
    ].join("\n");
    const files = lcovFiles(text, "/w/repo");
    expect([...files].sort()).toEqual(["core/src/a.rs", "core/src/b.rs", "src/c.ts"]);
    // A changed file the overlay never covered does not count.
    const stale = new Set(["core/src/a.rs", "docs/x.md"]);
    expect(staleShare(files, stale)).toEqual({ stale: 1, total: 3, share: 1 / 3 });
  });

  it("is 0 for an empty overlay", () => {
    expect(staleShare(new Set(), new Set(["a"]))).toEqual({ stale: 0, total: 0, share: 0 });
  });
});

describe("evaluateOverlay", () => {
  it("passes a fresh overlay", () => {
    expect(evaluateOverlay(lane(), NOW)).toEqual([]);
  });

  it("passes exactly at the limits and fails just past them", () => {
    expect(evaluateOverlay(lane({ measuredAt: daysAgo(3) }), NOW)).toEqual([]);
    expect(evaluateOverlay(lane({ staleOverlayFiles: 20 }), NOW)).toEqual([]);
    expect(evaluateOverlay(lane({ measuredAt: daysAgo(3.1) }), NOW)).toEqual([
      "it is 3.1 days old (limit 3)",
    ]);
    expect(evaluateOverlay(lane({ staleOverlayFiles: 21 }), NOW)).toEqual([
      "21 of its 200 files (10.5 %) changed since (limit 10.0 %)",
    ]);
  });

  it("reports both problems of the 2026-11-09 overlay", () => {
    const problems = evaluateOverlay(
      lane({ measuredAt: daysAgo(11), overlayFiles: 300, staleOverlayFiles: 153 }),
      NOW
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/11\.0 days old/);
    expect(problems[1]).toMatch(/153 of its 300 files \(51\.0 %\)/);
  });

  it("flags a missing overlay with the fetch note, and an unknown measurement time", () => {
    expect(evaluateOverlay({ present: false, note: "artifact expired" }, NOW)).toEqual([
      "no usable overlay (artifact expired)",
    ]);
    expect(evaluateOverlay({ present: false }, NOW)).toEqual([
      "no usable overlay (nothing fetched)",
    ]);
    expect(evaluateOverlay(lane({ measuredAt: null }), NOW)).toEqual([
      "its measurement time is unknown",
    ]);
  });
});

describe("evaluateStatus", () => {
  const stale = lane({ lane: "bridge harness", measuredAt: daysAgo(15) });

  it("fails only on a gated branch", () => {
    const develop = evaluateStatus({ branch: "develop", lanes: [lane(), stale] }, NOW);
    expect(develop.gated).toBe(true);
    expect(develop.failed).toBe(true);
    expect(develop.lanes.map((l) => l.problems.length)).toEqual([0, 1]);

    const feature = evaluateStatus({ branch: "dev9/ci/x", lanes: [lane(), stale] }, NOW);
    expect(feature.gated).toBe(false);
    expect(feature.failed).toBe(false);
  });

  it("passes on develop when every overlay is fresh", () => {
    expect(evaluateStatus({ branch: "develop", lanes: [lane()] }, NOW).failed).toBe(false);
  });
});

describe("messages and summary", () => {
  it("names the dark lane and links its latest run", () => {
    expect(darkMessage(lane(), ["it is 9.0 days old (limit 3)"])).toBe(
      "integration fixtures overlay (integration-fixtures.yml) went dark: " +
        "it is 9.0 days old (limit 3). Latest run: https://github.com/o/r/actions/runs/42"
    );
    expect(latestRunLink(lane())).toBe(
      "[run 42](https://github.com/o/r/actions/runs/42) (failure)"
    );
    expect(latestRunLink(lane({ latestRun: null }))).toBe(
      "[integration-fixtures.yml](https://github.com/o/r/actions/workflows/integration-fixtures.yml)"
    );
  });

  it("tabulates sha, age, commits behind and stale share per lane", () => {
    const status = {
      branch: "develop",
      head: "f".repeat(40),
      lanes: [lane(), { ...lane({ lane: "bridge harness" }), present: false, note: "none yet" }],
    };
    const md = formatSummary(status, evaluateStatus(status, NOW), NOW);
    expect(md).toContain("### Integration overlay freshness");
    expect(md).toContain("HEAD `ffffffffffff`");
    expect(md).toContain(
      "| integration fixtures | `9030c5f00000` | 1.0 | 12 | 30 | 10 / 200 (5.0 %) | ok |"
    );
    expect(md).toMatch(/\| bridge harness \| - \| - \| - \| - \| - \| \*\*dark\*\*: no usable/);
    expect(md).toContain("Gated.");
  });
});

describe("parseArgs", () => {
  it("requires --status", () => {
    expect(() => parseArgs([])).toThrow(/--status/);
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/bad argument/);
    expect(parseArgs(["--status", "s.json", "--summary", "m.md"])).toEqual({
      status: "s.json",
      summary: "m.md",
    });
  });
});
