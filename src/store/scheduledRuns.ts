/**
 * Frontend half of scheduled runs (PROD-043): execute a `schedule-fire` in
 * this window and report the outcome back to the backend scheduler.
 *
 * The backend decides *when* a schedule runs; this window decides *where*,
 * because it owns its tabs. A scheduled run is **unattended**, so it is
 * deliberately conservative:
 *
 * - it only types into terminals that are already **open and connected** and
 *   were opened from one of the schedule's saved connections (or broadcast
 *   group members) — never the active tab, never a fuzzy match;
 * - it never connects, and never prompts: a workflow parameter without a usable
 *   default, or a local program that is not already allowlisted, makes the run
 *   skip / fail instead of asking;
 * - it never supersedes something the user started: if a workflow run (or a
 *   macro playback) is already in flight in this window, the run is skipped.
 *
 * Every outcome — including "nothing to do here" — is reported, so the backend
 * can settle the run and record the reason.
 */
import { toast } from "@/components/ui";
import type { WorkflowParamValues } from "@/services/workflowRunner";
import type { ScheduleFire, ScheduleTargets, WindowRunReport } from "@/types/schedule";
import type { BroadcastGroup } from "@/types/terminal";
import type { Workflow, WorkflowParameter } from "@/types/workflow";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import { collectLiveTabs, filterConnectedTerminalTabIds, type AppState } from "./appStore";
import { currentBroadcastGroups } from "./broadcastGroups";
import {
  resolveConnectedTargets,
  runWithConcurrency,
  toastFanoutSummary,
  WORKFLOW_FANOUT_CONCURRENCY,
  type FanoutOutcome,
} from "./slices/workflowFanout";
import { activeWorkflowRunCount, runWorkflowOnTarget } from "./slices/workflowRunOnTarget";

/** The store access a scheduled run needs. */
export interface ScheduledRunStore {
  getState: () => AppState;
  setState: (partial: Partial<AppState>) => void;
}

/**
 * Scheduled runs executing in this window. Claimed synchronously before any
 * await, so two schedules firing together can never both type into a host.
 */
let scheduledInFlight = 0;

/** Whether the user (or another schedule) is already driving a run here. */
function busyReason(state: AppState): string | null {
  if (scheduledInFlight > 0) return "Skipped: another scheduled run was in progress";
  if (activeWorkflowRunCount() > 0 || state.workflowParamPrompt || state.localProcessPrompt) {
    return "Skipped: another workflow run was in progress";
  }
  if (state.macroPlayback) return "Skipped: a macro was playing";
  return null;
}

/** A report for a run that did nothing in this window. */
function skip(message: string): WindowRunReport {
  return { outcome: "skipped", message, targetsRun: 0 };
}

/**
 * The saved-connection ids a schedule targets, or `null` when its broadcast
 * group no longer exists.
 */
function resolveTargetConnectionIds(
  targets: ScheduleTargets,
  groups: readonly BroadcastGroup[]
): string[] | null {
  if (targets.kind === "connections") return targets.connectionIds;
  const group = groups.find((g) => g.id === targets.groupId);
  return group ? group.connectionIds : null;
}

/**
 * The open terminal tabs of this window opened from one of `connectionIds`,
 * in tab order. Tabs without a saved connection are never targets.
 */
function targetTabIds(state: AppState, connectionIds: readonly string[]): string[] {
  const members = new Set(connectionIds);
  return collectLiveTabs(state)
    .filter((t) => t.contentType === "terminal" && !!t.connectionId && members.has(t.connectionId))
    .map((t) => t.id);
}

/**
 * Parameter values for an unattended run: each parameter's default, else a
 * type-appropriate empty value. Returns the name of a required parameter that
 * has no usable default (the run must then not start — it cannot prompt).
 */
function unattendedParamValues(
  parameters: readonly WorkflowParameter[]
): { values: WorkflowParamValues } | { missing: string } {
  const values: WorkflowParamValues = {};
  for (const param of parameters) {
    const value = param.default;
    const hasDefault = value !== undefined && !(typeof value === "string" && value.trim() === "");
    if (!hasDefault && param.required && param.type !== "boolean") {
      return { missing: param.label ?? param.name };
    }
    if (value !== undefined) {
      values[param.name] = value;
    } else if (param.type === "boolean") {
      values[param.name] = false;
    } else if (param.type === "enum") {
      values[param.name] = param.options?.[0] ?? "";
    } else {
      values[param.name] = "";
    }
  }
  return { values };
}

