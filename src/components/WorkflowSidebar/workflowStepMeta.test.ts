import { describe, it, expect } from "vitest";
import { WORKFLOW_STEP_KINDS, newWorkflowStep } from "./workflowStepMeta";

describe("workflowStepMeta", () => {
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
