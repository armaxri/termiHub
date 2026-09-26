/**
 * Macro run history (#3543): build the metadata-only record of a finished macro
 * playback and hand it to the backend store, fire-and-forget. Recording never
 * blocks or fails a playback. The record carries only outcome, timing, targets
 * and origin — never the macro's recorded input.
 */
import { recordMacroRun as apiRecordMacroRun } from "@/services/macroApi";
import type { MacroPlaybackStatus } from "@/services/macroPlayback";
import { newId } from "@/services/transport/ids";
import type { Macro, MacroRun, MacroRunOrigin } from "@/types/macro";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import { collectLiveTabs, type AppState } from "../appStore";

/** The display label (tab title) of a terminal tab, for the run history. */
export function macroTargetLabel(state: AppState, tabId: string): string {
  return collectLiveTabs(state).find((t) => t.id === tabId)?.title || "Terminal";
}

/** Generate a fresh macro run-history record id. */
export function newMacroRunId(): string {
  return newId("mrun");
}

/** Everything needed to describe one finished playback. */
export interface MacroRunDescription {
  /** Record id; pre-generated when the caller needs to reference the record. */
  id?: string;
  macro: Pick<Macro, "id" | "name" | "steps">;
  startedAt: Date;
  endedAt: Date;
  status: MacroPlaybackStatus;
  stepsPlayed: number;
  /** Display labels (tab titles) of the terminals the playback started on. */
  targetLabels: string[];
  origin: MacroRunOrigin;
  error?: string;
}

/** Build the persisted record for a finished playback. */
export function buildMacroRun(desc: MacroRunDescription): MacroRun {
  const run: MacroRun = {
    id: desc.id ?? newMacroRunId(),
    macroId: desc.macro.id,
    macroName: desc.macro.name,
    startedAt: desc.startedAt.toISOString(),
    endedAt: desc.endedAt.toISOString(),
    status: desc.status,
    stepsPlayed: desc.stepsPlayed,
    totalSteps: desc.macro.steps.length,
    targetCount: desc.targetLabels.length,
    targetLabels: desc.targetLabels,
    origin: desc.origin,
  };
  if (desc.error) run.error = desc.error;
  return run;
}

/**
 * Persist `run` in the backend history and refresh the store's list. Never
 * throws and never awaits the backend: a failed write is only logged.
 */
export function recordMacroRun(set: (partial: Partial<AppState>) => void, run: MacroRun): void {
  try {
    void apiRecordMacroRun(run)
      .then((runs) => set({ macroRuns: Array.isArray(runs) ? runs : [] }))
      .catch((err) => {
        frontendLog("macro_playback", `Failed to record macro run: ${errorMessage(err)}`);
      });
  } catch (err) {
    // Guard even a synchronous throw (e.g. no Tauri bridge).
    frontendLog("macro_playback", `Failed to record macro run: ${errorMessage(err)}`);
  }
}
