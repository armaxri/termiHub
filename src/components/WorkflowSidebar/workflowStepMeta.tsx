/**
 * Presentation helpers for workflow steps in the sidebar and editor UI.
 *
 * A {@link WorkflowStep} is a discriminated union (`kind`), so both the list row
 * and the editor need a per-kind icon and a human label; triggers likewise need
 * a human label wherever their kind is shown. These helpers centralise that
 * mapping so the sidebar, history and editor use the same wording (#5529),
 * mirroring `macroStepFormat` from the shipped macro UI.
 */
import type { ComponentType } from "react";
import { Terminal, FileCode, Play, Clock, Cpu, GitBranch, Repeat, Eye } from "lucide-react";
import type {
  WorkflowComparisonOp,
  WorkflowCondition,
  WorkflowRunTrigger,
  WorkflowStep,
  WorkflowStepKind,
} from "@/types/workflow";
import type { Macro } from "@/types/macro";
import { t } from "@/i18n/catalog";

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

/**
 * Sentence-case label of each step kind. The kind ids are internal
 * identifiers (`send-command`); users see these labels instead (#5529).
 */
const STEP_LABELS: Record<WorkflowStepKind, string> = {
  "send-command": "Send command",
  "run-script": "Run script",
  "run-macro": "Run macro",
  wait: "Wait",
  "run-local-process": "Run local process",
  conditional: "Condition",
  loop: "Loop",
  "wait-for-output": "Wait for output",
};

/** Human-readable label shown in the "Add step…" menu and each step row. */
export function stepKindLabel(kind: WorkflowStepKind): string {
  return STEP_LABELS[kind];
}

/**
 * Human-readable label of a trigger kind, or of what launched a recorded run
 * (`WorkflowRunTrigger` is the trigger kinds plus `scheduled`). One map so the
 * trigger chips in the editor, the row's trigger marker and the run history use
 * the same wording (#5529).
 */
export function triggerKindLabel(kind: WorkflowRunTrigger): string {
  switch (kind) {
    case "manual":
      return "Manual";
    case "on-connect":
      return "On connect";
    case "hotkey":
      return "Hotkey";
    case "scheduled":
      return "Scheduled";
    case "on-disconnect":
      return t("workflow.trigger.onDisconnect.label");
    case "on-output-match":
      return t("workflow.trigger.onOutputMatch.label");
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

/** Shown in a collapsed step's summary when its main field is still empty. */
export const EMPTY_STEP_SUMMARY = "Not set yet";

/** `left op right` of a condition, for a one-line summary. */
function conditionSummary(condition: WorkflowCondition): string {
  return `${condition.left || "…"} ${conditionOpLabel(condition.op)} ${condition.right || "…"}`;
}

/** "1 step" / "3 steps". */
function stepCount(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

/**
 * One-line summary of a step's main value, shown on a collapsed step row in the
 * workflow editor (#5637) so a long sequence reads at a glance: the command, the
 * script's first line, the macro's name, the delay, and so on. `macros` resolves
 * a run-macro step's id to its name.
 */
export function stepSummary(step: WorkflowStep, macros: readonly Macro[] = []): string {
  switch (step.kind) {
    case "send-command":
      return step.command.trim() || EMPTY_STEP_SUMMARY;
    case "run-script": {
      if (step.sourcePath) return step.sourcePath.split(/[\\/]/).pop() || step.sourcePath;
      const lines = step.script.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) return EMPTY_STEP_SUMMARY;
      return lines.length === 1 ? lines[0] : `${lines[0]} (+${lines.length - 1} more)`;
    }
    case "run-macro":
      if (!step.macroId) return EMPTY_STEP_SUMMARY;
      return macros.find((m) => m.id === step.macroId)?.name ?? "Unknown macro";
    case "wait":
      return `${step.delayMs} ms`;
    case "run-local-process":
      return [step.program, ...step.args].join(" ").trim() || EMPTY_STEP_SUMMARY;
    case "conditional":
      return `If ${conditionSummary(step.condition)} · ${stepCount(step.then.length)}`;
    case "loop":
      return step.loop.kind === "count"
        ? `${step.loop.count}× · ${stepCount(step.body.length)}`
        : `While ${conditionSummary(step.loop.condition)} · ${stepCount(step.body.length)}`;
    case "wait-for-output":
      if (!step.pattern) return EMPTY_STEP_SUMMARY;
      return step.isRegex ? `/${step.pattern}/` : step.pattern;
  }
}

/**
 * The step's failure policy (PROD-045) as short sentence-case notes for the
 * collapsed row — empty when the step uses no error handling.
 */
export function stepPolicySummary(step: WorkflowStep): string[] {
  const notes: string[] = [];
  if (step.continueOnError) notes.push("Continues on error");
  if (step.retry) notes.push(`Retries ${step.retry.count}×`);
  return notes;
}
