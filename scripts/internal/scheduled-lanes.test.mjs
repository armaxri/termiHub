import { describe, it, expect } from "vitest";
import {
  CATCH_UP_HOURS,
  HEARTBEAT_HOURS,
  LANES,
  cronsOf,
  extractOnBlock,
  hasDefaultBranchOnlyTrigger,
  normalizedOnBlock,
  triggersOf,
} from "./scheduled-lanes.mjs";

const WORKFLOW = [
  "name: Example",
  "",
  "# a top-level comment does not end the block",
  "on:",
  "  schedule:",
  "    # nightly",
  "    - cron: '17 3 * * *' # off the hour",
  '    - cron: "5 5 * * 3"',
  "  workflow_dispatch:",
  "    inputs:",
  "      branch:",
  "        type: choice",
  "  push:",
  "    branches: [develop]",
  "",
  "concurrency:",
  "  group: x",
  "",
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
].join("\n");

describe("extractOnBlock", () => {
  it("returns the on: block up to the next top-level key", () => {
    const block = extractOnBlock(WORKFLOW);
    expect(block[0]).toBe("on:");
    expect(block.at(-2)).toBe("    branches: [develop]");
    expect(block.join("\n")).not.toContain("concurrency");
  });

  it("accepts a quoted on key", () => {
    expect(extractOnBlock('"on":\n  push:\njobs:\n')).toEqual(['"on":', "  push:"]);
  });

  it("returns null without an on: block", () => {
    expect(extractOnBlock("name: x\njobs:\n  a: {}\n")).toBeNull();
  });
});

describe("triggersOf", () => {
  it("lists the first-level trigger keys", () => {
    expect(triggersOf(WORKFLOW)).toEqual(["schedule", "workflow_dispatch", "push"]);
  });

  it("handles the inline list and scalar forms", () => {
    expect(triggersOf("on: [push, workflow_run]\njobs: {}\n")).toEqual(["push", "workflow_run"]);
    expect(triggersOf("on: push\njobs: {}\n")).toEqual(["push"]);
  });

  it("is empty without an on: block", () => {
    expect(triggersOf("name: x\n")).toEqual([]);
  });
});

describe("cronsOf", () => {
  it("reads single- and double-quoted crons, ignoring trailing comments", () => {
    expect(cronsOf(WORKFLOW)).toEqual(["17 3 * * *", "5 5 * * 3"]);
  });
});

describe("normalizedOnBlock", () => {
  it("ignores comments, blank lines and trailing whitespace", () => {
    const commented = WORKFLOW.replace("  push:", "  # why we push\n\n  push:   ").replace(
      "# off the hour",
      "# a different comment"
    );
    expect(normalizedOnBlock(commented)).toBe(normalizedOnBlock(WORKFLOW));
  });

  it("detects a changed trigger", () => {
    const changed = WORKFLOW.replace("'17 3 * * *'", "'17 4 * * *'");
    expect(normalizedOnBlock(changed)).not.toBe(normalizedOnBlock(WORKFLOW));
  });

  it("keeps a # inside quotes", () => {
    expect(normalizedOnBlock('on:\n  push:\n    paths: ["a#b"]\n')).toContain('"a#b"');
  });
});

describe("hasDefaultBranchOnlyTrigger", () => {
  it("is true for schedule and workflow_run", () => {
    expect(hasDefaultBranchOnlyTrigger(WORKFLOW)).toBe(true);
    expect(
      hasDefaultBranchOnlyTrigger("on:\n  workflow_run:\n    workflows: [CI]\njobs: {}\n")
    ).toBe(true);
  });

  it("is false for push/PR/dispatch only", () => {
    expect(hasDefaultBranchOnlyTrigger("on:\n  push:\n  workflow_dispatch:\njobs: {}\n")).toBe(
      false
    );
  });
});

describe("LANES", () => {
  it("has unique files and known cadences", () => {
    const files = LANES.map((l) => l.file);
    expect(new Set(files).size).toBe(files.length);
    for (const lane of LANES) {
      expect(HEARTBEAT_HOURS[lane.cadence]).toBeGreaterThan(0);
      expect(lane.sources.length).toBeGreaterThan(0);
    }
  });

  it("keeps the catch-up window inside the heartbeat window", () => {
    for (const cadence of Object.keys(HEARTBEAT_HOURS)) {
      expect(CATCH_UP_HOURS[cadence]).toBeLessThan(HEARTBEAT_HOURS[cadence]);
    }
  });
});
