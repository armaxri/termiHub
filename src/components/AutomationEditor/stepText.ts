/**
 * The words of automation steps and triggers (#5529): labels and one-line
 * summaries, without the icons of `stepMeta`, so that stores and services can
 * name a step too. All **pure**.
 */
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { WorkflowComparisonOp, WorkflowCondition } from "@/types/workflow";
import { t } from "@/i18n/catalog";
import { formatMacroStepData } from "./keysFormat";

/** All step discriminants. */
export type AutomationStepKind = AutomationStep["kind"];

/** All trigger discriminants. */
export type AutomationTriggerKind = AutomationTrigger["kind"];

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

/**
 * Sentence-case label of each step kind. The kind ids are internal
 * identifiers (`send-command`); users see these labels instead (#5529).
 */
const STEP_LABELS: Record<AutomationStepKind, string> = {
  "type-keys": "Type keys",
  "send-command": "Run command",
  "run-script": "Run script",
  "run-automation": "Run automation",
  wait: "Wait",
  "run-local-process": "Run local process",
  conditional: "Condition",
  loop: "Loop",
  "wait-for-output": "Wait for output",
  "wait-for-user": "Wait for you",
};

/** Human-readable label shown in the "Add step" menu and each step row. */
export function stepKindLabel(kind: AutomationStepKind): string {
  return isKnownStepKind(kind) ? STEP_LABELS[kind] : `Unknown step (${kind})`;
}

/** Whether this build can run a step of `kind`; a newer termiHub may have written it (#6009). */
export function isKnownStepKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(STEP_LABELS, kind);
}

/**
 * Human-readable label of a trigger kind, or of what else starts a run. One map so the
 * editor, the row's trigger marker and the run history use the same wording
 * (#5529).
 */
export function triggerKindLabel(kind: AutomationTriggerKind | "manual"): string {
  switch (kind) {
    case "manual":
      return "Manual";
    case "on-connect":
      return "On connect";
    case "hotkey":
      return "Hotkey";
    case "on-disconnect":
      return t("workflow.trigger.onDisconnect.label");
    case "on-output-match":
      return t("workflow.trigger.onOutputMatch.label");
  }
}

/** Shown in a collapsed step's summary when its main field is still empty. */
export const EMPTY_STEP_SUMMARY = "Not set yet";

/** Shown for a "Run automation" step whose automation is not in the library. */
export const MISSING_AUTOMATION = "Missing automation";

/** A duration in seconds, the unit the editor uses (R-167): `0.5 s`, `12 s`. */
export function formatSeconds(ms: number): string {
  return `${ms / 1000} s`;
}

/** `left op right` of a condition, for a one-line summary. */
function conditionSummary(condition: WorkflowCondition): string {
  return `${condition.left || "…"} ${conditionOpLabel(condition.op)} ${condition.right || "…"}`;
}

/** "1 step" / "3 steps". */
function stepCount(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

/**
 * One-line summary of a step's main value, shown on a collapsed step row and in
 * the sidebar's row tooltip (#5637): what it types, the command, the script's
 * first line, the delay, and so on. `automations` resolves the automation a
 * step runs to its name.
 */
export function stepSummary(
  step: AutomationStep,
  automations: readonly Pick<Automation, "id" | "name">[] = []
): string {
  switch (step.kind) {
    case "type-keys":
      return formatMacroStepData(step.chunks.map((c) => c.data).join("")) || EMPTY_STEP_SUMMARY;
    case "send-command":
      return step.command.trim() || EMPTY_STEP_SUMMARY;
    case "run-script": {
      if (step.sourcePath) return step.sourcePath.split(/[\\/]/).pop() || step.sourcePath;
      const lines = step.script.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) return EMPTY_STEP_SUMMARY;
      return lines.length === 1 ? lines[0] : `${lines[0]} (+${lines.length - 1} more)`;
    }
    case "run-automation":
      if (!step.automationId) return EMPTY_STEP_SUMMARY;
      return automations.find((a) => a.id === step.automationId)?.name ?? MISSING_AUTOMATION;
    case "wait":
      return formatSeconds(step.delayMs);
    case "run-local-process":
      return [step.program, ...step.args].join(" ").trim() || EMPTY_STEP_SUMMARY;
    case "conditional":
      return `If ${conditionSummary(step.condition)} · ${stepCount(step.then.length)}`;
    case "loop":
      return step.loop.kind === "count"
        ? `${step.loop.count}× · ${stepCount(step.body.length)}`
        : `While ${conditionSummary(step.loop.condition)} · ${stepCount(step.body.length)}`;
    case "wait-for-output": {
      if (!step.pattern) return EMPTY_STEP_SUMMARY;
      const pattern = step.isRegex ? `/${step.pattern}/` : step.pattern;
      return step.timeoutMs === undefined
        ? pattern
        : `${pattern} · ${formatSeconds(step.timeoutMs)}`;
    }
    case "wait-for-user":
      return step.message?.trim() || t("automation.wait.message");
    default:
      return "";
  }
}
