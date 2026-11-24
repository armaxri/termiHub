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
 * - it never prompts: a workflow parameter without a usable default, or a
 *   local program that is not already allowlisted, makes the run skip / fail
 *   instead of asking;
 * - it connects nothing — unless the schedule opts into "Connect if not
 *   connected" (#3527) and this is the fire's `connectWindow`: then the targets
 *   with no connected terminal here are connected **unattended** first (never
 *   prompting; a target that would need input is skipped with the reason), and
 *   the tabs this opened are closed when the run ends, whatever its outcome.
 *   A target another window runs on itself is never connected here (#3878):
 *   each window acknowledges the fire with {@link claimedTargetIds}, and the
 *   connect window skips those, so each target runs once, where it is held;
 * - with experimental features off it never runs an automation that can reach a
 *   "Run local process" step (#5818): refused here before anything is connected
 *   or typed, and again at the spawn (the authorization seam and the backend);
 * - it never supersedes something the user started: if a workflow run (or a
 *   macro playback) is already in flight in this window, the run is skipped.
 *
 * A schedule runs one automation (schema v3, #5818). Until the run picker is
 * merged, a typing-only automation plays like a macro (one playback into all
 * targets) and every other automation runs like a workflow (one run per
 * target); both record into the single automation run history, and the
 * report carries those records' ids as `runIds`.
 *
 * Every outcome — including "nothing to do here" — is reported, so the backend
 * can settle the run and record the reason.
 */
import { toast } from "@/components/ui";
import type { WorkflowParamValues } from "@/services/workflowRunner";
import type { ScheduleFire, ScheduleTargets, WindowRunReport } from "@/types/schedule";
import type { MacroRun } from "@/types/macro";
import type { BroadcastGroup } from "@/types/terminal";
import type { Workflow, WorkflowParameter } from "@/types/workflow";
import type { Automation } from "@/types/generated/Automation";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { scheduleBlockedReason } from "@/utils/scheduleLocalProcessGate";

import type { AppState } from "./appStore";
import { collectLiveTabs } from "./layoutHelpers";
import { filterConnectedTerminalTabIds } from "./tabQueries";
import { currentBroadcastGroups } from "./broadcastGroups";
import {
  resolveConnectedTargets,
  runWithConcurrency,
  toastFanoutSummary,
  WORKFLOW_FANOUT_CONCURRENCY,
  type FanoutOutcome,
} from "./slices/workflowFanout";
import { automationForRun } from "./slices/automationStoreState";
import { automationToWorkflow, isMacroShaped } from "./slices/automationViews";
import { currentSettingsView } from "./settingsBridge";
import {
  closeRunTabs,
  connectedIds,
  connectMissingTargets,
  type UnattendedConnector,
} from "./scheduledConnect";
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
 * The target connection ids this window will run the fire on itself — the
 * ones with a connected terminal here — sent with its acknowledgement so the
 * connect window does not connect them again (#3878). Empty when this window
 * will skip the run (busy, or its broadcast group is gone).
 */
export function claimedTargetIds(fire: ScheduleFire, state: AppState): string[] {
  if (busyReason(state)) return [];
  const connectionIds = resolveTargetConnectionIds(fire.targets, currentBroadcastGroups());
  return connectionIds === null ? [] : connectedIds(state, connectionIds);
}

/**
 * Parameter values for an unattended run: each parameter's default, else a
 * type-appropriate empty value. Returns the name of a required parameter that
 * has no usable default (the run must then not start — it cannot prompt).
 */
export function unattendedParamValues(
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
  if (workflow.steps.length === 0) return skip(`Automation "${workflow.name}" has no steps`);
  const { targets } = resolveConnectedTargets(store.getState(), tabIds);
  if (targets.length === 0) return skip("None of the target connections is connected");
  const params = unattendedParamValues(workflow.parameters ?? []);
  if ("missing" in params) {
    return skip(`Parameter "${params.missing}" needs a default value to run unattended`);
  }

  const toastId = `schedule-run-${fire.token}`;
  toast.loading(`Scheduled run "${fire.scheduleName}"`, {
    id: toastId,
    description: `Running automation "${workflow.name}" on ${targets.length} terminal${
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
  const runIds = outcomes.flatMap((o) => (o.result.historyRunId ? [o.result.historyRunId] : []));
  const ids = runIds.length > 0 ? { runIds } : {};

  const failed = outcomes.find((o) => o.result.status === "failed");
  if (failed) {
    return {
      outcome: "failed",
      message: `${failed.title}: ${failed.result.error ?? "a step failed"}`,
      targetsRun: outcomes.length,
      ...ids,
    };
  }
  if (outcomes.length < targets.length || outcomes.some((o) => o.result.status === "cancelled")) {
    return { outcome: "cancelled", targetsRun: outcomes.length, ...ids };
  }
  return { outcome: "completed", targetsRun: outcomes.length, ...ids };
}

/** Play a typing-only automation into this window's connected targets. */
async function runScheduledMacro(
  automation: Automation,
  tabIds: string[],
  store: ScheduledRunStore
): Promise<WindowRunReport> {
  const state = store.getState();
  const macroId = automation.id;
  if (automation.steps.length === 0) return skip(`Automation "${automation.name}" has no steps`);
  const targets = filterConnectedTerminalTabIds(state, tabIds);
  if (targets.length === 0) return skip("None of the target connections is connected");
  // Every terminal's playback writes its own record (#5818): the attempt links
  // exactly the ones written, and fails when any of them failed.
  const recorded: MacroRun[] = [];
  const status = await state.playMacro(macroId, {
    targetTabIds: targets,
    origin: "scheduled",
    onRecorded: (run) => recorded.push(run),
  });
  if (status === null) return skip("The automation could not be played");
  const ran = {
    targetsRun: recorded.length,
    ...(recorded.length > 0 ? { runIds: recorded.map((run) => run.id) } : {}),
  };
  if (recorded.some((run) => run.status === "error")) {
    return {
      outcome: "failed",
      message: "A target terminal disconnected during playback",
      ...ran,
    };
  }
  return { outcome: status === "completed" ? "completed" : "cancelled", ...ran };
}

/** Options of {@link executeScheduledRun}. */
export interface ScheduledRunOptions {
  /**
   * Set when this window is the fire's `connectWindow` (#3527): the unattended
   * connector to connect the targets not connected here with, before running.
   */
  connectMissing?: UnattendedConnector;
  /**
   * With `connectMissing`: the targets the run's other windows run on
   * themselves, which this window must not connect again (#3878).
   */
  connectedElsewhere?: () => Promise<readonly string[]>;
  /** How long an opened tab may take to attach (a test seam). */
  readyTimeoutMs?: number;
}

/** Fold the targets an unattended connect skipped into the window's report. */
function withSkippedTargets(report: WindowRunReport, skipped: readonly string[]): WindowRunReport {
  if (skipped.length === 0) return report;
  const detail = skipped.join("; ");
  if (report.outcome === "skipped" && report.targetsRun === 0) {
    return { ...report, message: detail };
  }
  const message = report.message ? `${report.message}; ${detail}` : detail;
  return { ...report, message };
}

/**
 * The automation the fire runs, or the reason it must not run at all. Checked
 * before anything is connected or typed.
 */
async function resolveAction(
  fire: ScheduleFire,
  store: ScheduledRunStore
): Promise<{ automation: Automation } | { refused: string }> {
  const automation = await store.getState().fetchAutomationForRun(fire.action.automationId);
  // An action whose legacy id is not resolved yet (`legacySource`) must never
  // run an automation of the other kind that happens to have the same id.
  const { legacySource } = fire.action;
  if (!automation || (legacySource && automation.legacy?.from !== legacySource)) {
    return { refused: "The automation no longer exists" };
  }
  const blocked = scheduleBlockedReason(
    automation,
    (id) => automationForRun(store.getState(), id),
    currentSettingsView().experimentalFeaturesEnabled === true
  );
  return blocked ? { refused: blocked } : { automation };
}

/** Run the fire's automation on `tabIds` in this window. */
async function runAction(
  fire: ScheduleFire,
  automation: Automation,
  tabIds: string[],
  store: ScheduledRunStore
): Promise<WindowRunReport> {
  if (isMacroShaped(automation)) return await runScheduledMacro(automation, tabIds, store);
  return await runScheduledWorkflow(fire, automationToWorkflow(automation), tabIds, store);
}

/**
 * Execute a fired schedule in this window and return the report (without
 * sending it). Never throws: an unexpected error becomes a `failed` report.
 */
export async function executeScheduledRun(
  fire: ScheduleFire,
  store: ScheduledRunStore,
  options: ScheduledRunOptions = {}
): Promise<WindowRunReport> {
  const busy = busyReason(store.getState());
  if (busy) return skip(busy);
  scheduledInFlight += 1;
  try {
    const connectionIds = resolveTargetConnectionIds(fire.targets, currentBroadcastGroups());
    if (connectionIds === null) return skip("The broadcast group no longer exists");
    const action = await resolveAction(fire, store);
    if ("refused" in action) return skip(action.refused);
    const { automation } = action;
    if (!options.connectMissing) {
      return await runAction(
        fire,
        automation,
        targetTabIds(store.getState(), connectionIds),
        store
      );
    }
    const elsewhere = new Set(options.connectedElsewhere ? await options.connectedElsewhere() : []);
    const connected = await connectMissingTargets(
      store.getState,
      connectionIds.filter((id) => !elsewhere.has(id)),
      options.connectMissing,
      options.readyTimeoutMs
    );
    closeRunTabs(store.getState, connected.abandoned, false);
    try {
      const report = await runAction(
        fire,
        automation,
        targetTabIds(store.getState(), connectionIds),
        store
      );
      return withSkippedTargets(report, connected.skipped);
    } finally {
      // Tabs the run opened close whatever its outcome (#3527).
      closeRunTabs(store.getState, connected.opened, true);
    }
  } catch (err) {
    frontendLog("schedules", `scheduled run ${fire.scheduleId} failed: ${errorMessage(err)}`);
    return { outcome: "failed", message: errorMessage(err), targetsRun: 0 };
  } finally {
    scheduledInFlight -= 1;
  }
}
