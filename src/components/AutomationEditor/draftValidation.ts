/**
 * Validation of the automation editor's draft (#5818, slice 7). All **pure**.
 *
 * Errors are keyed by a path of stable ids (`steps.<uid>.keys.<uid>.text`), so
 * `useRevealOnSave` can tell which ones are the user's to see (#5917): the same
 * paths appear in {@link draftValues}. What blocks Save: no name, no step, an
 * empty field a step cannot do without, keys that are empty or do not parse, a
 * failure policy or an output-match trigger out of bounds, a hotkey without keys.
 */
import {
  cooldownInRange,
  maxFiresInRange,
  validateOutputPattern,
  type OutputPatternError,
} from "@/services/workflowOutputTriggers";
import type { ZodFieldErrors } from "@/hooks/useZodEditorForm";
import { t, type MessageId } from "@/i18n/catalog";
import {
  visitStepDrafts,
  type AutomationDraft,
  type StepDraft,
  type TriggerDraft,
} from "./automationDraft";
import { parseMacroStepText } from "./keysFormat";
import { stepKindLabel } from "./stepText";
import { stepPolicyErrors } from "./stepPolicySchema";

/** Error path of the step list itself. */
export const STEP_LIST_ERROR = "stepList";

const PATTERN_ERROR: Record<OutputPatternError, MessageId> = {
  empty: "workflow.trigger.pattern.error.empty",
  "too-long": "workflow.trigger.pattern.error.tooLong",
  "invalid-regex": "workflow.trigger.pattern.error.invalidRegex",
  "unsafe-regex": "workflow.trigger.pattern.error.unsafeRegex",
};

/** The field a step cannot do without: its value, and what to say when it is empty (A-022). */
function requiredField({ step }: StepDraft): { name: string; value: string; error: string } | null {
  switch (step.kind) {
    case "send-command":
      return { name: "command", value: step.command, error: "Enter the command." };
    case "run-script":
      // A step with a file reads it when it runs.
      return step.sourcePath
        ? null
        : { name: "script", value: step.script, error: "Enter the lines to type." };
    case "run-automation":
      return { name: "automationId", value: step.automationId, error: "Choose an automation." };
    case "run-local-process":
      return { name: "program", value: step.program, error: "Enter the program." };
    case "wait-for-output":
      // Blanks count: a prompt may be waited for by the space it ends with.
      return {
        name: "pattern",
        value: step.pattern === "" ? "" : "set",
        error: "Enter the text to wait for.",
      };
    case "conditional":
      return { name: "left", value: step.condition.left, error: "Enter what to compare." };
    case "loop":
      return step.loop.kind === "while"
        ? { name: "left", value: step.loop.condition.left, error: "Enter what to compare." }
        : null;
    default:
      return null;
  }
}

function stepErrors(draft: StepDraft, out: ZodFieldErrors): void {
  const base = `steps.${draft.uid}`;
  const required = requiredField(draft);
  if (required && required.value.trim() === "") out[`${base}.${required.name}`] = required.error;
  // Only the recorded speed uses the delays, and never the first (nor are they shown).
  const delays =
    draft.step.kind === "type-keys" && (draft.step.timing ?? "recorded") === "recorded";
  for (const [index, key] of (draft.keys ?? []).entries()) {
    if (key.text === "") {
      out[`${base}.keys.${key.uid}.text`] = "Enter the keys to type.";
    } else {
      const parsed = parseMacroStepText(key.text);
      if (!parsed.ok) out[`${base}.keys.${key.uid}.text`] = parsed.error;
    }
    if (
      delays &&
      index > 0 &&
      key.delayMs !== "" &&
      (!Number.isFinite(key.delayMs) || key.delayMs < 0)
    ) {
      out[`${base}.keys.${key.uid}.delayMs`] = "Delay must be 0 or more.";
    }
  }
  const policy = stepPolicyErrors(draft.step);
  if (policy.count ?? policy.other) {
    out[`${base}.retry.count`] = policy.count ?? policy.other ?? "";
  }
  if (policy.delayMs) out[`${base}.retry.delayMs`] = policy.delayMs;
}

function triggerErrors({ uid, trigger }: TriggerDraft, out: ZodFieldErrors): void {
  const base = `triggers.${uid}`;
  if (trigger.kind === "hotkey" && trigger.binding.trim() === "") {
    out[`${base}.binding`] = "Press the keys.";
  }
  if (trigger.kind !== "on-output-match") return;
  const pattern = validateOutputPattern(trigger.pattern, trigger.isRegex);
  if (pattern) out[`${base}.pattern`] = t(PATTERN_ERROR[pattern]);
  if (!cooldownInRange(trigger.cooldownMs)) {
    out[`${base}.cooldownMs`] = t("workflow.trigger.onOutputMatch.cooldownError");
  }
  if (!maxFiresInRange(trigger.maxFiresPerSession)) {
    out[`${base}.maxFiresPerSession`] = t("workflow.trigger.onOutputMatch.maxFiresError");
  }
}

