import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  listMacros as apiListMacros,
  saveMacro as apiSaveMacro,
  deleteMacro as apiDeleteMacro,
} from "@/services/macroApi";
import { parseMacroEnvelope, resolveImportCollisions } from "@/services/macroIo";
import {
  runMacroPlayback,
  getTerminalInputInjector,
  type MacroTimingMode,
  type MacroInjector,
  type MacroPlaybackHandle,
} from "@/services/macroPlayback";
import { Macro, MacroStep } from "@/types/macro";
import { frontendLog } from "@/utils/frontendLog";

import { currentSessionView, regionExited } from "../sessionBridge";

import { collectLiveTabs, getActiveTab, type AppState } from "../appStore";

/** UI-facing metadata describing an in-flight macro playback (#1675). */
export interface MacroPlaybackState {
  /** The macro being played. */
  macroId: string;
  /** The macro's name, for the progress indicator. */
  macroName: string;
  /** The terminal tab receiving the injected input. */
  tabId: string;
  /** The timing mode this run is using. */
  timingMode: MacroTimingMode;
  /** Total number of steps in the macro. */
  total: number;
  /** Steps injected so far. */
  played: number;
}

/** Options for {@link AppState.playMacro}. */
export interface PlayMacroOptions {
  /** Tab to inject into; defaults to the active terminal tab. */
  targetTabId?: string;
  /** Timing mode; defaults to `"real-time"`. */
  timingMode?: MacroTimingMode;
  /** Per-step delay (ms) for the `"fixed"` timing mode. */
  fixedDelayMs?: number;
}

/**
 * Handle for the currently-running macro playback, held at module scope so
 * {@link AppState.cancelMacroPlayback} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is playing.
 */
let activeMacroPlayback: MacroPlaybackHandle | null = null;

