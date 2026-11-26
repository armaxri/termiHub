import { StateCreator } from "zustand";

import { tf } from "@/i18n/catalog";
import { toast } from "@/components/ui";
import {
  getTerminalInputInjector,
  type MacroInjector,
  type MacroPlaybackStatus,
} from "@/services/macroPlayback";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { Macro } from "@/types/macro";
import { frontendLog } from "@/utils/frontendLog";

import { currentSessionView, regionExited } from "../sessionBridge";

import type { AppState } from "../appStore";
import { failedRunActions } from "./automationRunActions";
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
import {
  buildMacroRun,
  macroTargetLabel,
  recordMacroRun,
  type PlaybackOrigin,
} from "./macroRunHistory";
import { notRunBecause, typedProgress } from "@/utils/runProgress";

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
  origin?: PlaybackOrigin;
  /**
   * Called with each run-history record the playback writes (one per terminal
   * it started on, #5818), before {@link AppState.playMacro} resolves, so a
   * caller (a scheduled run) can reference them.
   */
  onRecorded?: (run: AutomationRun) => void;
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

/** Why a playback was stopped, by handle: for all its terminals, or per terminal (#6042). */
const stopReasons = new WeakMap<object, { all?: string; tabs: Map<string, string> }>();

/** Note that `handle` is stopped because of `reason` (in `tabId`, or everywhere). */
function noteStop(handle: object, reason: string | undefined, tabId?: string): void {
  if (reason === undefined) return;
  const noted = stopReasons.get(handle) ?? { tabs: new Map<string, string>() };
  if (tabId === undefined) noted.all ??= reason;
  else if (!noted.tabs.has(tabId)) noted.tabs.set(tabId, reason);
  stopReasons.set(handle, noted);
}

/** What a stopped run's History says stopped it in `tabId`, if another run did. */
function stopReasonOf(handle: object, tabId: string): string | undefined {
  const noted = stopReasons.get(handle);
  return noted?.tabs.get(tabId) ?? noted?.all;
}

/** Why a run ended badly, for its History record. */
function endedBecause(
  status: MacroPlaybackStatus,
  handle: object,
  tabId: string
): string | undefined {
  if (status === "error") return "The terminal stopped accepting input";
  return status === "cancelled" ? stopReasonOf(handle, tabId) : undefined;
}

/** Stop the in-flight playback, if any, so a fresh one takes over; `reason` goes in its History. */
function stopActivePlayback(reason?: string): void {
  currentTargetsRun = null;
  if (!activePlayback) return;
  noteStop(activePlayback.handle, reason);
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
  cancelMacroPlaybackOnTab: (tabId: string, reason?: string) => void;
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
      toast.info(`Automation “${macro.name}” has no steps to run`);
      return null;
    }
    stopActivePlayback(tf("automation.stoppedBy", { name: macro.name }));

    const inject = createTargetInjector(
      getTerminalInputInjector(),
      (tabId) => filterConnectedTerminalTabIds(get(), [tabId]).length > 0
    );
    const firstTab = targets[0];
    const targetLabels = targets.map((id) => macroTargetLabel(get(), id));
    const startedAt = new Date();
    const toastId = `macro-playback-${macro.id}-multi`;
    const total = macro.steps.length;
    const title = `Running automation “${macro.name}” on ${targets.length} terminals…`;
    const progress: Record<string, number> = Object.fromEntries(targets.map((id) => [id, 0]));
    toast.loading(title, { id: toastId, description: typedProgress(0, total) });
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
            description: typedProgress(furthest, total),
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
    // its own outcome. One stopped before its turn says it never started, and why
    // (#6133).
    outcomes.forEach((outcome) => {
      const status = outcome.queued ? "cancelled" : (outcome.status ?? "cancelled");
      const now = new Date();
      const record = buildMacroRun({
        macro,
        startedAt: outcome.queued ? now : (outcome.startedAt ?? startedAt),
        endedAt: outcome.queued ? now : (outcome.endedAt ?? now),
        status,
        stepsPlayed: outcome.stepsPlayed,
        targetLabels: [targetLabels[targets.indexOf(outcome.tabId)]],
        origin: opts?.origin ?? "manual",
        error: outcome.queued
          ? notRunBecause(stopReasonOf(handle, outcome.tabId))
          : endedBecause(status, handle, outcome.tabId),
      });
      recordMacroRun(set, record);
      opts?.onRecorded?.(record);
    });
    return tally.status;
  };

  return {
    // Macros
    macros: [],

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
        toast.info(`Automation “${macro.name}” has no steps to run`);
        return null;
      }

      // Only one playback at a time — cancel any in-flight run first.
      stopActivePlayback(tf("automation.stoppedBy", { name: macro.name }));

      const injector = getTerminalInputInjector();
      const inject: MacroInjector = (data) => {
        if (!injector) return false;
        return injector(targetTabId, data);
      };

      const toastId = `macro-playback-${macroId}-${targetTabId}`;
      const total = macro.steps.length;
      const targetLabel = tab.title || "Terminal";
      const startedAt = new Date();
      toast.loading(`Running automation “${macro.name}”…`, {
        id: toastId,
        description: `${typedProgress(0, total)} in ${targetLabel}`,
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
          toast.loading(`Running automation “${macro.name}”…`, {
            id: toastId,
            description: `${typedProgress(played, stepTotal)} in ${targetLabel}`,
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
        toast.info(`“${macro.name}” stopped`, {
          id: toastId,
          description: `${typedProgress(result.stepsPlayed, total)} in ${targetLabel}`,
        });
      } else {
        toast.error(`“${macro.name}” failed: the terminal is no longer connected`, {
          id: toastId,
          description: `${typedProgress(result.stepsPlayed, total)} in ${targetLabel}`,
          ...failedRunActions(macroId),
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
        error: endedBecause(result.status, handle, targetTabId),
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

    cancelMacroPlaybackOnTab: (tabId, reason) => {
      if (!activePlayback) return;
      if (activePlayback.kind === "targets") {
        noteStop(activePlayback.handle, reason, tabId);
        activePlayback.handle.cancel(tabId);
      } else if (activePlayback.tabId === tabId) {
        noteStop(activePlayback.handle, reason, tabId);
        activePlayback.handle.cancel();
      }
    },
  };
};
