import { describe, it, expect } from "vitest";
import type { Macro } from "@/types/macro";
import {
  WORKFLOW_STEP_KINDS,
  summariseWorkflowStep,
  summariseWorkflowSteps,
  newWorkflowStep,
} from "./workflowStepMeta";

const macros: Macro[] = [
  {
    id: "macro-1",
    name: "tail app log",
    tags: [],
    steps: [],
    createdAt: "",
    updatedAt: "",
  },
];

describe("workflowStepMeta", () => {
  it("summarises each step kind", () => {
    expect(summariseWorkflowStep({ kind: "send-command", command: "sudo -v" })).toBe("sudo -v");
    expect(summariseWorkflowStep({ kind: "send-command", command: "  " })).toBe("(no command)");
    expect(summariseWorkflowStep({ kind: "wait", delayMs: 500 })).toBe("500 ms");
    expect(
      summariseWorkflowStep({ kind: "run-script", script: "echo hi\necho bye\n\n" })
    ).toContain("(2 lines)");
    expect(summariseWorkflowStep({ kind: "run-script", script: "" })).toBe("(empty script)");
    expect(
      summariseWorkflowStep({ kind: "run-local-process", program: "notify", args: ["a", "b"] })
    ).toBe("notify a b");
    expect(summariseWorkflowStep({ kind: "run-local-process", program: "", args: [] })).toBe(
      "(no program)"
    );
  });

  it("resolves a run-macro step to the macro name when available", () => {
    expect(summariseWorkflowStep({ kind: "run-macro", macroId: "macro-1" }, macros)).toBe(
      "tail app log"
    );
    // Falls back to the id when the macro is not in the provided list.
    expect(summariseWorkflowStep({ kind: "run-macro", macroId: "macro-x" }, macros)).toBe(
      "macro-x"
    );
    expect(summariseWorkflowStep({ kind: "run-macro", macroId: "" })).toBe("(no macro selected)");
  });

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
