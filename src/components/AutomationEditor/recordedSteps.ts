/** Putting a recording into the editor's draft (#5818, slice 8). All **pure**. */
import { recordingStep, type RecordedTake } from "@/store/slices/recordingSlice";
import { recordedKeys } from "@/utils/recordingText";
import { toStepDraft, type StepDraft } from "./automationDraft";

/** The steps with a recording in them. */
export interface InsertedRecording {
  steps: StepDraft[];
  /** The recorded step; `null` when there was nothing to insert. */
  uid: string | null;
}

/** Whether the steps are only the blank row a new typed automation starts with. */
function isBlank(steps: readonly StepDraft[]): boolean {
  const [first] = steps;
  return (
    steps.length === 1 &&
    first.keys?.length === 1 &&
    first.keys[0].text === "" &&
    first.keys[0].source === undefined
  );
}

/**
 * Insert a recording after the step `afterUid`, or at the end. It replaces the
 * blank row of a new typed automation. What was typed at password prompts stays
 * out (see {@link withRecordedSecrets}).
 */
export function insertRecording(
  steps: readonly StepDraft[],
  take: RecordedTake,
  afterUid: string | null
): InsertedRecording {
  const step = recordingStep(take, false);
  if (!step) return { steps: [...steps], uid: null };
  const draft = toStepDraft(step);
  if (isBlank(steps)) return { steps: [draft], uid: draft.uid };
  const after = steps.findIndex((s) => s.uid === afterUid);
  const next = [...steps];
  next.splice(after < 0 ? next.length : after + 1, 0, draft);
  return { steps: next, uid: draft.uid };
}

/** The steps with the recording `uid` holding what was typed at password prompts too. */
export function withRecordedSecrets(
  steps: readonly StepDraft[],
  take: RecordedTake,
  uid: string | null
): StepDraft[] {
  const step = recordingStep(take, true);
  if (!step) return [...steps];
  const draft = toStepDraft(step);
  if (uid === null) return isBlank(steps) ? [draft] : [...steps, draft];
  return steps.map((s) => (s.uid === uid ? { ...draft, uid } : s));
}

const ENDED: Partial<Record<RecordedTake["ended"], string>> = {
  "session-ended": " The session ended.",
  "tab-gone": " The terminal was closed or moved to another window.",
};

/** What the editor says about a recording that came back. */
export function recordedNote(take: RecordedTake): string {
  const ended = ENDED[take.ended] ?? "";
  if (take.chunks.length === 0) return `Nothing was typed in ${take.tabTitle}.${ended}`;
  const prompts = [...new Set(take.secrets.map((s) => `“${s.prompt}”`))].join(", ");
  const left = prompts ? ` What you typed at ${prompts} was left out.` : "";
  return `Recorded ${recordedKeys(take.chunks.length)} in ${take.tabTitle}.${ended}${left}`;
}
