/**
 * Presentation helpers for workflow steps in the sidebar and editor UI.
 *
 * A {@link WorkflowStep} is a discriminated union (`kind`), so both the list row
 * and the editor need a per-kind icon, a human label, and a compact one-line
 * summary of the step's configured data. These helpers centralise that mapping
 * so the sidebar and editor stay in sync, mirroring `macroStepFormat` from the
 * shipped macro UI.
 */
import type { ComponentType } from "react";
import { Terminal, FileCode, Play, Clock, Cpu, GitBranch, Repeat, Eye } from "lucide-react";
import type { WorkflowComparisonOp, WorkflowStep, WorkflowStepKind } from "@/types/workflow";
import type { Macro } from "@/types/macro";
import { truncate } from "@/utils/formatters";

/** The step kinds, in the order they appear in the "Add step…" menu. */
export const WORKFLOW_STEP_KINDS: readonly WorkflowStepKind[] = [
  "send-command",
  "run-script",
  "run-macro",
  "wait",
  "run-local-process",
  "conditional",
  "loop",
  "wait-for-output",
] as const;

/**
 * The comparison operators of a workflow condition (PROD-0044), in the order
 * they appear in the operator picker.
 */
export const WORKFLOW_CONDITION_OPS: readonly WorkflowComparisonOp[] = [
  "eq",
  "ne",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
] as const;

/** Human-readable label for a condition operator, shown in the picker. */
export function conditionOpLabel(op: WorkflowComparisonOp): string {
  switch (op) {
    case "eq":
      return "equals";
    case "ne":
      return "not equals";
    case "gt":
      return "greater than";
    case "lt":
      return "less than";
    case "gte":
      return "greater or equal";
    case "lte":
      return "less or equal";
    case "contains":
      return "contains";
  }
}

/** Compact symbol for a condition operator, shown in one-line step summaries. */
export function conditionOpSymbol(op: WorkflowComparisonOp): string {
  switch (op) {
    case "eq":
      return "==";
    case "ne":
      return "!=";
    case "gt":
      return ">";
    case "lt":
      return "<";
    case "gte":
      return ">=";
    case "lte":
      return "<=";
    case "contains":
      return "contains";
  }
}

/** Lucide icon component for each step kind (matches the concept mockup). */
const STEP_ICONS: Record<WorkflowStepKind, ComponentType<{ size?: number | string }>> = {
  "send-command": Terminal,
  "run-script": FileCode,
  "run-macro": Play,
  wait: Clock,
  "run-local-process": Cpu,
  conditional: GitBranch,
  loop: Repeat,
  "wait-for-output": Eye,
};

/** The icon component for a step kind. */
export function stepKindIcon(kind: WorkflowStepKind): ComponentType<{ size?: number | string }> {
  return STEP_ICONS[kind];
}

/** Human-readable label shown in the "Add step…" menu and each step row. */
export function stepKindLabel(kind: WorkflowStepKind): string {
  return kind;
}

/**
 * Produce a compact, single-line summary of a step's configured data — the
 * `<code>` detail shown to the right of the kind label in the editor and the
 * sidebar preview. `macros` (optional) resolves a `run-macro` step's target to
 * its name; without it the id is shown.
 */
export function summariseWorkflowStep(step: WorkflowStep, macros?: Macro[]): string {
  switch (step.kind) {
    case "send-command":
      return step.command.trim() ? truncate(step.command.trim()) : "(no command)";
    case "run-script": {
      const lines = step.script.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return "(empty script)";
      const suffix = `(${lines.length} line${lines.length === 1 ? "" : "s"})`;
      return truncate(`${lines[0]} ${suffix}`);
    }
    case "run-macro": {
      if (!step.macroId) return "(no macro selected)";
      const macro = macros?.find((m) => m.id === step.macroId);
      return macro ? macro.name : step.macroId;
    }
    case "wait":
      return `${step.delayMs} ms`;
    case "run-local-process": {
      if (!step.program.trim()) return "(no program)";
      return truncate([step.program, ...step.args].join(" "));
    }
    case "conditional": {
      const { left, op, right } = step.condition;
      const thenCount = step.then.length;
      const elseCount = step.else?.length ?? 0;
      const lhs = left.trim() || "?";
      const rhs = right.trim() || "?";
      const branches = `${thenCount} then${elseCount ? `, ${elseCount} else` : ""}`;
      return truncate(`if ${lhs} ${conditionOpSymbol(op)} ${rhs} → ${branches}`);
    }
    case "loop": {
      const bodyCount = step.body.length;
      const suffix = `(${bodyCount} step${bodyCount === 1 ? "" : "s"})`;
      if (step.loop.kind === "count") {
        return truncate(`repeat ${step.loop.count}× ${suffix}`);
      }
      const { left, op, right } = step.loop.condition;
      const lhs = left.trim() || "?";
      const rhs = right.trim() || "?";
      return truncate(`while ${lhs} ${conditionOpSymbol(op)} ${rhs} ${suffix}`);
    }
    case "wait-for-output": {
      if (!step.pattern.trim()) return "(no pattern)";
      const kind = step.isRegex ? "regex" : "text";
      return truncate(`wait for ${kind} "${step.pattern}"`);
    }
  }
}

/**
 * Build a default step of the given kind, used when the user adds a new step
 * from the "Add step…" menu. Fields start empty (or at a sensible default) and
 * are then edited in the step row.
 */
export function newWorkflowStep(kind: WorkflowStepKind): WorkflowStep {
  switch (kind) {
    case "send-command":
      return { kind, command: "" };
    case "run-script":
      return { kind, script: "" };
    case "run-macro":
      return { kind, macroId: "" };
    case "wait":
      return { kind, delayMs: 500 };
    case "run-local-process":
      return { kind, program: "", args: [] };
    case "conditional":
      // `else` is left undefined (not `[]`) so a conditional authored without an
      // else branch serialises byte-identically — a false condition is a no-op.
      return { kind, condition: { left: "", op: "eq", right: "" }, then: [] };
    case "loop":
      // Default to a small fixed count so a freshly-added loop is bounded and
      // safe out of the box; the author can switch to a while-condition.
      return { kind, loop: { kind: "count", count: 3 }, body: [] };
    case "wait-for-output":
      // Literal substring is the safer default; `isRegex`/`timeoutMs` are left
      // absent so the step round-trips byte-identically and uses the default
      // timeout until the author sets them.
      return { kind, pattern: "" };
  }
}

/**
 * One-line preview of a whole step list for the collapsed sidebar row — the kind
 * labels joined by arrows, truncated. Gives a hint of the workflow's shape
 * without opening the editor.
 */
export function summariseWorkflowSteps(steps: WorkflowStep[], maxLength = 80): string {
  return truncate(steps.map((s) => stepKindLabel(s.kind)).join(" → "), maxLength);
}
