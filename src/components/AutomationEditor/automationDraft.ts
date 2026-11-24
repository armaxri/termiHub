/**
 * The editor's working copy of an automation (#5818, slice 7). All **pure**.
 *
 * A draft holds what a stored automation cannot: key text that does not parse
 * yet, a cleared number field, and a stable id per step, key row and trigger
 * (React key, reorder, undo). Everything the editor does not edit stays on the
 * stored object it came from, so {@link fromDraft} of an untouched draft is
 * value-identical to the automation it was opened with: recorded chunks byte
 * for byte, fields this build does not know included.
 */
import { newId } from "@/services/transport/ids";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";
import type { WorkflowParameter } from "@/types/generated/WorkflowParameter";
import { remapConnectionIdList, type ConnectionIdRemap } from "@/utils/connectionIdChanges";
import { draftKey } from "@/utils/draftKey";
import { normalizeItemDescription } from "@/utils/itemDescription";
import { parseTags } from "@/utils/parseTags";
import { escapeMacroStepData, parseMacroStepText } from "./keysFormat";

/** The `type-keys` automation step. */
export type TypeKeysStep = Extract<AutomationStep, { kind: "type-keys" }>;

/** A trigger that is bound to connections. */
export type ConnectionTrigger = Exclude<AutomationTrigger, { kind: "hotkey" }>;

/** One row of a Type keys step: escape notation plus the delay before it. */
export interface KeyDraft {
  uid: string;
  text: string;
  delayMs: number | "";
  /** The stored chunk the row was opened from; absent for an added row. */
  source?: TypeKeysChunk;
}

/** The nested step lists of a container step. */
export type StepListName = "then" | "else" | "body";

/** One step: its stored fields, with keys and nested lists as drafts. */
export interface StepDraft {
  uid: string;
  /** The stored step. Its chunks and nested lists are the opened ones. */
  step: AutomationStep;
  /** The rows of a `type-keys` step. */
  keys?: KeyDraft[];
  /** The nested lists of a `conditional` or `loop` step. */
  lists?: Partial<Record<StepListName, StepDraft[]>>;
}

/** One automatic trigger. */
export interface TriggerDraft {
  uid: string;
  trigger: AutomationTrigger;
}

/** Everything the editor edits. */
export interface AutomationDraft {
  name: string;
  description: string;
  /** Comma-separated. */
  tags: string;
  steps: StepDraft[];
  triggers: TriggerDraft[];
  /** The Armed switch of the automatic triggers. */
  triggersEnabled: boolean;
  parameters: WorkflowParameter[];
}

/** Delay of a key row added after another one, in milliseconds. */
export const ADDED_KEYS_DELAY_MS = 100;

/** A blank key row. The first row of a step types at once. */
export function newKeyDraft(first: boolean): KeyDraft {
  return { uid: newId("keys"), text: "", delayMs: first ? 0 : ADDED_KEYS_DELAY_MS };
}

function toKeyDraft(source: TypeKeysChunk): KeyDraft {
  return {
    uid: newId("keys"),
    text: escapeMacroStepData(source.data),
    delayMs: source.delayMs,
    source,
  };
}

/** The draft of a stored step. */
export function toStepDraft(step: AutomationStep): StepDraft {
  const draft: StepDraft = { uid: newId("step"), step };
  switch (step.kind) {
    case "type-keys":
      // An empty step still shows a row to type into.
      draft.keys = step.chunks.length > 0 ? step.chunks.map(toKeyDraft) : [newKeyDraft(true)];
      break;
    case "conditional":
      draft.lists = {
        then: step.then.map(toStepDraft),
        else: (step.else ?? []).map(toStepDraft),
      };
      break;
    case "loop":
      draft.lists = { body: step.body.map(toStepDraft) };
      break;
  }
  return draft;
}

/** The chunk a row saves as: the stored one itself while untouched. */
function toChunk(key: KeyDraft): TypeKeysChunk {
  const { source } = key;
  const parsed = parseMacroStepText(key.text);
  // Text that does not parse blocks Save; a summary still shows it as typed.
  const data = parsed.ok ? parsed.data : key.text;
  const delayMs = key.delayMs === "" ? 0 : Math.max(0, Math.round(key.delayMs));
  if (source && source.data === data && source.delayMs === key.delayMs) return source;
  return { ...source, data, delayMs };
}

/** Whether a row is the blank placeholder of a step without keys. */
function isBlank(key: KeyDraft): boolean {
  return key.source === undefined && key.text === "";
}

/** The step a draft saves as: the stored one itself while untouched. */
export function fromStepDraft(draft: StepDraft): AutomationStep {
  const { step } = draft;
  const list = (name: StepListName) => (draft.lists?.[name] ?? []).map(fromStepDraft);
  switch (step.kind) {
    case "type-keys": {
      const keys = draft.keys ?? [];
      const chunks = keys.length === 1 && isBlank(keys[0]) ? [] : keys.map(toChunk);
      const untouched =
        chunks.length === step.chunks.length && chunks.every((c, i) => c === step.chunks[i]);
      return untouched ? step : { ...step, chunks };
    }
    case "conditional": {
      const next = { ...step, then: list("then") };
      const otherwise = list("else");
      if (otherwise.length > 0 || step.else?.length === 0) next.else = otherwise;
      else delete next.else;
      return next;
    }
    case "loop":
      return { ...step, body: list("body") };
    default:
      return step;
  }
}

