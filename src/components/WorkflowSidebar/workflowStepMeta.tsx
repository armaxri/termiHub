/**
 * Presentation helpers for workflow steps in the sidebar and editor UI.
 *
 * A {@link WorkflowStep} is a discriminated union (`kind`), so both the list row
 * and the editor need a per-kind icon, a human label, and a compact preview of
 * the step list. These helpers centralise that mapping
 * so the sidebar and editor stay in sync, mirroring `macroStepFormat` from the
 * shipped macro UI.
 */
import type { ComponentType } from "react";
import { Terminal, FileCode, Play, Clock, Cpu, GitBranch, Repeat, Eye } from "lucide-react";
import type { WorkflowComparisonOp, WorkflowStep, WorkflowStepKind } from "@/types/workflow";
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
