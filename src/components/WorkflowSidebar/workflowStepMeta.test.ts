import { describe, it, expect } from "vitest";
import {
  EMPTY_STEP_SUMMARY,
  WORKFLOW_STEP_KINDS,
  newWorkflowStep,
  stepPolicySummary,
  stepSummary,
} from "./workflowStepMeta";

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

describe("stepSummary (#5637)", () => {
  it("summarises each step kind on one line", () => {
    const macros = [
      { id: "m1", name: "tail log", tags: [], steps: [], createdAt: "", updatedAt: "" },
    ];
    expect(stepSummary({ kind: "send-command", command: " make deploy " })).toBe("make deploy");
    expect(stepSummary({ kind: "send-command", command: "" })).toBe(EMPTY_STEP_SUMMARY);
    expect(stepSummary({ kind: "run-script", script: "a\n\nb\nc" })).toBe("a (+2 more)");
    expect(stepSummary({ kind: "run-script", script: "x", sourcePath: "/tmp/s/deploy.sh" })).toBe(
      "deploy.sh"
    );
    expect(stepSummary({ kind: "run-macro", macroId: "m1" }, macros)).toBe("tail log");
    expect(stepSummary({ kind: "run-macro", macroId: "" })).toBe(EMPTY_STEP_SUMMARY);
    expect(stepSummary({ kind: "wait", delayMs: 250 })).toBe("250 ms");
    expect(stepSummary({ kind: "run-local-process", program: "echo", args: ["a b"] })).toBe(
      "echo a b"
    );
    expect(
      stepSummary({
        kind: "conditional",
        condition: { left: "${x}", op: "eq", right: "1" },
        then: [{ kind: "wait", delayMs: 1 }],
      })
    ).toBe("If ${x} equals 1 · 1 step");
    expect(stepSummary({ kind: "loop", loop: { kind: "count", count: 3 }, body: [] })).toBe(
      "3× · 0 steps"
    );
    expect(stepSummary({ kind: "wait-for-output", pattern: "^ok$", isRegex: true })).toBe("/^ok$/");
  });

  it("lists the failure policy notes", () => {
    expect(stepPolicySummary({ kind: "wait", delayMs: 1 })).toEqual([]);
    expect(
      stepPolicySummary({ kind: "wait", delayMs: 1, continueOnError: true, retry: { count: 2 } })
    ).toEqual(["Continues on error", "Retries 2×"]);
  });
});