/** Everything that keeps the draft from being saved, by path. */
export function draftErrors(draft: AutomationDraft): ZodFieldErrors {
  const out: ZodFieldErrors = {};
  if (draft.name.trim() === "") out.name = "Name is required.";
  if (draft.steps.length === 0) out[STEP_LIST_ERROR] = "Add at least one step.";
  visitStepDrafts(draft.steps, (step) => stepErrors(step, out));
  for (const trigger of draft.triggers) triggerErrors(trigger, out);
  return out;
}

/** The draft's values under the paths {@link draftErrors} uses. */
export function draftValues(draft: AutomationDraft): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  visitStepDrafts(draft.steps, (stepDraft) => {
    const { uid, step, keys } = stepDraft;
    const { retry } = step;
    const required = requiredField(stepDraft);
    steps[uid] = {
      retry,
      ...(required ? { [required.name]: required.value } : {}),
      keys: Object.fromEntries(
        (keys ?? []).map(({ uid: k, text, delayMs }) => [k, { text, delayMs }])
      ),
    };
  });
  return {
    name: draft.name,
    [STEP_LIST_ERROR]: draft.steps.length > 0 ? "some" : "",
    steps,
    triggers: Object.fromEntries(draft.triggers.map(({ uid, trigger }) => [uid, trigger])),
  };
}

/** The uids of the steps that have an error, and of the steps around them. */
export function stepsWithErrors(draft: AutomationDraft, errors: ZodFieldErrors): Set<string> {
  const paths = Object.keys(errors);
  const out = new Set<string>();
  visitStepDrafts(draft.steps, (step, ancestors) => {
    if (!paths.some((path) => path.startsWith(`steps.${step.uid}.`))) return;
    out.add(step.uid);
    for (const ancestor of ancestors) out.add(ancestor.uid);
  });
  return out;
}

/** The first step that keeps the draft from being saved (#6183, editor-4). */
export interface StepProblem {
  /** The step's uid, to open and focus it. */
  uid: string;
  /** Its number as the list shows it: "2", or "1.1" inside step 1. */
  number: string;
  /** Its kind, as the add-step menu names it. */
  kind: string;
  /** What is wrong, in a few words: the first clause of its first error, lower case. */
  message: string;
}

/** The phrase of the save hint that names a step, also the text of its link. */
export function stepFixPhrase(problem: StepProblem): string {
  return `fix step ${problem.number} (${problem.kind})`;
}

/** The first step, in list order, with an error; `null` when no step has one. */
export function firstStepProblem(
  draft: AutomationDraft,
  errors: ZodFieldErrors
): StepProblem | null {
  const paths = Object.keys(errors);
  const walk = (steps: readonly StepDraft[], prefix: string): StepProblem | null => {
    for (const [index, step] of steps.entries()) {
      const number = `${prefix}${index + 1}`;
      const path = paths.find((p) => p.startsWith(`steps.${step.uid}.`));
      if (path) {
        const first = errors[path].split(" — ")[0].replace(/\.$/, "");
        return {
          uid: step.uid,
          number,
          kind: stepKindLabel(step.step.kind),
          message: first.charAt(0).toLowerCase() + first.slice(1),
        };
      }
      for (const list of Object.values(step.lists ?? {})) {
        const inner = walk(list, `${number}.`);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(draft.steps, "");
}

/**
 * What is missing, in a few words for the footer (A-023); `null` when nothing
 * is. With `problem` it names the step to fix and what is wrong with it,
 * instead of "complete the steps" (#6183, editor-4).
 */
export function missingSummary(
  errors: ZodFieldErrors,
  problem: StepProblem | null = null
): string | null {
  const paths = Object.keys(errors);
  if (paths.length === 0) return null;
  const parts: string[] = [];
  if (errors.name) parts.push("give it a name");
  if (errors[STEP_LIST_ERROR]) parts.push("add at least one step");
  const steps = paths.some((path) => path.startsWith("steps."));
  const triggers = paths.some((path) => path.startsWith("triggers."));
  if (steps && problem) {
    parts.push(`${stepFixPhrase(problem)}: ${problem.message}`);
    if (triggers) parts.push("complete the triggers");
  } else if (steps || triggers) {
    const where = [...(steps ? ["steps"] : []), ...(triggers ? ["triggers"] : [])];
    parts.push(`complete the ${where.join(" and the ")}`);
  }
  // Joined by hand: a step's message may hold a comma of its own.
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `To save: ${list}.`;
}
