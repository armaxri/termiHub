/**
 * Validation of the automation editor's draft (#5818, slice 7). All **pure**.
 *
 * Errors are keyed by a path of stable ids (`steps.<uid>.keys.<uid>.text`), so
 * `useRevealOnSave` can tell which ones are the user's to see (#5917): the same
 * paths appear in {@link draftValues}. What blocks Save is what the two old
 * editors blocked: no name, no step, keys that are empty or do not parse, a
 * failure policy or an output-match trigger out of bounds.
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
import { stepPolicyErrors } from "./stepPolicySchema";

/** Error path of the step list itself. */
export const STEP_LIST_ERROR = "stepList";

const PATTERN_ERROR: Record<OutputPatternError, MessageId> = {
  empty: "workflow.trigger.pattern.error.empty",
  "too-long": "workflow.trigger.pattern.error.tooLong",
  "invalid-regex": "workflow.trigger.pattern.error.invalidRegex",
  "unsafe-regex": "workflow.trigger.pattern.error.unsafeRegex",
};

function stepErrors(draft: StepDraft, out: ZodFieldErrors): void {
  const base = `steps.${draft.uid}`;
  // Only the recorded speed uses the delays (and shows them).
  const delays =
    draft.step.kind === "type-keys" && (draft.step.timing ?? "recorded") === "recorded";
  for (const key of draft.keys ?? []) {
    if (key.text === "") {
      out[`${base}.keys.${key.uid}.text`] = "Enter the keys to type.";
    } else {
      const parsed = parseMacroStepText(key.text);
      if (!parsed.ok) out[`${base}.keys.${key.uid}.text`] = parsed.error;
    }
    if (delays && key.delayMs !== "" && (!Number.isFinite(key.delayMs) || key.delayMs < 0)) {
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
  if (trigger.kind !== "on-output-match") return;
  const base = `triggers.${uid}`;
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
  visitStepDrafts(draft.steps, ({ uid, step, keys }) => {
    const { retry } = step;
    steps[uid] = {
      retry,
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
