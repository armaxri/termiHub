import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  getTerminalInputInjector,
  type MacroInjector,
  type MacroPlaybackStatus,
} from "@/services/macroPlayback";
import { Macro, MacroRun, MacroRunOrigin } from "@/types/macro";
import { frontendLog } from "@/utils/frontendLog";

import { currentSessionView, regionExited } from "../sessionBridge";

import type { AppState } from "../appStore";
import { collectLiveTabs, getActiveTab } from "../layoutHelpers";
import { filterConnectedTerminalTabIds } from "../tabQueries";
import { automationToMacro, isMacroShaped } from "./automationViews";
import { createTargetInjector, describeMacroFanoutOutcome, tallyMacroTargets } from "./macroFanout";
import {
  playAutomationKeys,
  playAutomationKeysOnTargets,
  type MacroKeysPlayback,
  type MacroTargetsPlayback,
} from "./macroKeysPlayback";
import { buildMacroRun, macroTargetLabel, recordMacroRun } from "./macroRunHistory";

/** UI-facing metadata describing an in-flight macro playback (#1675). */
export interface MacroPlaybackState {
  /** The macro being played. */
  macroId: string;
  /** The macro's name, for the progress indicator. */
  macroName: string;
  /** The terminal tab receiving the injected input. */
  tabId: string;
  /** Total number of steps in the macro. */
  total: number;
  /** Steps injected so far. */
  played: number;
  /**
   * Every terminal receiving the macro when it plays into several at once
   * (PROD-042, #3443); `undefined` for a single-terminal run. `tabId` is the
   * first of these. Narrowed as the run progresses to the targets still
   * receiving input, so a dropped target's tab-strip marker clears (#3446).
   */
  targetTabIds?: string[];
  /**
   * Chunks typed into each target of a multi-terminal playback, by tab id
   * (#5818, slice 5): each target runs on its own, so each has its own count.
   */
  targetProgress?: Record<string, number>;
}

/** Options for {@link AppState.playMacro}. */
export interface PlayMacroOptions {
  /** Tab to inject into; defaults to the active terminal tab. */
  targetTabId?: string;
  /**
   * Play into several terminals at once (PROD-042, #3443). With more than one
   * id, each connected target runs the macro on its own (#5818, slice 5), at
   * most 8 at once; targets that are not connected are skipped and reported in
   * the summary. Takes precedence over {@link targetTabId}.
   */
  targetTabIds?: string[];
  /**
   * Run the targets of a multi-terminal playback at the same time (the
   * default) or, when `false`, one after another.
   */
  parallel?: boolean;
  /** What launched the playback, for the run history (#3543); defaults to `"manual"`. */
  origin?: MacroRunOrigin;
  /**
   * Called with each run-history record the playback writes (one per terminal
   * it started on, #5818), before {@link AppState.playMacro} resolves, so a
   * caller (a scheduled run) can reference them.
   */
  onRecorded?: (run: MacroRun) => void;
}

/**
 * Handle for the currently-running macro playback, held at module scope so
 * {@link AppState.cancelMacroPlayback} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is playing.
 * A single-terminal playback holds one handle; a multi-terminal one holds the
 * per-target handle, which can stop one target or all of them.
 */
let activePlayback:
  | { kind: "single"; tabId: string; handle: MacroKeysPlayback }
  | { kind: "targets"; handle: MacroTargetsPlayback }
  | null = null;

/** Identity of the multi-terminal run that owns the shared playback state. */
let currentTargetsRun: object | null = null;

/** Stop the in-flight playback, if any, so a fresh one takes over. */
function stopActivePlayback(): void {
  currentTargetsRun = null;
  if (!activePlayback) return;
  if (activePlayback.kind === "single") activePlayback.handle.cancel();
  else activePlayback.handle.cancelAll();
  activePlayback = null;
}

/**
 * Macros domain slice (#2114): the stored-macro library plus the
 * playback (#1675) state and the actions that drive them. Extracted
 * verbatim from the monolithic root store as a behavior-preserving Zustand
 * slice — every action still receives the shared `set`/`get` typed against the
 * full {@link AppState}, so the public store shape and behavior are unchanged.
 * Mirrors the SSH tunnel slice (#2077).
 */
