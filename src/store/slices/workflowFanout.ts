/**
 * Multi-target ("run on many") helpers for manual workflow runs (PROD-047):
 * resolving which selected tabs are runnable, and summarising a fan-out's
 * per-target outcomes in one toast.
 */
import { toast } from "@/components/ui";
import type { WorkflowRunResult } from "@/services/workflowRunner";

import { collectLiveTabs, type AppState } from "../appStore";
import { currentSessionView, regionExited } from "../sessionBridge";

/** A connected terminal tab a workflow can run against. */
export interface RunnableTarget {
  /** The tab id. */
  id: string;
  /** The backend session id backing the tab. */
  sessionId: string;
  /** The tab's title, for the summary. */
  title: string;
}

/** The outcome of one target of a fan-out run. */
export interface FanoutOutcome {
  /** The target tab's title. */
  title: string;
  /** How that target's run ended. */
  result: WorkflowRunResult;
}

/**
 * Split `tabIds` into connected terminal targets (in the requested order) and
 * the number that were skipped because they are missing, not a terminal, have
 * no session, or have exited.
 */
export function resolveConnectedTargets(
  state: AppState,
  tabIds: string[]
): { targets: RunnableTarget[]; skipped: number } {
  const live = collectLiveTabs(state);
  const sessions = currentSessionView();
  const targets: RunnableTarget[] = [];
  for (const id of tabIds) {
    const tab = live.find((t) => t.id === id);
    if (
      !tab ||
      tab.contentType !== "terminal" ||
      !tab.sessionId ||
      // #2625: exited is region-only now the per-client slice is deleted.
      regionExited(sessions[id])
    ) {
      continue;
    }
    targets.push({ id, sessionId: tab.sessionId, title: tab.title });
  }
  return { targets, skipped: tabIds.length - targets.length };
}

/**
 * Show one toast summarising a fan-out run: success when every target
 * completed cleanly, an error naming the failed terminals when any failed, and
 * an info when the fan-out was cancelled or some steps/targets were tolerated or
 * skipped.
 */
export function toastFanoutSummary(
  workflowName: string,
  outcomes: FanoutOutcome[],
  targetCount: number,
  skipped: number,
  toastId: string
): void {
  const count = (status: WorkflowRunResult["status"]) =>
    outcomes.filter((o) => o.result.status === status).length;
  const completed = count("completed");
  const failed = outcomes.filter((o) => o.result.status === "failed");
  const cancelled = count("cancelled") > 0 || outcomes.length < targetCount;
  const tolerated = outcomes.some((o) => (o.result.continuedFailures?.length ?? 0) > 0);

  const parts = [`${completed} of ${targetCount} completed`];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (cancelled) parts.push(`${targetCount - outcomes.length + count("cancelled")} not finished`);
  if (skipped > 0) parts.push(`${skipped} skipped (not connected)`);
  if (tolerated) parts.push("some step failures were tolerated");
  const summary = parts.join(", ");

  if (failed.length > 0) {
    const detail = failed.map((o) => `${o.title}: ${o.result.error ?? "failed"}`).join("; ");
    toast.error(`Workflow "${workflowName}" failed on ${failed.length} terminal(s)`, {
      id: toastId,
      description: `${summary}. ${detail}`,
    });
  } else if (cancelled) {
    toast.info(`Workflow "${workflowName}" cancelled`, { id: toastId, description: summary });
  } else if (skipped > 0 || tolerated) {
    toast.info(`Ran workflow "${workflowName}" on ${completed} terminal(s)`, {
      id: toastId,
      description: summary,
    });
  } else {
    toast.success(`Ran workflow "${workflowName}" on ${completed} terminal(s)`, { id: toastId });
  }
}
