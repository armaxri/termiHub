/** Putting a recording into the editor's draft (#5818, slice 8). All **pure**. */
import { recordingSteps, type RecordedTake } from "@/store/slices/recordingSlice";
import { recordedTime } from "@/utils/recordingText";
import { toStepDraft, type StepDraft } from "./automationDraft";

/** The steps with a recording in them. */
export interface InsertedRecording {
  steps: StepDraft[];
  /** The recorded steps; empty when there was nothing to insert. */
  uids: string[];
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
 * blank row of a new typed automation. Where something was typed at a password
 * prompt it is left out, and the automation waits (see {@link withRecordedSecrets}).
 */
export function insertRecording(
  steps: readonly StepDraft[],
  take: RecordedTake,
  afterUid: string | null
): InsertedRecording {
  const drafts = recordingSteps(take, false).map(toStepDraft);
  if (drafts.length === 0) return { steps: [...steps], uids: [] };
  const uids = drafts.map((d) => d.uid);
  if (isBlank(steps)) return { steps: drafts, uids };
  const after = steps.findIndex((s) => s.uid === afterUid);
  const next = [...steps];
  next.splice(after < 0 ? next.length : after + 1, 0, ...drafts);
  return { steps: next, uids };
}

/** The steps with the recorded steps `uids` typing what was left out, too. */
export function withRecordedSecrets(
  steps: readonly StepDraft[],
  take: RecordedTake,
  uids: readonly string[]
): StepDraft[] {
  const [step] = recordingSteps(take, true).map(toStepDraft);
  if (!step) return [...steps];
  const first = steps.findIndex((s) => uids.includes(s.uid));
  if (first < 0) return isBlank(steps) ? [step] : [...steps, step];
  return steps.flatMap((s, i) => {
    if (i === first) return [{ ...step, uid: s.uid }];
    return uids.includes(s.uid) ? [] : [s];
  });
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
  const left = prompts
    ? ` What you typed at ${prompts} was left out: the automation waits for you there.`
    : "";
  return `Recorded in ${take.tabTitle}, ${recordedTime(take.durationMs)}.${ended}${left}`;
}
