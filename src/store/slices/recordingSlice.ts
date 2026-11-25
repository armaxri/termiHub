/**
 * Recording what the user types (#5818, slice 8): one recording at a time, bound
 * to one terminal, and the take it leaves behind until the user saves or
 * discards it. Nothing typed is dropped without being asked for: closing the
 * save dialog keeps the take, and discarding it can be undone.
 */
import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import { isTerminalReady } from "@/services/macroPlayback";
import { newId } from "@/services/transport/ids";
import {
  InputRecorder,
  recordedParts,
  type ReadPrompt,
  type Recorded,
  type RecordingSlot,
} from "@/services/inputRecorder";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { t } from "@/i18n/catalog";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { showUndoToast } from "@/utils/undoableDelete";

import type { AppState } from "../appStore";
import { collectLiveTabs, getActiveTab } from "../layoutHelpers";
import { currentSessionView } from "../sessionBridge";
import { filterConnectedTerminalTabIds } from "../tabQueries";

/** A recording in progress. Its chunks live in the recorder, not in the store. */
export interface RecordingState {
  /** The one terminal that is recorded. */
  tabId: string;
  tabTitle: string;
  /** Chunks recorded so far. */
  keys: number;
  /** The user is typing at a password prompt. */
  atPrompt: boolean;
  /** Set when the automation editor is waiting for the recording: its name. */
  intoEditor: string | null;
}

/** Why a recording ended. */
export type RecordingEnd = "stopped" | "session-ended" | "tab-gone";

/** A finished recording that is not stored yet. */
export interface RecordedTake extends Recorded {
  id: string;
  tabTitle: string;
  ended: RecordingEnd;
  /** The automation editor takes it; the save dialog does not show it. */
  forEditor: boolean;
}

/** Where a take is saved. */
export type SaveTakeRequest = {
  /** Also store what was typed at password prompts. */
  keepSecrets: boolean;
} & (
  | { to: "new"; name: string; description?: string; tags: string[] }
  | { to: "existing"; automationId: string }
);

/** Options of {@link RecordingSlice.startRecording}. */
export interface StartRecordingOptions {
  /** The terminal to record; the active one when absent. */
  tabId?: string;
  /** Record for the open automation editor; the automation's name. */
  intoEditor?: string;
}

export interface RecordingSlice {
  /** The recording in progress, if any. */
  recording: RecordingState | null;
  /** The finished recording that still has to be saved or discarded. */
  recordedTake: RecordedTake | null;
  /**
   * Takes waiting behind {@link recordedTake}: one brought back with Undo while
   * another recording ran. Each is asked about in turn; none is overwritten.
   */
  queuedTakes: RecordedTake[];
  /** Whether the save dialog shows {@link recordedTake}. */
  recordingSaveOpen: boolean;
  /** The save dialog opened because a new recording was asked for. */
  recordingStartHeld: boolean;
  /**
   * Record what is typed into one connected terminal and focus it. Returns
   * `false`, saying why, when there is none, when a recording runs already, or
   * when an unsaved take has to be dealt with first.
   */
  startRecording: (options?: StartRecordingOptions) => boolean;
  /** Record input `tabId` sent its session. Ignored for any other terminal. */
  recordInput: (tabId: string, data: string, readPrompt?: ReadPrompt) => void;
  /** Keep the place of a paste into `tabId`; `null` when it is not recorded. */
  reserveRecordedPaste: (tabId: string, readPrompt?: ReadPrompt) => RecordingSlot | null;
  /** Stop, and ask what to do with the take (or hand it to the editor). */
  stopRecording: (ended?: RecordingEnd) => void;
  /** Stop and keep nothing: a recording into the editor that went wrong (A-010). */
  cancelRecording: () => void;
  toggleRecording: () => void;
  /**
   * Open a local terminal and record in it once it is connected (A-004). Resolves
   * to whether the recording runs.
   */
  recordInNewTerminal: (options?: Pick<StartRecordingOptions, "intoEditor">) => Promise<boolean>;
  /** Stop when the recorded terminal is gone or its session was ended. */
  followRecordedTerminal: () => void;
  setRecordingSaveOpen: (open: boolean) => void;
  /** Store the take; resolves to the automation's id. Rejects, keeping it, on failure. */
  saveRecordedTake: (request: SaveTakeRequest) => Promise<string>;
  /** Drop the take; a toast offers Undo. */
  discardRecordedTake: () => void;
  /** Take the editor's recording out of the store. */
  takeForEditor: () => RecordedTake | null;
}