/** Run a workflow on this window's connected targets, unattended. */
async function runScheduledWorkflow(
  fire: ScheduleFire,
  workflow: Workflow,
  tabIds: string[],
  store: ScheduledRunStore
): Promise<WindowRunReport> {
  if (workflow.steps.length === 0) return skip(`Workflow "${workflow.name}" has no steps`);
  const { targets } = resolveConnectedTargets(store.getState(), tabIds);
  if (targets.length === 0) return skip("None of the target connections is connected");
  const params = unattendedParamValues(workflow.parameters ?? []);
  if ("missing" in params) {
    return skip(`Parameter "${params.missing}" needs a default value to run unattended`);
  }

  const toastId = `schedule-run-${fire.token}`;
  toast.loading(`Scheduled run "${fire.scheduleName}"`, {
    id: toastId,
    description: `Running workflow "${workflow.name}" on ${targets.length} terminal${
      targets.length === 1 ? "" : "s"
    }…`,
  });
  const results = await runWithConcurrency(targets, WORKFLOW_FANOUT_CONCURRENCY, (target) =>
    runWorkflowOnTarget({
      set: store.setState,
      get: store.getState,
      workflow,
      targetTabId: target.id,
      targetSessionId: target.sessionId,
      targetLabel: target.title,
      paramValues: params.values,
      triggeredBy: "scheduled",
      fanout: {},
      unattended: true,
    })
  );
  const outcomes: FanoutOutcome[] = [];
  results.forEach((result, index) => {
    if (result) outcomes.push({ title: targets[index].title, result });
  });
  toastFanoutSummary(workflow.name, outcomes, targets.length, 0, toastId);

  const failed = outcomes.find((o) => o.result.status === "failed");
  if (failed) {
    return {
      outcome: "failed",
      message: `${failed.title}: ${failed.result.error ?? "a step failed"}`,
      targetsRun: outcomes.length,
    };
  }
  if (outcomes.length < targets.length || outcomes.some((o) => o.result.status === "cancelled")) {
    return { outcome: "cancelled", targetsRun: outcomes.length };
  }
  return { outcome: "completed", targetsRun: outcomes.length };
}

/** Play a macro into this window's connected targets. */
async function runScheduledMacro(
  macroId: string,
  tabIds: string[],
  store: ScheduledRunStore
): Promise<WindowRunReport> {
  const state = store.getState();
  const macro = state.macros.find((m) => m.id === macroId);
  if (!macro) return skip("The macro no longer exists");
  const targets = filterConnectedTerminalTabIds(state, tabIds);
  if (targets.length === 0) return skip("None of the target connections is connected");
  const status = await state.playMacro(macroId, { targetTabIds: targets });
  switch (status) {
    case "completed":
      return { outcome: "completed", targetsRun: targets.length };
    case "cancelled":
      return { outcome: "cancelled", targetsRun: targets.length };
    case "error":
      return {
        outcome: "failed",
        message: "A target terminal disconnected during playback",
        targetsRun: targets.length,
      };
    default:
      return skip("The macro could not be played");
  }
}

/**
 * Execute a fired schedule in this window and return the report (without
 * sending it). Never throws: an unexpected error becomes a `failed` report.
 */
export async function executeScheduledRun(
  fire: ScheduleFire,
  store: ScheduledRunStore
): Promise<WindowRunReport> {
  const busy = busyReason(store.getState());
  if (busy) return skip(busy);
  scheduledInFlight += 1;
  try {
    const connectionIds = resolveTargetConnectionIds(fire.targets, currentBroadcastGroups());
    if (connectionIds === null) return skip("The broadcast group no longer exists");
    const tabIds = targetTabIds(store.getState(), connectionIds);
    if (fire.action.kind === "workflow") {
      const workflowId = fire.action.workflowId;
      const workflow = store.getState().workflows.find((w) => w.id === workflowId);
      if (!workflow) return skip("The workflow no longer exists");
      return await runScheduledWorkflow(fire, workflow, tabIds, store);
    }
    return await runScheduledMacro(fire.action.macroId, tabIds, store);
  } catch (err) {
    frontendLog("schedules", `scheduled run ${fire.scheduleId} failed: ${errorMessage(err)}`);
    return { outcome: "failed", message: errorMessage(err), targetsRun: 0 };
  } finally {
    scheduledInFlight -= 1;
  }
}
