/**
 * Store glue for the session-driven workflow triggers (PROD-041, #3791):
 * `on-disconnect` and `on-output-match`.
 *
 * The matching logic lives in the pure services
 * ({@link "@/services/workflowTriggers"} for on-disconnect,
 * {@link "@/services/workflowOutputTriggers"} for on-output-match); this module
 * binds them to the store's tabs and launches the runs.
 *
 * Both triggers fire without the user asking, so a triggered run is
 * **unattended**, like a scheduled one: it never prompts (parameters use their
 * defaults; an un-allowlisted local program is refused), and it never
 * supersedes a run that is already in progress — it is skipped instead. That
 * also stops a workflow from re-triggering itself through its own output.
 */
import { toast } from "@/components/ui";
import { terminalDispatcher } from "@/services/events";
import { OutputTriggerEngine } from "@/services/workflowOutputTriggers";
import {
  armSessionEnd,
  dispatchOnDisconnectTriggers,
  isSessionEndHandled,
  sessionEndCauseFromExit,
  type SessionEndCause,
} from "@/services/workflowTriggers";
import type { TerminalExitReason } from "@/types/terminal";
import type { Workflow, WorkflowRunTrigger } from "@/types/workflow";
import { frontendLog } from "@/utils/frontendLog";

import { collectLiveTabs, type AppState } from "./appStore";
import { unattendedParamValues } from "./scheduledRuns";
import { currentSessionView, regionExited } from "./sessionBridge";
import { resolveConnectedTargets } from "./slices/workflowFanout";
import { activeWorkflowRunCount, runWorkflowOnTarget } from "./slices/workflowRunOnTarget";

/** The store access the trigger glue needs. */
export interface WorkflowTriggerStore {
  get: () => AppState;
  set: (partial: Partial<AppState>) => void;
}

/**
 * Triggered runs launched but not yet settled. Claimed synchronously, so two
 * triggers firing in the same tick cannot both start a run.
 */
let triggeredInFlight = 0;

/** Why a triggered run cannot start now, or `null` when it can. */
function busyReason(state: AppState): string | null {
  if (triggeredInFlight > 0 || activeWorkflowRunCount() > 0) {
    return "another workflow run is in progress";
  }
  if (state.workflowParamPrompt || state.localProcessPrompt) {
    return "another workflow is waiting for input";
  }
  if (state.macroPlayback) return "a macro is playing";
  return null;
}

/** Where a triggered run goes. */
interface TriggeredTarget {
  tabId: string;
  sessionId: string;
  label: string;
  /** The run has no live session (on-disconnect). */
  sessionless: boolean;
}

/**
 * Launch `workflow` unattended for a trigger. Returns whether a run started;
 * a skipped launch is logged (and surfaced when the user must fix something).
 */
function launchTriggeredRun(
  store: WorkflowTriggerStore,
  workflow: Workflow,
  triggeredBy: WorkflowRunTrigger,
  target: TriggeredTarget
): boolean {
  const busy = busyReason(store.get());
  if (busy) {
    frontendLog("workflow", `${triggeredBy} trigger for "${workflow.name}" skipped: ${busy}`);
    return false;
  }
  if (workflow.steps.length === 0) return false;
  const params = unattendedParamValues(workflow.parameters ?? []);
  if ("missing" in params) {
    toast.info(`Workflow "${workflow.name}" was not run`, {
      description: `Parameter "${params.missing}" needs a default value to run from a trigger`,
    });
    return false;
  }

  triggeredInFlight++;
  void runWorkflowOnTarget({
    set: store.set,
    get: store.get,
    workflow,
    targetTabId: target.tabId,
    targetSessionId: target.sessionId,
    targetLabel: target.label,
    paramValues: params.values,
    triggeredBy,
    unattended: true,
    sessionless: target.sessionless,
  })
    .catch((err) => {
      frontendLog("workflow", `${triggeredBy} run of "${workflow.name}" failed: ${String(err)}`);
    })
    .finally(() => {
      triggeredInFlight--;
    });
  return true;
}

// ── On-disconnect ────────────────────────────────────────────────────────────