/** How a new terminal's connection is awaited, and for how long. */
const NEW_TERMINAL_POLL_MS = 100;
const NEW_TERMINAL_LIMIT_MS = 15_000;

/** The recorder of the running recording. Not serializable, so not in the store. */
let recorder: InputRecorder | null = null;

/**
 * The steps a recording becomes: what was typed, and a "Wait for you" step at
 * each place where a password was left out (#6025). Empty when nothing is left
 * to type.
 */
export function recordingSteps(
  take: Pick<Recorded, "chunks" | "secrets">,
  keepSecrets: boolean
): AutomationStep[] {
  const parts = recordedParts(keepSecrets ? { chunks: take.chunks, secrets: [] } : take);
  if (!parts.some((part) => part.kind === "keys")) return [];
  return parts.map(
    (part): AutomationStep =>
      part.kind === "left-out"
        ? { kind: "wait-for-user", message: t("automation.wait.password") }
        : { kind: "type-keys", chunks: part.chunks, timing: "recorded", recorded: true }
  );
}

/** Whether the session on `tabId` was ended for good (a drop may reconnect). */
function sessionEndedForGood(tabId: string): boolean {
  const session = currentSessionView()[tabId];
  if (!session || session.status === "reconnecting" || session.status === "connecting") {
    return false;
  }
  const reason = session.exit?.reason;
  return (
    reason === "clean" ||
    reason === "killed" ||
    (session.status === "disconnected" && session.endReason === "user")
  );
}

