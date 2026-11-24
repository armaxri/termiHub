/**
 * The tab-strip "running automation" badge (#5818, slice 5; replaces the
 * multi-target "receiving macro" marker of #3446).
 *
 * Every terminal an automation is typing into carries one badge, whatever
 * started it: a macro played on one or several terminals, a workflow run by
 * hand, by a trigger or by a schedule. The badge names the automation and its
 * progress on that terminal and stops the run there. Macro playback state is
 * this window's own (`macroPlayback`); workflow runs come from the
 * authoritative `workflow-run` region.
 */
import type { MacroPlaybackState, WorkflowRunState } from "@/store/appStore";

/** How the badge's Stop reaches the run. */
export type RunningAutomationStop = { kind: "macro" } | { kind: "workflow"; runId: string };

/** What a tab's badge shows. */
export interface RunningAutomationInfo {
  /** The automation's name. */
  name: string;
  /** Steps done on this terminal. */
  completed: number;
  /** Steps in the automation. */
  total: number;
  /** How to stop it on this terminal. */
  stop: RunningAutomationStop;
}

/**
 * The badge for `tabId`, or `null` when no automation is typing into it. A
 * macro wins over a workflow on the same tab (only one can type at a time in
 * practice; a workflow run is skipped while a macro plays). A **pure** helper.
 */
export function runningAutomationOnTab(
  playback: MacroPlaybackState | null,
  workflowRuns: readonly WorkflowRunState[],
  tabId: string
): RunningAutomationInfo | null {
  if (playback) {
    const targets = playback.targetTabIds;
    const onTab = targets ? targets.includes(tabId) : playback.tabId === tabId;
    if (onTab) {
      return {
        name: playback.macroName,
        completed: playback.targetProgress?.[tabId] ?? playback.played,
        total: playback.total,
        stop: { kind: "macro" },
      };
    }
  }
  const run = workflowRuns.find((r) => r.tabId === tabId);
  if (!run) return null;
  return {
    name: run.workflowName,
    completed: run.completed,
    total: run.total,
    stop: { kind: "workflow", runId: run.runId },
  };
}

/** The badge's accessible name: `Running automation "Deploy" (2/5)`. */
export function runningAutomationLabel(info: RunningAutomationInfo): string {
  return `Running automation "${info.name}" (${info.completed}/${info.total})`;
}