/** Generate a unique macro id, falling back when `crypto.randomUUID` is absent. */
function generateMacroId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `macro-${c.randomUUID()}`;
  }
  return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Macros domain slice (#2114): the stored-macro library plus the recording
 * (#1674) and playback (#1675) state and the actions that drive them. Extracted
 * verbatim from the monolithic root store as a behavior-preserving Zustand
 * slice — every action still receives the shared `set`/`get` typed against the
 * full {@link AppState}, so the public store shape and behavior are unchanged.
 * Mirrors the SSH tunnel slice (#2077).
 */
export interface MacrosSlice {
  // Macros
  macros: Macro[];
  loadMacros: () => Promise<void>;
  /** Save (add or update) a macro, then refresh the list. Returns the stored macro. */
  saveMacroToBackend: (macro: Macro) => Promise<Macro>;
  /** Delete a macro by ID; only mutates local state after the backend delete resolves. */
  deleteMacroFromBackend: (macroId: string) => Promise<void>;
  /**
   * Import macros from an exported-macro file's JSON, merging them into the
   * library. Malformed/incompatible files reject with a clear error and leave
   * the library untouched; imported macros get fresh ids and de-duplicated
   * names (see {@link resolveImportCollisions}). Returns the number imported.
   */
  importMacros: (json: string) => Promise<number>;

  // Macro recording (#1674)
  /** Whether terminal input is currently being captured into a macro. */
  macroRecording: boolean;
  /** The steps captured so far in the in-progress (or just-stopped) recording. */
  macroRecordingSteps: MacroStep[];
  /**
   * Timestamp (ms) of the last captured chunk, used to derive the next step's
   * `delayMs`. Internal to the recorder; `null` before the first chunk.
   */
  macroRecordingLastTime: number | null;
  /** Whether the post-recording "name & save" dialog is open. */
  macroSaveDialogOpen: boolean;
  /** Begin a fresh recording, discarding any prior buffer. */
  startMacroRecording: () => void;
  /**
   * Append one chunk of user input to the in-progress recording. No-op unless a
   * recording is active. `delayMs` is the elapsed time since the previous chunk
   * (0 for the first).
   */
  recordMacroInput: (data: string) => void;
  /**
   * Stop capturing. If anything was recorded, opens the save dialog; otherwise
   * discards the empty recording and notifies the user.
   */
  stopMacroRecording: () => void;
  /** Toggle recording: start if idle, stop (and prompt to save) if active. */
  toggleMacroRecording: () => void;
  /** Abort recording and discard the captured buffer without saving. */
  cancelMacroRecording: () => void;
  /** Persist the just-recorded steps as a named macro, then reset the recorder. */
  saveRecordedMacro: (meta: {
    name: string;
    description?: string;
    tags: string[];
  }) => Promise<void>;
  /** Close the save dialog and drop the captured buffer without persisting. */
  discardRecordedMacro: () => void;

  // Macro playback (#1675)
  /** Metadata for the in-flight playback, or `null` when nothing is playing. */
  macroPlayback: MacroPlaybackState | null;
  /**
   * Play a stored macro's recorded input into a target terminal, injecting each
   * step through the existing `send_input` seam and honouring the timing mode.
   * Defaults the target to the active terminal tab. Resolves when playback
   * finishes (completed, cancelled, or errored). Only one playback runs at a
   * time — a fresh call cancels any in-flight playback first. Surfaces a
   * recoverable toast when the macro is missing/empty or the target terminal is
   * not connected.
   */
  playMacro: (macroId: string, opts?: PlayMacroOptions) => Promise<void>;
  /** Cancel the in-flight macro playback, if any. Idempotent. */
  cancelMacroPlayback: () => void;
}

export const createMacrosSlice: StateCreator<AppState, [], [], MacrosSlice> = (set, get) => ({
  // Macros
  macros: [],

  loadMacros: async () => {
    try {
      const macros = await apiListMacros();
      set({ macros });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to load macros: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  saveMacroToBackend: async (macro) => {
    const saved = await apiSaveMacro(macro);
    await get().loadMacros();
    return saved;
  },

  deleteMacroFromBackend: async (macroId) => {
    // Only mutate local state after the backend delete resolves, and rethrow
    // on failure so the caller can surface the error (mirrors workspaces).
    await apiDeleteMacro(macroId);
    set((state) => ({
      macros: state.macros.filter((m) => m.id !== macroId),
    }));
  },

  importMacros: async (json) => {
    // Parse+validate first: a malformed file throws here, before any backend
    // write, so a bad import can never corrupt the existing library (#1677).
    const parsed = parseMacroEnvelope(json);
    const prepared = resolveImportCollisions(parsed, get().macros, generateMacroId);
    for (const macro of prepared) {
      await apiSaveMacro(macro);
    }
    // Refresh once, after all saves, rather than per-macro.
    await get().loadMacros();
    return prepared.length;
  },

  // Macro recording (#1674)
  macroRecording: false,
  macroRecordingSteps: [],
  macroRecordingLastTime: null,
  macroSaveDialogOpen: false,

  startMacroRecording: () => {
    set({
      macroRecording: true,
      macroRecordingSteps: [],
      macroRecordingLastTime: null,
      macroSaveDialogOpen: false,
    });
    toast.info("Recording macro — type in the terminal, then stop to save");
  },

  recordMacroInput: (data) => {
    const state = get();
    if (!state.macroRecording) return;
    const now = Date.now();
    const last = state.macroRecordingLastTime;
    const delayMs = last === null ? 0 : Math.max(0, now - last);
    set({
      macroRecordingSteps: [...state.macroRecordingSteps, { data, delayMs }],
      macroRecordingLastTime: now,
    });
  },

  stopMacroRecording: () => {
    const state = get();
    if (!state.macroRecording) return;
    if (state.macroRecordingSteps.length === 0) {
      // Nothing was typed — discard the empty recording rather than prompting.
      set({
        macroRecording: false,
        macroRecordingLastTime: null,
        macroSaveDialogOpen: false,
      });
      toast.info("No input was recorded");
      return;
    }
    set({
      macroRecording: false,
      macroRecordingLastTime: null,
      macroSaveDialogOpen: true,
    });
  },

  toggleMacroRecording: () => {
    if (get().macroRecording) {
      get().stopMacroRecording();
    } else {
      get().startMacroRecording();
    }
  },

  cancelMacroRecording: () => {
    set({
      macroRecording: false,
      macroRecordingSteps: [],
      macroRecordingLastTime: null,
      macroSaveDialogOpen: false,
    });
    toast.info("Recording discarded");
  },

  saveRecordedMacro: async ({ name, description, tags }) => {
    const steps = get().macroRecordingSteps;
    const macro: Macro = {
      id: generateMacroId(),
      name,
      description,
      tags,
      steps,
      // The backend stamps authoritative created/updated timestamps.
      createdAt: "",
      updatedAt: "",
    };
    try {
      await get().saveMacroToBackend(macro);
      set({
        macroRecordingSteps: [],
        macroRecordingLastTime: null,
        macroSaveDialogOpen: false,
      });
      toast.success(`Saved macro "${name}"`);
    } catch (err) {
      // Keep the dialog open so the user can retry without losing the capture.
      toast.error(`Failed to save macro: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },

  discardRecordedMacro: () => {
    set({
      macroRecordingSteps: [],
      macroRecordingLastTime: null,
      macroSaveDialogOpen: false,
    });
  },

  // Macro playback (#1675)
  macroPlayback: null,

  playMacro: async (macroId, opts) => {
    const state = get();
    const macro = state.macros.find((m) => m.id === macroId);
    if (!macro) {
      toast.error("Macro not found");
      return;
    }

    const targetTabId = opts?.targetTabId ?? getActiveTab(state)?.id ?? null;
    if (!targetTabId) {
      toast.error("No active terminal to play the macro into");
      return;
    }

    // Guard: only inject into a connected, non-exited terminal session.
    const tab = collectLiveTabs(state).find((t) => t.id === targetTabId);
    if (
      !tab ||
      tab.contentType !== "terminal" ||
      !tab.sessionId ||
      // #2621 mount-gate cut: region-derived exited (OR'd with the local slice).
      regionExited(currentSessionView()[targetTabId]) ||
      state.terminalExitedTabs[targetTabId]
    ) {
      toast.error("The target terminal is not connected");
      return;
    }

    if (macro.steps.length === 0) {
      toast.info(`Macro "${macro.name}" has no steps to play`);
      return;
    }

    // Only one playback at a time — cancel any in-flight run first.
    if (activeMacroPlayback) {
      activeMacroPlayback.cancel();
      activeMacroPlayback = null;
    }

    const timingMode = opts?.timingMode ?? "real-time";
    const injector = getTerminalInputInjector();
    const inject: MacroInjector = (data) => {
      if (!injector) return false;
      return injector(targetTabId, data);
    };

    const toastId = `macro-playback-${macroId}-${targetTabId}`;
    const total = macro.steps.length;
    toast.loading(`Playing macro "${macro.name}"…`, {
      id: toastId,
      description: `0 / ${total} steps`,
    });
    set({
      macroPlayback: {
        macroId,
        macroName: macro.name,
        tabId: targetTabId,
        timingMode,
        total,
        played: 0,
      },
    });

    const handle = runMacroPlayback(
      macro.steps,
      inject,
      { timingMode, fixedDelayMs: opts?.fixedDelayMs },
      {
        onProgress: (played, stepTotal) => {
          set((s) =>
            s.macroPlayback &&
            s.macroPlayback.macroId === macroId &&
            s.macroPlayback.tabId === targetTabId
              ? { macroPlayback: { ...s.macroPlayback, played } }
              : {}
          );
          toast.loading(`Playing macro "${macro.name}"…`, {
            id: toastId,
            description: `${played} / ${stepTotal} steps`,
          });
        },
      }
    );
    activeMacroPlayback = handle;

    const result = await handle.done;

    // Only clear shared state when this run is still the current one — a newer
    // playMacro may have replaced it while this one was cancelled.
    if (activeMacroPlayback === handle) {
      activeMacroPlayback = null;
      set({ macroPlayback: null });
    }

    if (result.status === "completed") {
      toast.success(`Played macro "${macro.name}"`, { id: toastId });
    } else if (result.status === "cancelled") {
      toast.info(`Playback of "${macro.name}" cancelled`, {
        id: toastId,
        description: `Stopped after ${result.stepsPlayed} of ${total} steps`,
      });
    } else {
      toast.error(`Could not play "${macro.name}" — the terminal is no longer connected`, {
        id: toastId,
      });
    }
  },

  cancelMacroPlayback: () => {
    if (activeMacroPlayback) {
      activeMacroPlayback.cancel();
    }
  },
});
