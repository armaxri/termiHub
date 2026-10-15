/**
 * Store glue for the session-driven workflow triggers (PROD-041, #3791):
 * `on-disconnect` and `on-output-match`, plus the teardown of the on-connect
 * once-per-session-open guard (#4784).
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
  releaseOnConnectSessions,
  sessionEndCauseFromExit,
  type SessionEndCause,
} from "@/services/workflowTriggers";
import type { TerminalExitReason } from "@/types/terminal";
import type { Workflow, WorkflowRunTrigger } from "@/types/workflow";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "./appStore";
import { collectLiveTabs } from "./layoutHelpers";
import { unattendedParamValues } from "./scheduledRuns";
import { currentSessionView, regionExited } from "./sessionBridge";
import { resolveConnectedTargets } from "./slices/workflowFanout";
import { activeWorkflowRunCount, runWorkflowOnTarget } from "./slices/workflowRunOnTarget";
import { errorMessage } from "@/utils/errorMessage";

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
      frontendLog(
        "workflow",
        `${triggeredBy} run of "${workflow.name}" failed: ${errorMessage(err)}`
      );
    })
    .finally(() => {
      triggeredInFlight--;
    });
  return true;
}

/**
 * Run a trigger hook without letting it fail its caller: the hooks sit on the
 * tab-close and session-exit paths, which must complete even if trigger
 * dispatch throws.
 */
function guarded(what: string, hook: () => void): void {
  try {
    hook();
  } catch (err) {
    frontendLog("workflow", `${what} trigger hook failed: ${errorMessage(err)}`);
  }
}

// ── On-disconnect ────────────────────────────────────────────────────────────

/**
 * A terminal tab's session ended with `cause`. Runs the matching on-disconnect
 * workflows once for this end, in the connection's context (no live session),
 * and forgets the session's output-match state.
 */
function notifyWorkflowSessionEnded(
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

/**
 * Release the on-connect dispatch records `tabId` owns (#4784). A session still
 * shown by another tab in this window stays guarded under that tab, as does
 * `keepSessionId` (the session the tab itself now shows); every other record is
 * forgotten. Tabs in `departing` are leaving together and cannot keep a record.
 */
function releaseTabOnConnectRecords(
  store: WorkflowTriggerStore,
  tabId: string,
  { departing, keepSessionId }: { departing?: ReadonlySet<string>; keepSessionId?: string } = {}
): void {
  const others = collectLiveTabs(store.get()).filter(
    (t) => t.id !== tabId && !departing?.has(t.id)
  );
  releaseOnConnectSessions(tabId, (sessionId) =>
    sessionId === keepSessionId
      ? tabId
      : (others.find((t) => t.sessionId === sessionId)?.id ?? null)
  );
}

/**
 * A terminal session exited with a classified reason (#1121). A clean exit also
 * ends the session for good, so its on-connect record is released; a drop or a
 * kill keeps it, because a reconnect may re-attach the same session id (a
 * persistent session whose transport recovered) and must not re-fire on-connect.
 */
export function notifyWorkflowSessionExited(
  store: WorkflowTriggerStore,
  tabId: string,
  reason: TerminalExitReason
): void {
  guarded("session-exit", () => {
    try {
      notifyWorkflowSessionEnded(store, tabId, sessionEndCauseFromExit(reason));
    } finally {
      if (reason === "clean") releaseTabOnConnectRecords(store, tabId);
    }
  });
}

/**
 * A tab is about to close. When its session is still live, that is a user
 * close; a session that already ended was handled when it ended. Either way
 * the tab's end-of-session record and its on-connect records are dropped with
 * the tab. `closingTabIds` names every tab closing in the same batch (a tab
 * group close), so none of them inherits another's on-connect record.
 */
export function notifyWorkflowTabClosing(
  store: WorkflowTriggerStore,
  tabId: string,
  closingTabIds?: ReadonlySet<string>
): void {
  guarded("tab-close", () => {
    try {
      const tab = collectLiveTabs(store.get()).find((t) => t.id === tabId);
      const live =
        !!tab?.sessionId &&
        !isSessionEndHandled(tabId) &&
        !regionExited(currentSessionView()[tabId]);
      if (live) notifyWorkflowSessionEnded(store, tabId, "user-close");
      armSessionEnd(tabId);
    } finally {
      releaseTabOnConnectRecords(store, tabId, { departing: closingTabIds });
    }
  });
}

/**
 * A tab left this window without closing (moved to another window). No trigger
 * fires — the session lives on elsewhere — but its on-connect records are
 * dropped, since the tab id no longer exists here (#4784).
 */
export function notifyWorkflowTabDeparted(store: WorkflowTriggerStore, tabId: string): void {
  guarded("tab-move", () => releaseTabOnConnectRecords(store, tabId));
}

/**
 * A tab's (new) session connected: re-arm its on-disconnect guard, and release
 * the on-connect records of any session it showed before (#4784). The record of
 * `sessionId` itself is kept, so re-binding the same session does not re-fire.
 */
export function notifyWorkflowSessionStarted(
  store: WorkflowTriggerStore,
  tabId: string,
  sessionId: string
): void {
  guarded("session-start", () => {
    armSessionEnd(tabId);
    releaseTabOnConnectRecords(store, tabId, { keepSessionId: sessionId });
  });
}

// ── On-output-match ──────────────────────────────────────────────────────────

let outputEngine: OutputTriggerEngine | null = null;
/** Whether an output-tap failure was already logged (log once, see {@link outputTap}). */
let outputTapFaultLogged = false;
let outputStore: WorkflowTriggerStore | null = null;

/** The raw-output tap: O(1), defers all work to the engine's batch. */
function outputTap(sessionId: string, encoded: string): void {
  try {
    outputEngine?.enqueue(sessionId, encoded);
  } catch (err) {
    // Never let trigger bookkeeping disturb terminal output delivery. This runs
    // per output chunk, so only the first failure is logged (#4520).
    if (!outputTapFaultLogged) {
      outputTapFaultLogged = true;
      frontendLog(
        "workflow_trigger",
        `output-match tap failed (further failures not logged): ${errorMessage(err)}`
      );
    }
  }
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

/**
 * Drop all session-trigger state. Intended for tests.
 *
 * @internal Test-only hook; no production code calls it.
 */
export function resetWorkflowSessionTriggers(): void {
  outputEngine?.reset();
  outputEngine = null;
  outputStore = null;
  triggeredInFlight = 0;
  terminalDispatcher.setOutputTap(null);
}
