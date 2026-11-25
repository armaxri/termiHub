/**
 * Which automations run in this window, for the questions asked before one is
 * stopped (#6042). Step-by-step runs replace each other, and so do runs that type
 * keys; the two kinds run side by side.
 */
import { currentWorkflowRunView } from "../workflowRunBridge";
import type { AppState } from "../appStore";
import { macroTargetLabel } from "./macroRunHistory";

/** An automation that runs, and where. */
export interface RunningAutomation {
  name: string;
  where: string;
}

/** The runs a new one of this kind would stop. */
export function runsReplacedBy(state: AppState, typesKeys: boolean): RunningAutomation[] {
  if (typesKeys) {
    const { macroPlayback } = state;
    return (macroPlayback ? (macroPlayback.targetTabIds ?? [macroPlayback.tabId]) : []).map(
      (tabId) => ({
        name: macroPlayback?.macroName ?? "",
        where: macroTargetLabel(state, tabId),
      })
    );
  }
  return currentWorkflowRunView().runs.map((run) => ({
    name: run.workflowName,
    where: run.label || macroTargetLabel(state, run.tabId),
  }));
}