export interface MacrosSlice {
  // Macros
  macros: Macro[];
  loadMacros: () => Promise<void>;
  /** Delete a macro by ID; only mutates local state after the backend delete resolves. */
  deleteMacroFromBackend: (macroId: string) => Promise<void>;

  // Macro run history (#3543)
  /** Recorded playbacks, newest first. Metadata only — never the macro's input. */
  macroRuns: MacroRun[];
  /** Load the recorded playbacks from the backend. Logs (never throws) on failure. */
  loadMacroRuns: () => Promise<void>;
  /** Clear the whole macro run history. Rejects when the backend clear fails. */
  clearMacroRunHistory: () => Promise<void>;

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
   * not connected. Resolves with the playback's final status, or `null` when
   * playback never started (a scheduled run reports it, PROD-043).
   */
  playMacro: (macroId: string, opts?: PlayMacroOptions) => Promise<MacroPlaybackStatus | null>;
  /** Cancel the in-flight macro playback, if any. Idempotent. */
  cancelMacroPlayback: () => void;
  /**
   * Stop the playback on one terminal only (#5818, slice 5: the tab badge's
   * Stop). On a multi-terminal playback the other terminals keep typing. A
   * no-op when nothing plays on `tabId`.
   */
  cancelMacroPlaybackOnTab: (tabId: string) => void;
}

