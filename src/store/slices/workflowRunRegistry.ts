/**
 * The step-by-step runs in flight in this window, and the fan-outs they belong to
 * (#3418, #6042). Runs on different terminals go side by side; a new run stops only
 * those in its own terminals, and says so in their History.
 */
import type { AutomationFanoutHandle } from "@/services/automationRunner";

/** One run in flight: the terminal it types into, and how to stop it. */
export interface ActiveWorkflowRun {
  tabId: string;
  /** Stop it; `reason` is what its History says stopped it (#6042). */
  stop: (reason?: string) => void;
}

/** A run on several terminals, whose queued targets have no run yet (#5984). */
interface ActiveFanout {
  tabIds: readonly string[];
  handle: Pick<AutomationFanoutHandle, "cancel" | "cancelAll">;
}

const runs = new Map<string, ActiveWorkflowRun>();
const fanouts = new Set<ActiveFanout>();

/** Hold run `runId` as in flight until {@link forgetWorkflowRun}. */
export function holdWorkflowRun(runId: string, run: ActiveWorkflowRun): void {
  runs.set(runId, run);
}

/** The run ended. */
export function forgetWorkflowRun(runId: string): void {
  runs.delete(runId);
}

/**
 * Hold a fan-out on `tabIds`, so a new run in one of them also stops the target
 * still waiting there. Returns what forgets it.
 */
export function holdWorkflowFanout(
  tabIds: readonly string[],
  handle: ActiveFanout["handle"]
): () => void {
  const fanout = { tabIds, handle };
  fanouts.add(fanout);
  return () => fanouts.delete(fanout);
}

/** Stop every run in flight, and start no queued target ("Stop all"). Idempotent. */
export function cancelAllWorkflowRuns(): void {
  for (const fanout of fanouts) fanout.handle.cancelAll();
  for (const run of runs.values()) run.stop();
}

/**
 * Stop one run by id (#3418), saying `reason` in its History; a no-op when it is
 * not in flight. Returns whether it was found.
 */
export function cancelWorkflowRunById(runId: string, reason?: string): boolean {
  const run = runs.get(runId);
  run?.stop(reason);
  return run !== undefined;
}

/**
 * Stop the runs in the terminals `tabIds`, and the targets still waiting there,
 * saying `reason` in their History (#6042). Runs elsewhere go on.
 */
export function stopWorkflowRunsOn(tabIds: readonly string[], reason: string): void {
  const here = new Set(tabIds);
  for (const run of runs.values()) if (here.has(run.tabId)) run.stop(reason);
  for (const fanout of fanouts) {
    fanout.tabIds.forEach((tabId, index) => {
      if (here.has(tabId)) fanout.handle.cancel(index);
    });
  }
}

/** How many runs are in flight (tests, and triggers that never interrupt one). */
export function activeWorkflowRunCount(): number {
  return runs.size;
}
