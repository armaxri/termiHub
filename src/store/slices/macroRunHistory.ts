/**
 * Macro run history (#3543): build the metadata-only record of a finished macro
 * playback and hand it to the backend store, fire-and-forget. Recording never
 * blocks or fails a playback. The record carries only outcome, timing, targets
 * and origin — never the macro's recorded input.
 */
import type { MacroPlaybackStatus } from "@/services/macroPlayback";
import { newId } from "@/services/transport/ids";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { Macro } from "@/types/macro";

import type { AppState } from "../appStore";
import { collectLiveTabs } from "../layoutHelpers";
import { recordAutomationRun } from "./automationStoreState";

/** The display label (tab title) of a terminal tab, for the run history. */
export function macroTargetLabel(state: AppState, tabId: string): string {
  return collectLiveTabs(state).find((t) => t.id === tabId)?.title || "Terminal";
}

/** What can start a playback. */
export type PlaybackOrigin = Extract<AutomationRunOrigin, "manual" | "palette" | "scheduled">;

/** Everything needed to describe one finished playback. */
export interface MacroRunDescription {
  macro: Pick<Macro, "id" | "name" | "steps">;
  startedAt: Date;
  endedAt: Date;
  status: MacroPlaybackStatus;
  stepsPlayed: number;
  /** Display labels (tab titles) of the terminals the playback started on. */
  targetLabels: string[];
  origin: PlaybackOrigin;
  error?: string;
}

/** Build the persisted record for a finished playback. */
export function buildMacroRun(desc: MacroRunDescription): AutomationRun {
  const run: AutomationRun = {
    id: newId("mrun"),
    automationId: desc.macro.id,
    automationName: desc.macro.name,
    startedAt: desc.startedAt.toISOString(),
    endedAt: desc.endedAt.toISOString(),
    status: desc.status === "error" ? "failed" : desc.status,
    stepsCompleted: desc.stepsPlayed,
    total: desc.macro.steps.length,
    targetCount: desc.targetLabels.length,
    origin: desc.origin,
  };
  if (desc.targetLabels.length > 0) run.targetLabels = desc.targetLabels;
  if (desc.targetLabels.length === 1) run.targetLabel = desc.targetLabels[0];
  if (desc.error) run.error = desc.error;
  return run;
}

/**
 * Persist `run` in the automation run history (#5818, slice 4) and refresh the
 * store's lists. Never throws and never awaits the backend: a failed write is
 * only logged.
 */
export function recordMacroRun(
  set: (partial: Partial<AppState>) => void,
  run: AutomationRun
): void {
  recordAutomationRun(set, run, "macro_playback");
}
