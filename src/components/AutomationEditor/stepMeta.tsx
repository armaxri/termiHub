/**
 * Labels, icons, defaults and one-line summaries of automation steps and
 * triggers, shared by the editor, the sidebar and the run history (#5529), so
 * one kind reads the same everywhere.
 */
import type { ComponentType } from "react";
import {
  Clock,
  Cpu,
  Eye,
  FileCode,
  GitBranch,
  Keyboard,
  Play,
  Repeat,
  ScanText,
  Terminal,
  Unplug,
  Zap,
} from "lucide-react";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { TypingSpeed } from "@/types/generated/TypingSpeed";
import type { WorkflowComparisonOp, WorkflowCondition, WorkflowRunTrigger } from "@/types/workflow";
import { DEFAULT_FIXED_DELAY_MS } from "@/services/macroPlayback";
import { t } from "@/i18n/catalog";
import { formatMacroStepData } from "./keysFormat";

/** All step discriminants. */
export type AutomationStepKind = AutomationStep["kind"];

/** All trigger discriminants. */
export type AutomationTriggerKind = AutomationTrigger["kind"];

/** The step kinds, in the order the "Add step" menu offers them. */
export const AUTOMATION_STEP_KINDS: readonly AutomationStepKind[] = [
  "type-keys",
  "send-command",
  "wait",
  "wait-for-output",
  "conditional",
  "loop",
  "run-script",
  "run-automation",
  "run-local-process",
] as const;

/** The everyday kinds, shown first; the menu groups the rest under "More". */
const BASIC_STEP_KINDS: ReadonlySet<AutomationStepKind> = new Set<AutomationStepKind>([
  "type-keys",
  "send-command",
  "wait",
  "wait-for-output",
]);

/** The kinds that hold steps of their own. Nested lists do not offer them. */
const CONTAINER_STEP_KINDS: ReadonlySet<AutomationStepKind> = new Set<AutomationStepKind>([
  "conditional",
  "loop",
]);

/** What an "Add step" menu offers, in its two groups. */
export interface OfferedStepKinds {
  basic: AutomationStepKind[];
  more: AutomationStepKind[];
}

/**
 * The step kinds an "Add step" menu offers. "Run local process" stays behind
 * the experimental switch (#5818, maintainer decision): it is offered only while
 * that is on. A step that is already there still shows and can be edited or
 * removed; running it is refused elsewhere (#5988). A nested list offers no
 * further nesting (the authoring UI is bounded to one level).
 */
export function offeredStepKinds(experimental: boolean, nested = false): OfferedStepKinds {
  const offered = AUTOMATION_STEP_KINDS.filter(
    (kind) =>
      (experimental || kind !== "run-local-process") && !(nested && CONTAINER_STEP_KINDS.has(kind))
  );
  return {
    basic: offered.filter((kind) => BASIC_STEP_KINDS.has(kind)),
    more: offered.filter((kind) => !BASIC_STEP_KINDS.has(kind)),
  };
}

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

/** Lucide icon component for each step kind. */
const STEP_ICONS: Record<AutomationStepKind, ComponentType<{ size?: number | string }>> = {
  "type-keys": Keyboard,
  "send-command": Terminal,
  "run-script": FileCode,
  "run-automation": Play,
  wait: Clock,
  "run-local-process": Cpu,
  conditional: GitBranch,
  loop: Repeat,
  "wait-for-output": Eye,
};

/** The icon component for a step kind. */
export function stepKindIcon(kind: AutomationStepKind): ComponentType<{ size?: number | string }> {
  return STEP_ICONS[kind] ?? Play;
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
};

/** Human-readable label shown in the "Add step" menu and each step row. */
export function stepKindLabel(kind: AutomationStepKind): string {
  return STEP_LABELS[kind] ?? kind;
}

/** Lucide icon component for each trigger kind. */
const TRIGGER_ICONS: Record<AutomationTriggerKind, ComponentType<{ size?: number | string }>> = {
  hotkey: Keyboard,
  "on-connect": Zap,
  "on-disconnect": Unplug,
  "on-output-match": ScanText,
};

/** The icon component for a trigger kind. */
export function triggerKindIcon(
  kind: AutomationTriggerKind
): ComponentType<{ size?: number | string }> {
  return TRIGGER_ICONS[kind] ?? Zap;
}

/**
 * Human-readable label of a trigger kind, or of what launched a recorded run
 * (`WorkflowRunTrigger` is the trigger kinds plus `scheduled`). One map so the
 * editor, the row's trigger marker and the run history use the same wording
 * (#5529).
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
 * Build a default step of the given kind, used when the user adds a new step.
 * Fields start empty (or at a sensible default) and are then edited in place.
 */
export function newStep(kind: AutomationStepKind): AutomationStep {
  switch (kind) {
    case "type-keys":
      return { kind, chunks: [], timing: "recorded" };
    case "send-command":
      return { kind, command: "" };
    case "run-script":
      return { kind, script: "" };
    case "run-automation":
      return { kind, automationId: "" };
    case "wait":
      return { kind, delayMs: 500 };
    case "run-local-process":
      return { kind, program: "", args: [] };
    case "conditional":
      // `else` stays absent (not `[]`) until a step is added to it: a false
      // condition without an else branch does nothing.
      return { kind, condition: { left: "", op: "eq", right: "" }, then: [] };
    case "loop":
      // A small fixed count, so a new loop is bounded; the author can switch to
      // a while-condition.
      return { kind, loop: { kind: "count", count: 3 }, body: [] };
    case "wait-for-output":
      // Literal text is the safer default; `isRegex`/`timeoutMs` stay absent
      // until the author sets them.
      return { kind, pattern: "" };
  }
}

/** Build a default trigger of the given kind. */
export function newTrigger(kind: AutomationTriggerKind): AutomationTrigger {
  switch (kind) {
    case "hotkey":
      return { kind, binding: "" };
    case "on-output-match":
      return { kind, connectionIds: [], pattern: "" };
    default:
      return { kind, connectionIds: [] };
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
    default:
      return "";
  }
}

/** The typing speeds, in the order of the picker. */
export const TYPING_SPEEDS: readonly TypingSpeed[] = ["recorded", "fixed", "instant"] as const;

/** Label of a typing speed. A hand-written step has no recording to replay. */
export function typingSpeedLabel(speed: TypingSpeed, recorded: boolean): string {
  switch (speed) {
    case "recorded":
      return recorded ? "As recorded" : "Delay per row";
    case "fixed":
      return "Same delay before every key";
    case "instant":
      return "Instant";
  }
}

/** What a collapsed Type keys row says about its keys and speed. */
function typingNotes(step: Extract<AutomationStep, { kind: "type-keys" }>): string[] {
  const notes: string[] = [];
  if (step.recorded) {
    const n = step.chunks.length;
    notes.push(`${n} key${n === 1 ? "" : "s"}, recorded`);
  }
  if (step.timing === "instant") notes.push("Instant");
  if (step.timing === "fixed") {
    notes.push(`${step.fixedDelayMs ?? DEFAULT_FIXED_DELAY_MS} ms per key`);
  }
  return notes;
}

/**
 * Short notes for a collapsed row: a Type keys step's keys and speed, and the
 * step's failure policy (PROD-045) when it has one.
 */
export function stepNotes(step: AutomationStep): string[] {
  const notes = step.kind === "type-keys" ? typingNotes(step) : [];
  if (step.continueOnError) notes.push("Continues if it fails");
  if (step.retry) notes.push(`Retries ${step.retry.count}×`);
  return notes;
}
