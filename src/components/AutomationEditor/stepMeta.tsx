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
  CircleHelp,
  GitBranch,
  Hand,
  Keyboard,
  Play,
  Repeat,
  ScanText,
  Terminal,
  Unplug,
  Zap,
} from "lucide-react";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { TypingSpeed } from "@/types/generated/TypingSpeed";
import type { WorkflowComparisonOp } from "@/types/workflow";
import { DEFAULT_FIXED_DELAY_MS } from "@/services/macroPlayback";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";
import { isKnownStepKind, type AutomationStepKind, type AutomationTriggerKind } from "./stepText";

export {
  EMPTY_STEP_SUMMARY,
  MISSING_AUTOMATION,
  conditionOpLabel,
  formatSeconds,
  isKnownStepKind,
  stepKindLabel,
  stepSummary,
  triggerKindLabel,
  type AutomationStepKind,
  type AutomationTriggerKind,
} from "./stepText";

/** The step kinds, in the order the "Add step" menu offers them. */
export const AUTOMATION_STEP_KINDS: readonly AutomationStepKind[] = [
  "type-keys",
  "send-command",
  "wait",
  "wait-for-output",
  "wait-for-user",
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
  "wait-for-user": Hand,
};

/** The icon component for a step kind. */
export function stepKindIcon(kind: AutomationStepKind): ComponentType<{ size?: number | string }> {
  return isKnownStepKind(kind) ? STEP_ICONS[kind] : CircleHelp;
}

/** What each kind does, in the words of the "Add step" menu (A-028). */
const STEP_DESCRIPTIONS: Record<AutomationStepKind, string> = {
  "type-keys": "Types keys exactly as you press them",
  "send-command": "Types a command and presses Enter",
  "run-script": "Types the lines of a script, one by one",
  "run-automation": "Runs another automation in the same terminal",
  wait: "Waits a number of seconds",
  "run-local-process": "Starts a program on this computer, not in the terminal",
  conditional: "Runs steps only if a comparison holds",
  loop: "Repeats steps",
  "wait-for-output": "Waits until the terminal shows a text",
  "wait-for-user": "Pauses until you press Continue, e.g. to type a password",
};

/** The "Add step" menu's second line for a step kind. */
export function stepKindDescription(kind: AutomationStepKind): string {
  return STEP_DESCRIPTIONS[kind];
}

/** Why a step of an unknown kind does not run. */
export const UNKNOWN_STEP_REASON =
  "Will not run: a newer version of termiHub made this step, and this one does not know it. " +
  "Nothing of the automation runs until you update termiHub or delete the step.";

/** Why a "Run local process" step does not run while the switch is off (A-031). */
export const LOCAL_PROCESS_STEP_REASON =
  "Will not run: local programs are experimental and switched off. " +
  `Nothing of the automation runs until you turn on ${EXPERIMENTAL_SETTING_PATH} or delete the step.`;

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
    case "wait-for-user":
      return { kind };
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

/** The typing speeds, in the order of the picker. */
export const TYPING_SPEEDS: readonly TypingSpeed[] = ["recorded", "fixed", "instant"] as const;

/** Label of a typing speed. A hand-written step has no recording to replay. */
export function typingSpeedLabel(speed: TypingSpeed, recorded: boolean): string {
  switch (speed) {
    case "recorded":
      return recorded ? "As recorded" : "Own pause before each row";
    case "fixed":
      return "Same delay everywhere";
    case "instant":
      return "No delay";
  }
}

/** What a collapsed Type keys row says about its origin and speed. */
function typingNotes(step: Extract<AutomationStep, { kind: "type-keys" }>): string[] {
  const notes: string[] = [];
  if (step.recorded) notes.push("Recorded");
  if (step.timing === "instant") notes.push("No delay");
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
