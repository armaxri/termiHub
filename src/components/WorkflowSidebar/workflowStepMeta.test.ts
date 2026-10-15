import { describe, it, expect } from "vitest";
import { WORKFLOW_STEP_KINDS, summariseWorkflowSteps, newWorkflowStep } from "./workflowStepMeta";

describe("workflowStepMeta", () => {
  it("summarises a whole step list as arrow-joined kinds", () => {
    expect(
      summariseWorkflowSteps([
        { kind: "send-command", command: "x" },
        { kind: "wait", delayMs: 1 },
      ])
    ).toBe("send-command → wait");
  });

  it("builds a default step for every kind", () => {
    for (const kind of WORKFLOW_STEP_KINDS) {
      expect(newWorkflowStep(kind).kind).toBe(kind);
    }
    expect(newWorkflowStep("wait")).toEqual({ kind: "wait", delayMs: 500 });
    expect(newWorkflowStep("run-local-process")).toEqual({
      kind: "run-local-process",
      program: "",
      args: [],
    });
  });
});