/**
 * A terminal tab's session ended with `cause`. Runs the matching on-disconnect
 * workflows once for this end, in the connection's context (no live session),
 * and forgets the session's output-match state.
 */
export function notifyWorkflowSessionEnded(
  store: WorkflowTriggerStore,
  tabId: string,
  cause: SessionEndCause
): void {
  const state = store.get();
  const tab = collectLiveTabs(state).find((t) => t.id === tabId);
  if (tab?.sessionId) outputEngine?.forgetSession(tab.sessionId);
  if (!tab || tab.contentType !== "terminal" || !tab.connectionId) return;
  const sessionId = tab.sessionId ?? "";
  dispatchOnDisconnectTriggers({
    tabId,
    connectionId: tab.connectionId,
    cause,
    workflows: state.workflows,
    run: (workflowId) => {
      const workflow = store.get().workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      launchTriggeredRun(store, workflow, "on-disconnect", {
        tabId,
        sessionId,
        label: tab.title,
        sessionless: true,
      });
    },
  });
}

/** A terminal session exited with a classified reason (#1121). */
export function notifyWorkflowSessionExited(
  store: WorkflowTriggerStore,
  tabId: string,
  reason: TerminalExitReason
): void {
  notifyWorkflowSessionEnded(store, tabId, sessionEndCauseFromExit(reason));
}

/**
 * A tab is about to close. When its session is still live, that is a user
 * close; a session that already ended was handled when it ended. Either way
 * the tab's end-of-session record is dropped with the tab.
 */
export function notifyWorkflowTabClosing(store: WorkflowTriggerStore, tabId: string): void {
  const tab = collectLiveTabs(store.get()).find((t) => t.id === tabId);
  const live =
    !!tab?.sessionId && !isSessionEndHandled(tabId) && !regionExited(currentSessionView()[tabId]);
  if (live) notifyWorkflowSessionEnded(store, tabId, "user-close");
  armSessionEnd(tabId);
}

/** A tab's (new) session connected: re-arm its on-disconnect guard. */
export function notifyWorkflowSessionStarted(tabId: string): void {
  armSessionEnd(tabId);
}

// ── On-output-match ──────────────────────────────────────────────────────────

let outputEngine: OutputTriggerEngine | null = null;
let outputStore: WorkflowTriggerStore | null = null;

/** The raw-output tap: O(1), defers all work to the engine's batch. */
function outputTap(sessionId: string, encoded: string): void {
  outputEngine?.enqueue(sessionId, encoded);
}

function createOutputEngine(): OutputTriggerEngine {
  return new OutputTriggerEngine({
    resolveSession: (sessionId) => {
      if (!outputStore) return null;
      const tab = collectLiveTabs(outputStore.get()).find(
        (t) => t.sessionId === sessionId && t.contentType === "terminal"
      );
      return tab?.connectionId ? { tabId: tab.id, connectionId: tab.connectionId } : null;
    },
    fire: (workflowId, tabId, sessionId) => {
      const store = outputStore;
      if (!store) return false;
      const state = store.get();
      const workflow = state.workflows.find((w) => w.id === workflowId);
      const [target] = resolveConnectedTargets(state, [tabId]).targets;
      if (!workflow || !target || target.sessionId !== sessionId) return false;
      return launchTriggeredRun(store, workflow, "on-output-match", {
        tabId,
        sessionId,
        label: target.title,
        sessionless: false,
      });
    },
  });
}

/**
 * Re-read the saved workflows' on-output-match triggers. Installs the output
 * tap while at least one valid trigger exists and removes it otherwise, so a
 * user without such triggers pays nothing on the output path.
 */
export function syncWorkflowOutputTriggers(
  store: WorkflowTriggerStore,
  workflows: readonly Workflow[]
): void {
  outputStore = store;
  outputEngine ??= createOutputEngine();
  outputEngine.setWorkflows(workflows);
  terminalDispatcher.setOutputTap(outputEngine.active ? outputTap : null);
}

/** Drop all session-trigger state. Intended for tests. */
export function resetWorkflowSessionTriggers(): void {
  outputEngine?.reset();
  outputEngine = null;
  outputStore = null;
  triggeredInFlight = 0;
  terminalDispatcher.setOutputTap(null);
}