export const createRecordingSlice: StateCreator<AppState, [], [], RecordingSlice> = (set, get) => {
  /** Publish what the recorder knows. */
  const publish = () => {
    const { recording } = get();
    if (!recording || !recorder) return;
    set({ recording: { ...recording, keys: recorder.keys, atPrompt: recorder.atPrompt } });
  };

  /** Show `take`, or queue it behind the one that is shown. */
  const present = (take: RecordedTake) => {
    const { recordedTake, queuedTakes } = get();
    if (recordedTake) set({ queuedTakes: [...queuedTakes, take] });
    else set({ recordedTake: take, recordingSaveOpen: !take.forEditor, recordingStartHeld: false });
  };

  /** Done with `take`: the next one that waits shows. */
  const done = (take: RecordedTake) => {
    const { recordedTake, queuedTakes } = get();
    if (recordedTake !== take) {
      set({ queuedTakes: queuedTakes.filter((t) => t !== take) });
      return;
    }
    const [next, ...rest] = queuedTakes;
    set({
      recordedTake: next ?? null,
      queuedTakes: rest,
      recordingSaveOpen: next !== undefined && !next.forEditor,
      recordingStartHeld: false,
    });
  };

  /** The automation that waits in `tabId` for what is typed there now, if any. */
  const waitIn = (tabId: string) =>
    get().automationWaits.find((w) => w.tabId === tabId)?.automationName;

  return {
    recording: null,
    recordedTake: null,
    queuedTakes: [],
    recordingSaveOpen: false,
    recordingStartHeld: false,

    startRecording: ({ tabId, intoEditor } = {}) => {
      const state = get();
      if (state.recording) return false;
      if (state.recordedTake) {
        // Not lost and not in the way: deal with it, then record again.
        set({ recordingSaveOpen: true, recordingStartHeld: true });
        return false;
      }
      const tab = tabId
        ? collectLiveTabs(state).find((t) => t.id === tabId)
        : (getActiveTab(state) ?? undefined);
      const connected =
        tab?.contentType === "terminal" &&
        filterConnectedTerminalTabIds(state, [tab.id]).length > 0;
      if (!tab || !connected) {
        // toast-policy: explains-outcome — nothing is recorded, and this says why
        toast.info("Open a terminal to record in");
        return false;
      }
      recorder = new InputRecorder();
      set({
        recording: {
          tabId: tab.id,
          tabTitle: tab.title || "Terminal",
          keys: 0,
          atPrompt: false,
          intoEditor: intoEditor ?? null,
        },
      });
      frontendLog("recording", `recording tab=${tab.id}`);
      window.dispatchEvent(
        new CustomEvent("termihub:focus-terminal", { detail: { tabId: tab.id } })
      );
      return true;
    },

    recordInput: (tabId, data, readPrompt) => {
      if (get().recording?.tabId !== tabId || !recorder) return;
      recorder.push(data, readPrompt, waitIn(tabId));
      publish();
    },

    reserveRecordedPaste: (tabId, readPrompt) => {
      if (get().recording?.tabId !== tabId || !recorder) return null;
      const own = recorder;
      const slot = own.reserve(readPrompt, waitIn(tabId));
      return {
        cancel: slot.cancel,
        fill: (data) => {
          // A paste that lands after Stop is not part of the recording.
          if (recorder !== own) return;
          slot.fill(data);
          publish();
        },
      };
    },

    stopRecording: (ended = "stopped") => {
      const { recording } = get();
      if (!recording || !recorder) return;
      const recorded = recorder.finish();
      recorder = null;
      const forEditor = recording.intoEditor !== null;
      frontendLog("recording", `stopped (${ended}) chunks=${recorded.chunks.length}`);
      if (recorded.chunks.length === 0 && !forEditor) {
        set({ recording: null });
        // toast-policy: explains-outcome — recording stops without a take, and this says why
        toast.info("Nothing was typed, so nothing was recorded");
        return;
      }
      set({ recording: null });
      present({ ...recorded, id: newId("take"), tabTitle: recording.tabTitle, ended, forEditor });
    },

    cancelRecording: () => {
      if (!get().recording) return;
      recorder = null;
      set({ recording: null });
      frontendLog("recording", "canceled");
    },

    recordInNewTerminal: async (options) => {
      if (get().recording || get().recordedTake) return get().startRecording(options);
      const tabId = get().addLocalShellTab();
      const ready = () =>
        isTerminalReady(tabId) && filterConnectedTerminalTabIds(get(), [tabId]).length > 0;
      for (let waited = 0; !ready(); waited += NEW_TERMINAL_POLL_MS) {
        const gone = !collectLiveTabs(get()).some((t) => t.id === tabId);
        // A shell that does not start says so in its own tab.
        if (gone || waited >= NEW_TERMINAL_LIMIT_MS) {
          toast.error("Nothing is recorded: the new terminal did not connect");
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, NEW_TERMINAL_POLL_MS));
      }
      // The user may have gone elsewhere meanwhile: what they type there is theirs.
      return getActiveTab(get())?.id === tabId && get().startRecording({ ...options, tabId });
    },

    toggleRecording: () => {
      if (get().recording) get().stopRecording();
      else get().startRecording();
    },

    followRecordedTerminal: () => {
      const { recording } = get();
      if (!recording) return;
      if (!collectLiveTabs(get()).some((t) => t.id === recording.tabId)) {
        get().stopRecording("tab-gone");
      } else if (sessionEndedForGood(recording.tabId)) {
        get().stopRecording("session-ended");
      }
    },

    setRecordingSaveOpen: (open) =>
      set(
        open ? { recordingSaveOpen: true } : { recordingSaveOpen: false, recordingStartHeld: false }
      ),

    saveRecordedTake: async (request) => {
      const take = get().recordedTake;
      const steps = take ? recordingSteps(take, request.keepSecrets) : [];
      try {
        if (steps.length === 0) throw new Error("There is nothing to save");
        let automation: Automation;
        if (request.to === "new") {
          automation = {
            id: newId("automation"),
            name: request.name,
            tags: request.tags,
            steps,
            triggers: [],
            // The backend stamps authoritative created/updated timestamps.
            createdAt: "",
            updatedAt: "",
          };
          if (request.description !== undefined) automation.description = request.description;
        } else {
          const existing = get().automations.find((a) => a.id === request.automationId);
          if (!existing) throw new Error("The automation no longer exists");
          automation = { ...existing, steps: [...existing.steps, ...steps] };
        }
        await get().saveAutomationToBackend(automation);
        if (take) done(take);
        return automation.id;
      } catch (err) {
        // The take and the dialog stay, so the user can retry.
        toast.error(`Failed to save the recording: ${errorMessage(err)}`);
        throw err;
      }
    },

    discardRecordedTake: () => {
      const take = get().recordedTake;
      if (!take) return;
      done(take);
      showUndoToast(`Discarded the recording in ${take.tabTitle}`, {
        testId: "recording-discarded",
        onUndo: () => present(take),
      });
    },

    takeForEditor: () => {
      const { recordedTake, queuedTakes } = get();
      const take = [recordedTake, ...queuedTakes].find((t) => t?.forEditor);
      if (!take) return null;
      done(take);
      return take;
    },
  };
};
