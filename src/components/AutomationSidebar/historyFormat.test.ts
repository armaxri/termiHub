import { describe, it, expect } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import {
  automationFilterOptions,
  automationRunDuration,
  automationRunOriginDetail,
  automationRunOutcome,
  automationRunStarter,
  automationRunProgress,
  automationRunStatusLabel,
  automationRunTargets,
  automationRunTone,
  nextStepAfter,
  nextStepAfterGap,
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
      manual: "You",
      palette: "You",
      hotkey: "Hotkey",
      "on-connect": "Trigger",
      "on-disconnect": "Trigger",
      "on-output-match": "Trigger",
      scheduled: "Schedule",
      "run-by-automation": "Another automation",
    };
    for (const [origin, label] of Object.entries(labels)) {
      expect(automationRunStarter(origin as AutomationRunOrigin)).toBe(label);
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
    expect(automationRunStatusLabel("cancelled")).toBe("Stopped");
    expect(automationRunStatusLabel("failed")).toBe("Failed");
    expect(automationRunTone("completed")).toBe("success");
    expect(automationRunTone("failed")).toBe("error");
    expect(automationRunTone("cancelled")).toBe("warning");
  });

  it("names the schedule that started it", () => {
    expect(automationRunStarter("scheduled", "Every night")).toBe("Schedule “Every night”");
    expect(automationRunStarter("hotkey", "Every night")).toBe("Hotkey");
  });

  describe("how it ended (A-039)", () => {
    const steps: Automation = {
      id: "a1",
      name: "Deploy",
      tags: [],
      steps: [
        { kind: "wait", delayMs: 1 },
        { kind: "send-command", command: "make" },
      ],
      triggers: [],
      createdAt: "",
      updatedAt: "2026-09-19T00:00:00Z",
    };
    const failed = run({ status: "failed", failedStepIndex: 1, total: 2, stepsCompleted: 1 });

    it("names the step that failed and what it does", () => {
      expect(automationRunOutcome(failed, steps)).toBe("Failed at step 2 of 2 (Run command: make)");
      expect(automationRunOutcome({ ...failed, continuedFailures: 2 }, steps)).toMatch(
        / · 2 tolerated failures$/
      );
    });

    it("does not name a step of an automation that changed since, or is gone", () => {
      const edited = { ...steps, updatedAt: "2026-09-21T00:00:00Z" };
      expect(automationRunOutcome(failed, edited)).toBe("Failed at step 2 of 2");
      expect(automationRunOutcome(failed)).toBe("Failed at step 2 of 2");
    });

    it("tells a share of what is typed, which has no steps", () => {
      const typed: Automation = {
        ...steps,
        steps: [{ kind: "type-keys", chunks: [], timing: "recorded" }],
      };
      const half = run({ status: "failed", total: 12, stepsCompleted: 6 });
      expect(automationRunOutcome(half, typed)).toBe("Failed, 50 % typed");
      expect(automationRunProgress({ total: 12, stepsCompleted: 12 }, typed)).toBe("100 % typed");
    });
  });

  it.each([
    ["nobody pressed Continue within 5 minutes; nothing more was typed", /press Continue/],
    ["it waits for somebody to type, and nobody was there", /Run it yourself/],
    ["The terminal stopped accepting input", /Connect the terminal/],
    ["wait-for-output timed out after 30000 ms", /pattern/],
    ["local process “x” exited with code 2", /by hand/],
    ["something else", null],
  ])("says what to do after: %s", (error, next) => {
    const text = nextStepAfter({ status: "failed", error });
    if (next === null) expect(text).toBeNull();
    else expect(text).toMatch(next);
    expect(nextStepAfter({ status: "completed", error })).toBeNull();
  });

  it("says what to do about a time at which nothing ran (B-033)", () => {
    expect(nextStepAfterGap({ kind: "missed", reason: null })).toContain("If a run is missed");
    expect(
      nextStepAfterGap({
        kind: "skipped",
        reason: "None of its connections was open, and the schedule is set to skip closed ones",
      })
    ).toContain("If a connection is closed");
    expect(nextStepAfterGap({ kind: "skipped", reason: "something else" })).toBeNull();
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