export const createMacrosSlice: StateCreator<AppState, [], [], MacrosSlice> = (set, get) => {
  /** A macro the local library does not hold yet (made in another window). */
  const fetchMacro = async (macroId: string): Promise<Macro | undefined> => {
    const automation = await get().fetchAutomationForRun(macroId);
    return automation && isMacroShaped(automation) ? automationToMacro(automation) : undefined;
  };

  /**
   * Multi-target playback (PROD-042, #3443; #5818 slice 5): play `macro` on
   * every connected terminal in `requested` as independent per-target runs,
   * at most 8 at once (or one after another when `parallel` is false).
   * Uses the broadcast fan-out's connected-terminal filter before every chunk,
   * so a disconnected or taken-over tab is never typed into; the summary
   * reports skipped and dropped targets rather than implying the whole fleet
   * got the macro.
   */
  const playMacroOnTargets = async (
    macro: Macro,
    requested: string[],
    opts: PlayMacroOptions | undefined
  ): Promise<MacroPlaybackStatus | null> => {
    const targets = filterConnectedTerminalTabIds(get(), requested);
    const skipped = requested.length - targets.length;
    if (targets.length === 0) {
      toast.error("None of the selected terminals are connected");
      return null;
    }
    if (macro.steps.length === 0) {
      // toast-policy: explains-outcome — nothing plays, and this says why
      toast.info(`Automation "${macro.name}" has no steps to run`);
      return null;
    }
    stopActivePlayback();

    const inject = createTargetInjector(
      getTerminalInputInjector(),
      (tabId) => filterConnectedTerminalTabIds(get(), [tabId]).length > 0
    );
    const firstTab = targets[0];
    const targetLabels = targets.map((id) => macroTargetLabel(get(), id));
    const startedAt = new Date();
    const toastId = `macro-playback-${macro.id}-multi`;
    const total = macro.steps.length;
    const title = `Running automation "${macro.name}" on ${targets.length} terminals…`;
    const progress: Record<string, number> = Object.fromEntries(targets.map((id) => [id, 0]));
    toast.loading(title, { id: toastId, description: `0 / ${total} steps` });
    set({
      macroPlayback: {
        macroId: macro.id,
        macroName: macro.name,
        tabId: firstTab,
        total,
        played: 0,
        targetTabIds: targets,
        targetProgress: progress,
      },
    });
    frontendLog("macro_playback", `fan-out macro=${macro.id} targets=${targets.length}`);

    // Only the current run may change the shared playback state and its toast:
    // a superseded run of the same macro on the same tabs still reports its
    // targets ending, and must not clear the new run's badges.
    const run = {};
    currentTargetsRun = run;
    const isCurrent = () => currentTargetsRun === run;
    const handle = playAutomationKeysOnTargets(
      get(),
      macro,
      targets,
      inject,
      { parallel: opts?.parallel },
      {
        onProgress: (tabId, played) => {
          if (!isCurrent()) return;
          progress[tabId] = played;
          const furthest = Math.max(...Object.values(progress));
          set((s) =>
            isCurrent() && s.macroPlayback
              ? {
                  macroPlayback: {
                    ...s.macroPlayback,
                    played: furthest,
                    targetProgress: { ...progress },
                  },
                }
              : {}
          );
          toast.loading(title, {
            id: toastId,
            description: `${furthest} / ${total} steps`,
          });
        },
        // A target whose run ended (finished, stopped or dropped) loses its
        // tab-strip "running automation" badge at once (#3446).
        onTargetEnd: (tabId) => {
          set((s) =>
            isCurrent() && s.macroPlayback
              ? {
                  macroPlayback: {
                    ...s.macroPlayback,
                    targetTabIds: (s.macroPlayback.targetTabIds ?? []).filter((id) => id !== tabId),
                  },
                }
              : {}
          );
        },
      }
    );
    activePlayback = { kind: "targets", handle };
    const outcomes = await handle.done;
    if (activePlayback?.kind === "targets" && activePlayback.handle === handle) {
      activePlayback = null;
      currentTargetsRun = null;
      set({ macroPlayback: null });
    }

    const tally = tallyMacroTargets(outcomes);
    const summary = describeMacroFanoutOutcome(macro.name, {
      status: tally.status,
      requested: requested.length,
      delivered: tally.delivered,
      dropped: tally.dropped,
      skipped,
      stepsPlayed: tally.stepsPlayed,
      totalSteps: total,
    });
    if (summary.kind === "success") {
      // toast-policy: background — the run spans several terminals, most of them off-screen
      toast.success(summary.message, { id: toastId, description: summary.description });
    } else if (summary.kind === "info") {
      // toast-policy: explains-outcome — says how far the canceled playback got
      toast.info(summary.message, { id: toastId, description: summary.description });
    } else {
      toast.error(summary.message, { id: toastId, description: summary.description });
    }
    // One history record per terminal (#5818): each target was its own run, with
    // its own outcome. A target that never started has no run to record.
    outcomes
      .filter((outcome) => outcome.status !== undefined)
      .forEach((outcome) => {
        const status = outcome.status ?? "cancelled";
        const record = buildMacroRun({
          macro,
          startedAt: outcome.startedAt ?? startedAt,
          endedAt: outcome.endedAt ?? new Date(),
          status,
          stepsPlayed: outcome.stepsPlayed,
          targetLabels: [targetLabels[targets.indexOf(outcome.tabId)]],
          origin: opts?.origin ?? "manual",
          error: status === "error" ? "The terminal stopped accepting input" : undefined,
        });
        recordMacroRun(set, record);
        opts?.onRecorded?.(record);
      });
    return tally.status;
  };

  return {
    // Macros
    macros: [],

    // The library lives in the automation store (#5818, slice 4); these are
    // thin adapters that read and write it through the macro view.
    loadMacros: () => get().loadAutomations(),

    deleteMacroFromBackend: async (macroId) => {
      // Only mutate local state after the backend delete resolves, and rethrow
      // on failure so the caller can surface the error (mirrors workspaces).
      await get().deleteAutomationFromBackend(macroId);
    },

    // Macro run history (#3543)
    macroRuns: [],

    loadMacroRuns: () => get().loadAutomationRuns(),

    // Clears only the runs this history shows; workflow runs stay.
    clearMacroRunHistory: () => get().clearAutomationRuns(get().macroRuns.map((r) => r.id)),

    // Macro playback (#1675)
    macroPlayback: null,

    playMacro: async (macroId, opts) => {
      const macro = get().macros.find((m) => m.id === macroId) ?? (await fetchMacro(macroId));
      if (!macro) {
        toast.error("Automation not found");
        return null;
      }
      const state = get();

      const requested = opts?.targetTabIds?.length ? [...new Set(opts.targetTabIds)] : null;
      if (requested && requested.length > 1) {
        return await playMacroOnTargets(macro, requested, opts);
      }

      const targetTabId = requested?.[0] ?? opts?.targetTabId ?? getActiveTab(state)?.id ?? null;
      if (!targetTabId) {
        toast.error("No active terminal to run the automation on");
        return null;
      }

      // Guard: only inject into a connected, non-exited terminal session.
      const tab = collectLiveTabs(state).find((t) => t.id === targetTabId);
      if (
        !tab ||
        tab.contentType !== "terminal" ||
        !tab.sessionId ||
        // #2625: exited is region-only now the per-client `terminalExitedTabs` slice
        // is deleted.
        regionExited(currentSessionView()[targetTabId])
      ) {
        toast.error("The target terminal is not connected");
        return null;
      }

      if (macro.steps.length === 0) {
        // toast-policy: explains-outcome — nothing plays, and this says why
        toast.info(`Automation "${macro.name}" has no steps to run`);
        return null;
      }

      // Only one playback at a time — cancel any in-flight run first.
      stopActivePlayback();

      const injector = getTerminalInputInjector();
      const inject: MacroInjector = (data) => {
        if (!injector) return false;
        return injector(targetTabId, data);
      };

      const toastId = `macro-playback-${macroId}-${targetTabId}`;
      const total = macro.steps.length;
      const targetLabel = tab.title || "Terminal";
      const startedAt = new Date();
      toast.loading(`Running automation "${macro.name}"…`, {
        id: toastId,
        description: `0 / ${total} steps`,
      });
      set({
        macroPlayback: {
          macroId,
          macroName: macro.name,
          tabId: targetTabId,
          total,
          played: 0,
        },
      });

      const handle = playAutomationKeys(get(), macro, inject, {
        onProgress: (played, stepTotal) => {
          set((s) =>
            s.macroPlayback &&
            s.macroPlayback.macroId === macroId &&
            s.macroPlayback.tabId === targetTabId
              ? { macroPlayback: { ...s.macroPlayback, played } }
              : {}
          );
          toast.loading(`Running automation "${macro.name}"…`, {
            id: toastId,
            description: `${played} / ${stepTotal} steps`,
          });
        },
      });
      activePlayback = { kind: "single", tabId: targetTabId, handle };

      const result = await handle.done;

      // Only clear shared state when this run is still the current one — a newer
      // playMacro may have replaced it while this one was cancelled.
      if (activePlayback?.kind === "single" && activePlayback.handle === handle) {
        activePlayback = null;
        set({ macroPlayback: null });
      }

      if (result.status === "completed") {
        toast.dismiss(toastId);
      } else if (result.status === "cancelled") {
        // toast-policy: explains-outcome — says how far the canceled playback got
        toast.info(`Automation "${macro.name}" canceled`, {
          id: toastId,
          description: `Stopped after ${result.stepsPlayed} of ${total} steps`,
        });
      } else {
        toast.error(`Automation "${macro.name}" stopped: the terminal is no longer connected`, {
          id: toastId,
        });
      }
      const record = buildMacroRun({
        macro,
        startedAt,
        endedAt: new Date(),
        status: result.status,
        stepsPlayed: result.stepsPlayed,
        targetLabels: [targetLabel],
        origin: opts?.origin ?? "manual",
        error: result.status === "error" ? "The terminal stopped accepting input" : undefined,
      });
      recordMacroRun(set, record);
      opts?.onRecorded?.(record);
      return result.status;
    },

    cancelMacroPlayback: () => {
      if (!activePlayback) return;
      if (activePlayback.kind === "single") activePlayback.handle.cancel();
      else activePlayback.handle.cancelAll();
    },

    cancelMacroPlaybackOnTab: (tabId) => {
      if (!activePlayback) return;
      if (activePlayback.kind === "targets") activePlayback.handle.cancel(tabId);
      else if (activePlayback.tabId === tabId) activePlayback.handle.cancel();
    },
  };
};
