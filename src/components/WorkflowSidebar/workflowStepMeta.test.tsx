import { describe, it, expect } from "vitest";
import { Terminal, FileCode, Play, Clock, Cpu, GitBranch } from "lucide-react";
import {
  WORKFLOW_STEP_KINDS,
  WORKFLOW_CONDITION_OPS,
  conditionOpLabel,
  conditionOpSymbol,
  stepKindIcon,
  stepKindLabel,
  summariseWorkflowStep,
  newWorkflowStep,
  summariseWorkflowSteps,
} from "./workflowStepMeta";
import type { WorkflowStep } from "@/types/workflow";
import type { Macro } from "@/types/macro";

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "m1",
    name: "Deploy",
    tags: [],
    steps: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("workflowStepMeta", () => {
  describe("WORKFLOW_STEP_KINDS", () => {
    it("lists the kinds in menu order (control-flow kinds last)", () => {
      expect([...WORKFLOW_STEP_KINDS]).toEqual([
        "send-command",
        "run-script",
        "run-macro",
        "wait",
        "run-local-process",
        "conditional",
        "loop",
        "wait-for-output",
      ]);
    });
  });

  describe("WORKFLOW_CONDITION_OPS", () => {
    it("lists every comparison operator in picker order", () => {
      expect([...WORKFLOW_CONDITION_OPS]).toEqual([
        "eq",
        "ne",
        "gt",
        "lt",
        "gte",
        "lte",
        "contains",
      ]);
    });

    it("gives each operator a human label and a compact symbol", () => {
      expect(conditionOpLabel("eq")).toBe("equals");
      expect(conditionOpLabel("contains")).toBe("contains");
      expect(conditionOpSymbol("eq")).toBe("==");
      expect(conditionOpSymbol("gte")).toBe(">=");
    });
  });

  describe("stepKindIcon", () => {
    it("maps each kind to its lucide icon component", () => {
      expect(stepKindIcon("send-command")).toBe(Terminal);
      expect(stepKindIcon("run-script")).toBe(FileCode);
      expect(stepKindIcon("run-macro")).toBe(Play);
      expect(stepKindIcon("wait")).toBe(Clock);
      expect(stepKindIcon("run-local-process")).toBe(Cpu);
      expect(stepKindIcon("conditional")).toBe(GitBranch);
    });
  });

  describe("stepKindLabel", () => {
    it("returns the kind verbatim", () => {
      expect(stepKindLabel("send-command")).toBe("send-command");
      expect(stepKindLabel("wait")).toBe("wait");
    });
  });

  describe("summariseWorkflowStep", () => {
    it("summarises a send-command step by its trimmed command", () => {
      expect(summariseWorkflowStep({ kind: "send-command", command: "  ls -la  " })).toBe("ls -la");
    });

    it("shows a placeholder for an empty send-command", () => {
      expect(summariseWorkflowStep({ kind: "send-command", command: "   " })).toBe("(no command)");
    });

    it("summarises a run-script step with its first non-blank line and line count", () => {
      const step: WorkflowStep = {
        kind: "run-script",
        script: "\n  \necho one\necho two\n",
      };
      expect(summariseWorkflowStep(step)).toBe("echo one (2 lines)");
    });

    it("uses the singular 'line' for a one-line script", () => {
      expect(summariseWorkflowStep({ kind: "run-script", script: "only" })).toBe("only (1 line)");
    });

    it("shows a placeholder for an empty script", () => {
      expect(summariseWorkflowStep({ kind: "run-script", script: "\n  \n" })).toBe(
        "(empty script)"
      );
    });

    it("resolves a run-macro step to the macro name when the list is provided", () => {
      const macros = [macro({ id: "m9", name: "Backup" })];
      expect(summariseWorkflowStep({ kind: "run-macro", macroId: "m9" }, macros)).toBe("Backup");
    });

    it("falls back to the macro id when the macro is not in the list", () => {
      expect(summariseWorkflowStep({ kind: "run-macro", macroId: "gone" }, [])).toBe("gone");
    });

    it("falls back to the raw id when no macro list is passed", () => {
      expect(summariseWorkflowStep({ kind: "run-macro", macroId: "m1" })).toBe("m1");
    });

    it("shows a placeholder when no macro is selected", () => {
      expect(summariseWorkflowStep({ kind: "run-macro", macroId: "" })).toBe("(no macro selected)");
    });

    it("summarises a wait step with its delay in ms", () => {
      expect(summariseWorkflowStep({ kind: "wait", delayMs: 750 })).toBe("750 ms");
    });

    it("summarises a run-local-process step by program + args", () => {
      const step: WorkflowStep = {
        kind: "run-local-process",
        program: "git",
        args: ["push", "origin"],
      };
      expect(summariseWorkflowStep(step)).toBe("git push origin");
    });

    it("shows a placeholder for a run-local-process with no program", () => {
      expect(summariseWorkflowStep({ kind: "run-local-process", program: "  ", args: [] })).toBe(
        "(no program)"
      );
    });

    it("truncates a long command to 60 chars with an ellipsis", () => {
      const long = "x".repeat(80);
      const summary = summariseWorkflowStep({ kind: "send-command", command: long });
      expect(summary).toHaveLength(60);
      expect(summary.endsWith("…")).toBe(true);
    });

    it("summarises a conditional by its condition and branch counts", () => {
      const step: WorkflowStep = {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [{ kind: "send-command", command: "a" }],
        else: [{ kind: "wait", delayMs: 1 }],
      };
      expect(summariseWorkflowStep(step)).toBe("if ${env} == prod → 1 then, 1 else");
    });

    it("omits the else count when a conditional has no else branch", () => {
      const step: WorkflowStep = {
        kind: "conditional",
        condition: { left: "x", op: "contains", right: "y" },
        then: [],
      };
      expect(summariseWorkflowStep(step)).toBe("if x contains y → 0 then");
    });

    it("summarises a count loop by its iteration count and body size", () => {
      const step: WorkflowStep = {
        kind: "loop",
        loop: { kind: "count", count: 5 },
        body: [{ kind: "send-command", command: "a" }],
      };
      expect(summariseWorkflowStep(step)).toBe("repeat 5× (1 step)");
    });

    it("summarises a while loop by its condition and body size", () => {
      const step: WorkflowStep = {
        kind: "loop",
        loop: { kind: "while", condition: { left: "${iteration}", op: "lt", right: "3" } },
        body: [
          { kind: "send-command", command: "a" },
          { kind: "wait", delayMs: 1 },
        ],
      };
      expect(summariseWorkflowStep(step)).toBe("while ${iteration} < 3 (2 steps)");
    });

    it("summarises a wait-for-output step by its pattern and match kind", () => {
      expect(summariseWorkflowStep({ kind: "wait-for-output", pattern: "login:" })).toBe(
        'wait for text "login:"'
      );
      expect(
        summariseWorkflowStep({ kind: "wait-for-output", pattern: "\\d+", isRegex: true })
      ).toBe('wait for regex "\\d+"');
      expect(summariseWorkflowStep({ kind: "wait-for-output", pattern: "  " })).toBe(
        "(no pattern)"
      );
    });
  });

  describe("newWorkflowStep", () => {
    it("builds an empty send-command step", () => {
      expect(newWorkflowStep("send-command")).toEqual({ kind: "send-command", command: "" });
    });

    it("builds an empty run-script step", () => {
      expect(newWorkflowStep("run-script")).toEqual({ kind: "run-script", script: "" });
    });

    it("builds an empty run-macro step", () => {
      expect(newWorkflowStep("run-macro")).toEqual({ kind: "run-macro", macroId: "" });
    });

    it("builds a wait step with a 500ms default", () => {
      expect(newWorkflowStep("wait")).toEqual({ kind: "wait", delayMs: 500 });
    });

    it("builds an empty run-local-process step", () => {
      expect(newWorkflowStep("run-local-process")).toEqual({
        kind: "run-local-process",
        program: "",
        args: [],
      });
    });

    it("builds a conditional step with an empty eq condition, empty then, and no else", () => {
      const step = newWorkflowStep("conditional");
      expect(step).toEqual({
        kind: "conditional",
        condition: { left: "", op: "eq", right: "" },
        then: [],
      });
      // `else` is undefined (not `[]`) so it serialises byte-identically.
      expect(step).not.toHaveProperty("else");
    });

    it("builds a loop step defaulting to a bounded fixed count with an empty body", () => {
      expect(newWorkflowStep("loop")).toEqual({
        kind: "loop",
        loop: { kind: "count", count: 3 },
        body: [],
      });
    });

    it("builds a wait-for-output step with an empty pattern and no optional fields", () => {
      const step = newWorkflowStep("wait-for-output");
      expect(step).toEqual({ kind: "wait-for-output", pattern: "" });
      // Substring is the default; isRegex/timeoutMs stay absent to round-trip.
      expect(step).not.toHaveProperty("isRegex");
      expect(step).not.toHaveProperty("timeoutMs");
    });
  });

  describe("summariseWorkflowSteps", () => {
    it("joins step kind labels with arrows", () => {
      const steps: WorkflowStep[] = [
        { kind: "send-command", command: "a" },
        { kind: "wait", delayMs: 100 },
        { kind: "run-script", script: "b" },
      ];
      expect(summariseWorkflowSteps(steps)).toBe("send-command → wait → run-script");
    });

    it("returns an empty string for no steps", () => {
      expect(summariseWorkflowSteps([])).toBe("");
    });

    it("truncates a long chain to the given max length", () => {
      const steps: WorkflowStep[] = Array.from({ length: 20 }, () => ({
        kind: "wait" as const,
        delayMs: 1,
      }));
      const summary = summariseWorkflowSteps(steps, 30);
      expect(summary).toHaveLength(30);
      expect(summary.endsWith("…")).toBe(true);
    });
  });
});