/** A copy of a step with ids of its own. */
export function duplicateStepDraft(draft: StepDraft): StepDraft {
  return toStepDraft(structuredClone(fromStepDraft(draft)));
}

/** The draft of an automation. */
export function toDraft(automation: Automation): AutomationDraft {
  return {
    name: automation.name,
    description: automation.description ?? "",
    tags: automation.tags.join(", "),
    steps: automation.steps.map(toStepDraft),
    triggers: automation.triggers.map((trigger) => ({ uid: newId("trigger"), trigger })),
    triggersEnabled: automation.triggersEnabled !== false,
    parameters: automation.parameters ?? [],
  };
}

/**
 * The automation a draft saves as. A field the user did not change keeps the
 * stored value, also where editing it would normalize it (a description longer
 * than the field allows, a tag holding a comma).
 */
export function fromDraft(draft: AutomationDraft, base: Automation): Automation {
  const next: Automation = {
    ...base,
    name: draft.name === base.name ? base.name : draft.name.trim(),
    tags: draft.tags === base.tags.join(", ") ? base.tags : parseTags(draft.tags),
    steps: draft.steps.map(fromStepDraft),
    triggers: draft.triggers.map((t) => t.trigger),
  };
  if (draft.description !== (base.description ?? "")) {
    const description = normalizeItemDescription(draft.description);
    if (description === undefined) delete next.description;
    else next.description = description;
  }
  // Absent while empty, as the backend writes it.
  if (draft.parameters.length > 0) next.parameters = draft.parameters;
  else if (base.parameters?.length) delete next.parameters;
  if (draft.triggersEnabled !== (base.triggersEnabled !== false)) {
    if (draft.triggersEnabled) delete next.triggersEnabled;
    else next.triggersEnabled = false;
  }
  return next;
}

/** A step without its ids and stored sources, in edit order. */
function stepContent(draft: StepDraft): unknown {
  const { step, keys, lists } = draft;
  switch (step.kind) {
    case "type-keys": {
      const { chunks: _chunks, ...rest } = step;
      return { ...rest, keys: keys?.map(({ text, delayMs }) => ({ text, delayMs })) };
    }
    case "conditional": {
      const { then: _then, else: _else, ...rest } = step;
      return {
        ...rest,
        then: lists?.then?.map(stepContent),
        else: lists?.else?.map(stepContent),
      };
    }
    case "loop": {
      const { body: _body, ...rest } = step;
      return { ...rest, body: lists?.body?.map(stepContent) };
    }
    default:
      return step;
  }
}

/** A key that is equal for two drafts with the same content (ids do not count). */
export function draftContentKey(draft: AutomationDraft): string {
  return draftKey({
    ...draft,
    steps: draft.steps.map(stepContent),
    triggers: draft.triggers.map((t) => t.trigger),
  });
}

/** Re-point the triggers of a draft at renamed connections; itself when none changed. */
export function remapTriggers<T extends AutomationTrigger>(
  triggers: readonly T[],
  remap: ConnectionIdRemap
): T[] | null {
  let changed = false;
  const next = triggers.map((trigger) => {
    if (trigger.kind === "hotkey") return trigger;
    const connectionIds = remapConnectionIdList(trigger.connectionIds, remap);
    if (connectionIds === trigger.connectionIds) return trigger;
    changed = true;
    return { ...trigger, connectionIds };
  });
  return changed ? next : null;
}

/** {@link remapTriggers} over a whole draft; itself when nothing changed. */
export function remapDraftTriggers(
  draft: AutomationDraft,
  remap: ConnectionIdRemap
): AutomationDraft {
  const next = remapTriggers(
    draft.triggers.map((t) => t.trigger),
    remap
  );
  if (!next) return draft;
  return { ...draft, triggers: draft.triggers.map((t, i) => ({ ...t, trigger: next[i] })) };
}

/** Visit every step of a draft, nested ones after their parent. */
export function visitStepDrafts(
  steps: readonly StepDraft[],
  visit: (step: StepDraft, ancestors: readonly StepDraft[]) => void,
  ancestors: readonly StepDraft[] = []
): void {
  for (const step of steps) {
    visit(step, ancestors);
    const inner = [...ancestors, step];
    for (const list of Object.values(step.lists ?? {})) visitStepDrafts(list, visit, inner);
  }
}

/** Whether the automation only types keystrokes (what Record produces). */
export function onlyTypesKeys(steps: readonly StepDraft[]): boolean {
  return steps.length > 0 && steps.every((s) => s.step.kind === "type-keys");
}
