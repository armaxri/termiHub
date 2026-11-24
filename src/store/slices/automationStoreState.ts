/**
 * State helpers of the single automation store (#5818, slice 4), kept apart
 * from the slice so the run paths can use them without an import cycle.
 */
import { recordAutomationRun as apiRecordAutomationRun } from "@/services/automationApi";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";
import { libraryViews, macroToAutomation, runViews, workflowToAutomation } from "./automationViews";

type SetState = (partial: Partial<AppState>) => void;

/**
 * The state update for a new automation list: the list plus its macro and
 * workflow views, which every legacy surface reads (#5818, slice 4).
 */
export function automationLibraryState(
  automations: Automation[]
): Pick<AppState, "automations" | "macros" | "workflows"> {
  return { automations, ...libraryViews(automations) };
}

/** The state update for a new run list: the list plus its two history views. */
export function automationRunsState(
  runs: unknown
): Pick<AppState, "automationRuns" | "macroRuns" | "workflowRuns"> {
  const list = Array.isArray(runs) ? (runs as AutomationRun[]) : [];
  return { automationRuns: list, ...runViews(list) };
}

/**
 * Persist a finished run in the backend history and refresh the store's
 * lists. Fire-and-forget: never throws and never awaits the backend, so a
 * history-write failure can never fail or block a run; it is only logged.
 */
export function recordAutomationRun(set: SetState, run: AutomationRun, logTarget: string): void {
  try {
    void apiRecordAutomationRun(run)
      .then((runs) => set(automationRunsState(runs)))
      .catch((err) => {
        frontendLog(logTarget, `Failed to record run: ${errorMessage(err)}`);
      });
  } catch (err) {
    // Guard even a synchronous throw (e.g. no Tauri bridge).
    frontendLog(logTarget, `Failed to record run: ${errorMessage(err)}`);
  }
}

/**
 * The automation a run of `id` executes: the stored automation, else the
 * automation the macro or workflow view of that id saves as (a view the
 * store has not caught up with yet). A **pure** lookup.
 */
export function automationForRun(state: AppState, id: string): Automation | undefined {
  const stored = state.automations.find((a) => a.id === id);
  if (stored) return stored;
  const macro = state.macros.find((m) => m.id === id);
  if (macro) return macroToAutomation(macro);
  const workflow = state.workflows.find((w) => w.id === id);
  return workflow ? workflowToAutomation(workflow) : undefined;
}
