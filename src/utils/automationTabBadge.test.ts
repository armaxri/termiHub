import { describe, it, expect } from "vitest";
import { runningAutomationLabel, runningAutomationOnTab } from "./automationTabBadge";
import type { MacroPlaybackState, WorkflowRunState } from "@/store/appStore";

const playback = (over: Partial<MacroPlaybackState> = {}): MacroPlaybackState => ({
  macroId: "m1",
  macroName: "Deploy",
  tabId: "a",
  total: 4,
  played: 3,
  ...over,
});

const run: WorkflowRunState = {
  runId: "r1",
  workflowId: "w1",
  workflowName: "Health",
  tabId: "b",
  total: 2,
  completed: 1,
};

describe("runningAutomationOnTab (#5818 slice 5)", () => {
  it("marks a single-terminal macro on its tab", () => {
    expect(runningAutomationOnTab(playback(), [], "a")).toEqual({
      name: "Deploy",
      completed: 3,
      total: 4,
      waiting: false,
      stop: { kind: "macro" },
    });
    expect(runningAutomationOnTab(playback(), [], "b")).toBeNull();
  });

  it("uses each target's own progress on a multi-terminal macro", () => {
    const p = playback({ targetTabIds: ["a", "c"], targetProgress: { a: 1, c: 4 } });
    expect(runningAutomationOnTab(p, [], "c")?.completed).toBe(4);
    expect(runningAutomationOnTab(p, [], "a")?.completed).toBe(1);
    // A target whose run ended is no longer in targetTabIds.
    expect(runningAutomationOnTab(playback({ targetTabIds: ["c"] }), [], "a")).toBeNull();
  });

  it("marks a running workflow with a stop for that run", () => {
    expect(runningAutomationOnTab(null, [run], "b")).toEqual({
      name: "Health",
      completed: 1,
      total: 2,
      waiting: false,
      stop: { kind: "workflow", runId: "r1" },
    });
  });

  it("says that it waits for the user there (#6025)", () => {
    const info = runningAutomationOnTab(null, [run], "b", [{ runId: "r1" }])!;
    expect(info.waiting).toBe(true);
    expect(runningAutomationLabel(info)).toBe("Automation “Health” waits for you");
    expect(runningAutomationOnTab(null, [run], "b", [{ runId: "other" }])!.waiting).toBe(false);
  });

  it("labels the badge with the name and progress", () => {
    expect(
      runningAutomationLabel({
        name: "Deploy",
        completed: 2,
        total: 5,
        waiting: false,
        stop: { kind: "macro" },
      })
    ).toBe("Running automation “Deploy” (2/5)");
  });
});
