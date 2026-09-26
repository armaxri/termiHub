/**
 * Multi-target ("run on many") helpers for manual workflow runs (PROD-047,
 * #3418): resolving which selected tabs are runnable, running the targets
 * concurrently under a bounded pool, rendering one per-target status toast while
 * they run, and summarising the per-target outcomes in one toast.
 */
import { toast } from "@/components/ui";
import type { WorkflowRunResult } from "@/services/workflowRunner";

import { collectLiveTabs, type AppState } from "../appStore";
import { currentSessionView, regionExited } from "../sessionBridge";

/**
 * Maximum number of terminals a fan-out runs a workflow on at the same time
 * (#3418). Further targets queue and start as earlier ones finish, so a large
 * broadcast group cannot flood the backend with simultaneous sessions' work.
 */
export const WORKFLOW_FANOUT_CONCURRENCY = 8;

/** Clamp a requested fan-out concurrency to `1..WORKFLOW_FANOUT_CONCURRENCY`
 * (`undefined` → the cap; `1` runs the targets one after another). */
export function clampFanoutConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return WORKFLOW_FANOUT_CONCURRENCY;
  return Math.min(WORKFLOW_FANOUT_CONCURRENCY, Math.max(1, Math.floor(requested)));
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once, starting
 * the next item as soon as a slot frees. Items are started in order; once
 * `shouldStop()` returns true no further item starts (in-flight ones finish).
 * Resolves with each item's result by index — `undefined` for an item that
 * never started. A worker rejection is the worker's to handle: the pool keeps
 * going and records `undefined` for that item.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = undefined;
      }
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

/** Live status of one fan-out target, for the per-target progress toast. */
export type FanoutTargetStatus = "queued" | "running" | WorkflowRunResult["status"];

/** Render the compact per-target status line of a running fan-out toast, e.g.
 * `2 running · 3 queued · 4 done · 1 failed`. Zero counts are omitted. */
export function describeFanoutProgress(statuses: readonly FanoutTargetStatus[]): string {
  const count = (s: FanoutTargetStatus) => statuses.filter((x) => x === s).length;
  const parts: string[] = [];
  const push = (n: number, label: string) => {
    if (n > 0) parts.push(`${n} ${label}`);
  };
  push(count("running"), "running");
  push(count("queued"), "queued");
  push(count("completed"), "done");
  push(count("failed"), "failed");
  push(count("cancelled"), "cancelled");
  return parts.join(" · ");
}

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
