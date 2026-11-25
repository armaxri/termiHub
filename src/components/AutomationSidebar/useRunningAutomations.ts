import { useMemo } from "react";
import { tf } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import { macroTargetLabel } from "@/store/slices/macroRunHistory";
import { useProjectedWorkflowRun } from "@/store/useProjectedWorkflowRun";
import { showTerminal } from "@/utils/showTerminal";
import type { AutomationRunTarget } from "./AutomationRow";

/**
 * The terminals every running automation runs on, by automation id (#5818,
 * slice 6): step runs come from the authoritative `workflow-run` region (a
 * "Run on…" fan-out has one run per terminal, #3418), keystroke playbacks from
 * the store. Each says where it is and which step it is at, whether it waits for
 * the user (#6026), and can be stopped on its own.
 */
export function useRunningAutomations(): Map<string, AutomationRunTarget[]> {
  const { workflowRuns } = useProjectedWorkflowRun();
  const playback = useAppStore((s) => s.macroPlayback);
  const waits = useAppStore((s) => s.automationWaits);
  const cancelWorkflowRun = useAppStore((s) => s.cancelWorkflowRun);
  const cancelMacroPlaybackOnTab = useAppStore((s) => s.cancelMacroPlaybackOnTab);

  return useMemo(() => {
    const byId = new Map<string, AutomationRunTarget[]>();
    const add = (automationId: string, target: AutomationRunTarget) => {
      const list = byId.get(automationId) ?? [];
      list.push(target);
      byId.set(automationId, list);
    };
    for (const run of workflowRuns) {
      const tab = run.label || macroTargetLabel(useAppStore.getState(), run.tabId);
      const waiting = waits.some((w) => w.runId === run.runId);
      const step = Math.min(run.completed + 1, run.total);
      add(run.workflowId, {
        key: run.runId,
        label: tab,
        waiting,
        progress: tf(waiting ? "automation.running.waiting" : "automation.running.step", {
          tab,
          step,
          total: run.total,
        }),
        onShow: () => showTerminal(run.tabId),
        onStop: () => cancelWorkflowRun(run.runId),
      });
    }
    if (playback) {
      for (const tabId of playback.targetTabIds ?? [playback.tabId]) {
        const tab = macroTargetLabel(useAppStore.getState(), tabId);
        const typed = playback.targetProgress?.[tabId] ?? playback.played;
        add(playback.macroId, {
          key: tabId,
          label: tab,
          waiting: false,
          // A share, not a count: the parts of a recording are keys and pastes (A-003).
          progress: tf("automation.running.typed", {
            tab,
            percent: playback.total > 0 ? Math.floor((typed / playback.total) * 100) : 0,
          }),
          onShow: () => showTerminal(tabId),
          onStop: () => cancelMacroPlaybackOnTab(tabId),
        });
      }
    }
    return byId;
  }, [workflowRuns, playback, waits, cancelWorkflowRun, cancelMacroPlaybackOnTab]);
}
