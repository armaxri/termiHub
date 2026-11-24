import { describe, it, expect } from "vitest";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import {
  automationFilterOptions,
  automationRunDuration,
  automationRunOriginDetail,
  automationRunOriginLabel,
  automationRunProgress,
  automationRunStatusLabel,
  automationRunTargets,
  automationRunTone,
  runsOfAutomation,
} from "./historyFormat";

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "r1",
    automationId: "a1",
    automationName: "Deploy",
    startedAt: "2026-09-20T00:00:00Z",
    endedAt: "2026-09-20T00:01:05Z",
    status: "completed",
    stepsCompleted: 1,
    total: 1,
    origin: "manual",
    ...overrides,
  };
}

describe("automation history format (#5818, slice 9)", () => {
  it("maps every origin to one of the five unified labels", () => {
    const labels: Record<AutomationRunOrigin, string> = {
      manual: "Run by you",
      palette: "Run by you",
      hotkey: "Run by hotkey",
      "on-connect": "Run by trigger",
      "on-disconnect": "Run by trigger",
      "on-output-match": "Run by trigger",
      scheduled: "Run by schedule",
      "run-by-automation": "Run by another automation",
    };
    for (const [origin, label] of Object.entries(labels)) {
      expect(automationRunOriginLabel(origin as AutomationRunOrigin)).toBe(label);
    }
  });

  it("adds a detail only where two runs share a label", () => {
    expect(automationRunOriginDetail("manual")).toBeNull();
    expect(automationRunOriginDetail("palette")).toBe("From the command palette");
    expect(automationRunOriginDetail("on-connect")).toBe("When the connection opened");
    expect(automationRunOriginDetail("on-disconnect")).toBe("When the connection closed");
    expect(automationRunOriginDetail("on-output-match")).toBe("When the terminal output matched");
    expect(automationRunOriginDetail("scheduled")).toBeNull();
  });

  it("words and tones the outcome in US spelling", () => {
    expect(automationRunStatusLabel("cancelled")).toBe("Canceled");
    expect(automationRunStatusLabel("failed")).toBe("Failed");
    expect(automationRunTone("completed")).toBe("success");
    expect(automationRunTone("failed")).toBe("error");
    expect(automationRunTone("cancelled")).toBe("warning");
  });

  it("formats duration and progress", () => {
    expect(automationRunDuration(run())).toBe("1m 05s");
    expect(automationRunDuration(run({ endedAt: "bogus" }))).toBe("");
    expect(automationRunProgress(run({ stepsCompleted: 0, total: 1 }))).toBe("0 of 1 step");
    expect(automationRunProgress(run({ stepsCompleted: 2, total: 4 }))).toBe("2 of 4 steps");
  });

  it("names a macro fan-out's terminals, else the one terminal, else none", () => {
    expect(automationRunTargets(run({ targetLabels: ["a", "b"], targetLabel: "a" }))).toEqual([
      "a",
      "b",
    ]);
    expect(automationRunTargets(run({ targetLabel: "prod" }))).toEqual(["prod"]);
    expect(automationRunTargets(run())).toEqual([]);
  });

  it("filters runs by automation", () => {
    const runs = [run(), run({ id: "r2", automationId: "a2" })];
    expect(runsOfAutomation(runs, "a2").map((r) => r.id)).toEqual(["r2"]);
    expect(runsOfAutomation(runs, null)).toHaveLength(2);
  });

  it("offers each automation once, by its current name, sorted", () => {
    const runs = [
      run({ automationId: "a2", automationName: "Zeta" }),
      run({ automationId: "a1", automationName: "Old name" }),
      run({ automationId: "a2", automationName: "Zeta" }),
      run({ automationId: "gone", automationName: "Deleted one" }),
    ];
    const names = new Map([
      ["a1", "Alpha"],
      ["a2", "Zeta"],
    ]);
    expect(automationFilterOptions(runs, names)).toEqual([
      { value: "a1", label: "Alpha" },
      { value: "gone", label: "Deleted one" },
      { value: "a2", label: "Zeta" },
    ]);
  });
});
