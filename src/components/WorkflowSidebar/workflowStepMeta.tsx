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
import { Terminal, FileCode, Play, Clock, Cpu } from "lucide-react";
import type { WorkflowStep, WorkflowStepKind } from "@/types/workflow";
import type { Macro } from "@/types/macro";

/** The step kinds, in the order they appear in the "Add step…" menu. */
export const WORKFLOW_STEP_KINDS: readonly WorkflowStepKind[] = [
  "send-command",
  "run-script",
  "run-macro",
  "wait",
  "run-local-process",
] as const;

/** Lucide icon component for each step kind (matches the concept mockup). */
const STEP_ICONS: Record<WorkflowStepKind, ComponentType<{ size?: number | string }>> = {
  "send-command": Terminal,
  "run-script": FileCode,
  "run-macro": Play,
  wait: Clock,
  "run-local-process": Cpu,
};

/** The icon component for a step kind. */
export function stepKindIcon(kind: WorkflowStepKind): ComponentType<{ size?: number | string }> {
  return STEP_ICONS[kind];
}

/** Human-readable label shown in the "Add step…" menu and each step row. */
export function stepKindLabel(kind: WorkflowStepKind): string {
  return kind;
}

/** Truncate a single-line string to `maxLength`, appending an ellipsis. */
function truncate(text: string, maxLength = 60): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
