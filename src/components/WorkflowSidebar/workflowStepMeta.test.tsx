import { describe, it, expect } from "vitest";
import { Terminal, FileCode, Play, Clock, Cpu, GitBranch } from "lucide-react";
import {
  WORKFLOW_STEP_KINDS,
  WORKFLOW_CONDITION_OPS,
  conditionOpLabel,
  stepKindIcon,
  stepKindLabel,
  newWorkflowStep,
  summariseWorkflowSteps,
} from "./workflowStepMeta";
import type { WorkflowStep } from "@/types/workflow";

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

    it("gives each operator a human label", () => {
      expect(conditionOpLabel("eq")).toBe("equals");
      expect(conditionOpLabel("contains")).toBe("contains");
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
