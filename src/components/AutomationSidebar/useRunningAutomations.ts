import { useMemo } from "react";
import { useAppStore } from "@/store/appStore";
import { macroTargetLabel } from "@/store/slices/macroRunHistory";
import { useProjectedWorkflowRun } from "@/store/useProjectedWorkflowRun";
import type { AutomationRunTarget } from "./AutomationRow";

/**
 * The terminals every running automation runs on, by automation id (#5818,
 * slice 6): step runs come from the authoritative `workflow-run` region (a
 * "Run on…" fan-out has one run per terminal, #3418), keystroke playbacks from
 * the store. Each target can be stopped on its own.
 */
export function useRunningAutomations(): Map<string, AutomationRunTarget[]> {
  const { workflowRuns } = useProjectedWorkflowRun();
  const playback = useAppStore((s) => s.macroPlayback);
  const cancelWorkflowRun = useAppStore((s) => s.cancelWorkflowRun);
  const cancelMacroPlaybackOnTab = useAppStore((s) => s.cancelMacroPlaybackOnTab);

  return useMemo(() => {
    const byId = new Map<string, AutomationRunTarget[]>();
    for (const run of workflowRuns) {
      const list = byId.get(run.workflowId) ?? [];
      list.push({
        key: run.runId,
        label: run.label || run.tabId,
        completed: run.completed,
        total: run.total,
        onStop: () => cancelWorkflowRun(run.runId),
      });
      byId.set(run.workflowId, list);
    }
    if (playback) {
      const list = byId.get(playback.macroId) ?? [];
      for (const tabId of playback.targetTabIds ?? [playback.tabId]) {
        list.push({
          key: tabId,
          label: macroTargetLabel(useAppStore.getState(), tabId),
          completed: playback.targetProgress?.[tabId] ?? playback.played,
          total: playback.total,
          onStop: () => cancelMacroPlaybackOnTab(tabId),
        });
      }
      byId.set(playback.macroId, list);
    }
    return byId;
  }, [workflowRuns, playback, cancelWorkflowRun, cancelMacroPlaybackOnTab]);
}
