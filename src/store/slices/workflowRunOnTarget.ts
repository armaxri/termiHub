/**
 * Run one workflow against one terminal target — the per-target half of
 * `AppState.runWorkflow` (#1852, extracted for PROD-047 so a manual run can fan
 * out across several sessions). Builds the step seams bound to the target tab
 * (send / local-process / wait-for-output), runs it through the automation
 * runner (#5818: the stored automation behind the workflow view, so a
 * `run-automation` step runs the called automation inline), drives the
 * `workflow-run` projection region, records the run in history (PROD-0046),
 * and surfaces progress, retries (PROD-045), and the outcome as a toast.
 */
import { markAutomationInput } from "@/services/automationTypingMarks";
import { stepKindLabel, stepSummary } from "@/components/AutomationEditor/stepText";
import { toast } from "@/components/ui";
import {
  claimWorkflowRunToast,
  collapseWorkflowRunOutcome,
  keepWorkflowRunFailure,
} from "./workflowRunToasts";
import { localReadFile } from "@/services/api";
import { isScriptSourceConfirmed } from "@/services/workflowScriptSources";
import {
  checkLocalProcess,
  confirmLocalProcess,
  invokeRunLocalProcess,
  cancelLocalProcess,
  subscribeLocalProcessOutput,
  type LocalProcessCheck,
} from "@/services/localProcessApi";
import {
  reachesWaitForUser,
  runAutomationOnTargets,
  type AutomationTargetDeps,
} from "@/services/automationRunner";
import { getTerminalInputInjector } from "@/services/macroPlayback";
import { onTerminalOutput } from "@/services/events";
import { newId } from "@/services/transport/ids";
import {
  matchesOutput,
  type WorkflowSendSeam,
  type WorkflowRunHooks,
  type WorkflowRunnerDeps,
  type WorkflowRunResult,
  type WorkflowAuthorizeLocalProcessSeam,
  type WorkflowRunLocalProcessSeam,
  type WorkflowWaitForOutputSeam,
  type WaitForOutputResult,
  type WorkflowWaitForUserSeam,
  type WorkflowParamValues,
} from "@/services/workflowRunner";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { Workflow } from "@/types/workflow";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { AnsiStreamStripper } from "@/utils/stripAnsi";

import {
  experimentalFeaturesOn,
  localProcessRefusal,
  localProcessRefusalToastId,
} from "../localProcessRefusal";
import { t, tf } from "@/i18n/catalog";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import type { AppState } from "../appStore";
import { collectLiveTabs } from "../layoutHelpers";
import { currentSettingsView } from "../settingsBridge";
import {
  appendWorkflowOutputLine,
  clearWorkflowOutputContent,
  dispatchWorkflowOutputOpened,
  dispatchWorkflowRunSettled,
  dispatchWorkflowRunStarted,
  dispatchWorkflowStepAdvanced,
  ensureWorkflowSubscribed,
  openWorkflowOutputContent,
  setWorkflowOutputProcessResult,
} from "../workflowRunBridge";
import { failedRunActions } from "./automationRunActions";
import { automationForRun, recordAutomationRun } from "./automationStoreState";
import { collectNestedRun, nestedRunRecord, workflowToAutomation } from "./automationViews";
import type { LocalProcessAuthDecision, WorkflowRunOutputLine } from "./workflowsSlice";
import { notRunBecause, stepProgress } from "@/utils/runProgress";
import { activeWorkflowRunCount, forgetWorkflowRun, holdWorkflowRun } from "./workflowRunRegistry";

/**
 * Default timeout (ms) applied to a `run-local-process` step from the frontend.
 * The backend clamps to its own hard cap regardless.
 */
const LOCAL_PROCESS_TIMEOUT_MS = 60_000;

/**
 * Max characters of recent terminal output a `wait-for-output` step retains
 * while matching, so a chatty session cannot grow the match buffer without
 * bound. A pattern longer than a chunk still matches across chunk boundaries
 * because the tail is preserved.
 */
const WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS = 65_536;

export {
  activeWorkflowRunCount,
  cancelAllWorkflowRuns,
  cancelWorkflowRunById,
} from "./workflowRunRegistry";

/** What was decided about one program + args (#5994). */
export type LocalProcessDecision =
  | {
      ok: true;
      /** The file the user approved; absent when the program is on the list. */
      approvedPath?: string;
    }
  | { ok: false; reason?: string };

/**
 * Serializes the interactive local-process authorization prompts: there is one
 * prompt slot in the store, so concurrent targets (#3418) must take turns
 * rather than overwrite each other's pending resolver.
 */
let authPromptQueue: Promise<unknown> = Promise.resolve();

/** What a decision about a command is kept under. */
function decisionKey(
  program: string,
  args: readonly string[],
  callChain: readonly string[]
): string {
  return JSON.stringify([callChain, program, args]);
}

/** Hooks a multi-target (fan-out) run passes to each target (PROD-047, #3418).
 * A fan-out target raises no toasts of its own: it reports to these hooks and
 * the fan-out renders one shared per-target status toast. */
export interface WorkflowFanoutHooks {
  /** Called on each progress step, or with a retry note while a step retries. */
  onProgress?: (completed: number, retryNote?: string) => void;
  /**
   * Local-process authorization decisions shared across the fan-out's targets,
   * keyed by command and the automations behind it, so the user is asked once per program rather than
   * once per terminal.
   */
  authDecisions?: Map<string, Promise<LocalProcessDecision>>;
  /** The terminals its shared local-process answer is for, by title (#6132). */
  terminals?: string[];
}

/** Everything {@link runWorkflowOnTarget} needs to run one workflow on one tab. */
export interface WorkflowTargetRun {
  /** Zustand `set` of the root store (for the prompt state). */
  set: (partial: Partial<AppState>) => void;
  /** Zustand `get` of the root store. */
  get: () => AppState;
  /** The workflow to run. */
  workflow: Workflow;
  /** The terminal tab to run against (already validated as connected). */
  targetTabId: string;
  /** The backend session id backing the tab (for `wait-for-output`). */
  targetSessionId: string;
  /** Collected parameter values (PROD-0040). */
  paramValues: WorkflowParamValues;
  /** What launched the run, recorded in history (PROD-0046). */
  triggeredBy: AutomationRunOrigin;
  /** A human-readable name for the target (its tab title), for the progress list. */
  targetLabel?: string;
  /** Set when this target is one of several in a fan-out run (PROD-047, #3418). */
  fanout?: WorkflowFanoutHooks;
  /**
   * An unattended (scheduled, PROD-043) run: it must never prompt. A
   * `run-local-process` step whose program is not already allowlisted is
   * refused instead of asking.
   */
  unattended?: boolean;
  /**
   * The run has no live session (an on-disconnect trigger, #3791): it runs in
   * the connection's context after the session ended. Send-based steps,
   * typing steps and `wait-for-output` fail at once instead of touching the
   * dead tab; `wait` and `run-local-process` work as usual.
   */
  sessionless?: boolean;
}

/** " (Run command: make)": what a step is, so the user need not count in the editor. */
function stepWhat(step: AutomationStep): string {
  return ` (${[stepKindLabel(step.kind), stepSummary(step)].filter(Boolean).join(": ")})`;
}

/** How the reason starts when the user did not allow a program. */
function refusedStart(): string {
  return t("automation.program.refused").split("{")[0];
}

/** "Step 1 was run." / "Steps 1 to 3 were run.": what a failed run did before (B-010). */
function ranBefore(failedIndex: number, result: WorkflowRunResult): string {
  if (result.notStarted || failedIndex === 0) return "";
  return failedIndex === 1 ? "Step 1 was run." : `Steps 1 to ${failedIndex} were run.`;
}

/**
 * Show the terminal toast for a single-target run's outcome. A clean outcome
 * replaces the previous run's clean outcome; a failure stays (#5675).
 */
export function toastRunOutcome(
  workflowName: string,
  result: WorkflowRunResult,
  total: number,
  toastId: string,
  automation?: Pick<Automation, "id" | "steps">,
  /** The terminal it ran in. */
  where?: string
): void {
  const tolerated = result.continuedFailures ?? [];
  if (result.status === "completed" && tolerated.length === 0) {
    // The terminal output and the run history show it (#5859).
    toast.dismiss(toastId);
  } else if (result.status === "completed") {
    // Completed, but some steps failed and were tolerated via continue-on-error
    // (PROD-045) — say so rather than reporting a clean success.
    const first = tolerated[0];
    // toast-policy: explains-outcome — a clean-looking run hid tolerated step failures
    toast.info(
      `Ran automation “${workflowName}” with ${tolerated.length} tolerated step failure` +
        (tolerated.length === 1 ? "" : "s"),
      { id: toastId, description: `Step ${first.stepIndex + 1}: ${first.error}` }
    );
    keepWorkflowRunFailure(toastId);
  } else if (result.status === "cancelled") {
    // toast-policy: explains-outcome — says how far the canceled run got
    const at = automation?.steps[result.stepsCompleted];
    toast.info(`“${workflowName}” stopped`, {
      id: toastId,
      // Something of the step it was at may have been typed (C-004).
      description: [
        `Stopped${where ? ` in ${where}` : ""} at ${stepProgress(result.stepsCompleted, total).toLowerCase()}${
          at ? stepWhat(at) : ""
        }.`,
        ranBefore(result.stepsCompleted, result),
      ]
        .filter(Boolean)
        .join(" "),
      ...(automation ? { action: failedRunActions(automation.id).cancel } : {}),
    });
    collapseWorkflowRunOutcome(toastId);
  } else {
    const index = result.failedStepIndex ?? result.stepsCompleted;
    const step = automation?.steps[index];
    // What the step is, so the user need not count in the editor (#6026).
    const what = step ? stepWhat(step) : "";
    toast.error(
      result.notStarted
        ? `“${workflowName}” was not run`
        : `“${workflowName}” failed at step ${index + 1}${what}`,
      {
        id: toastId,
        description: [ranBefore(index, result), result.error].filter(Boolean).join(" "),
        // Nothing is wrong with the automation when its program was refused (C-003).
        ...(automation
          ? failedRunActions(automation.id, result.error?.startsWith(refusedStart()) === true)
          : {}),
      }
    );
    keepWorkflowRunFailure(toastId);
  }
}

/**
 * Run `workflow` against one connected terminal tab and resolve its result: a run
 * of {@link runAutomationOnTargets} with one target (#5984). The caller has already
 * validated the target, collected parameters, and stopped the runs in its terminal.
 */
export async function runWorkflowOnTarget(run: WorkflowTargetRun): Promise<WorkflowRunResult> {
  // Stopped only after it started, so `fan` is there by then.
  const target = workflowTarget(run, () => fan.cancel(0));
  const fan = runAutomationOnTargets(target.automation, [run.targetTabId], () => target.start(), {
    hooksFor: () => target.hooks,
    paramValues: run.paramValues,
    settle: (_index, result) => target.settle(result),
  });
  const [result] = await fan.done;
  return result ?? { status: "cancelled", stepsCompleted: 0 };
}

/** One target of a step-by-step run, in the parts {@link runAutomationOnTargets} takes. */
export interface WorkflowTarget {
  /** The automation it runs. */
  automation: Automation;
  /** Show it running and make its seams; or say why it does not run (recorded). */
  start: () => Promise<AutomationTargetDeps>;
  /** Its progress, retries and nested runs. */
  hooks: WorkflowRunHooks;
  /** Record and say how it ended; the result carries its History record's id. */
  settle: (result: WorkflowRunResult) => Promise<WorkflowRunResult>;
  /** Record that it was stopped before its turn, with what stopped it (#6133). */
  notRun: (reason?: string) => WorkflowRunResult;
}

/**
 * The parts of a run of `run.workflow` on one tab (#5984). `cancel` stops it in its
 * fan-out, also before its first step.
 */
export function workflowTarget(run: WorkflowTargetRun, cancel: () => void): WorkflowTarget {
  const {
    set,
    get,
    workflow,
    targetTabId,
    targetSessionId,
    triggeredBy,
    targetLabel,
    fanout,
    unattended,
    sessionless,
  } = run;
  const workflowId = workflow.id;
  const unwatched = unattended === true || sessionless === true;
  // What stopped it, for its History (#6042): another run, or nothing named.
  let stopReason: string | undefined;
  const notStarted = (): WorkflowRunResult | null => {
    // The one place every run that can spawn a local process goes through: refuse
    // it whole rather than half-way, whichever entry point started it (#5988).
    // The entry points check first, before they prompt or connect anything.
    const refusal = localProcessRefusal(get(), workflow);
    if (refusal) {
      frontendLog("workflow", `run of "${workflow.name}" refused: ${refusal}`);
      return { status: "failed", stepsCompleted: 0, error: refusal };
    }
    // Nobody is there to type what it waits for (#6025): not started, rather than
    // left standing at the prompt an earlier step opened. The History says so.
    const stored = automationForRun(get(), workflowId) ?? workflowToAutomation(workflow);
    if (!unwatched || !reachesWaitForUser(stored, (id) => automationForRun(get(), id))) {
      return null;
    }
    const at = new Date().toISOString();
    const notRun: AutomationRun = {
      id: newId("workflow-run"),
      automationId: workflowId,
      automationName: workflow.name,
      startedAt: at,
      endedAt: at,
      status: "failed",
      stepsCompleted: 0,
      total: workflow.steps.length,
      error: t("automation.wait.unattended"),
      tabId: targetTabId,
      targetLabel: targetLabel || undefined,
      origin: triggeredBy,
    };
    recordAutomationRun(set, notRun, "workflow");
    frontendLog("workflow", `run of "${workflow.name}" refused: it waits for the user`);
    if (!fanout) {
      toast.error(`Automation “${workflow.name}” was not run`, {
        id: `automation-wait-refused-${workflowId}`,
        description: t("automation.wait.unattended"),
      });
    }
    return {
      status: "failed",
      stepsCompleted: 0,
      error: t("automation.wait.unattended"),
      historyRunId: notRun.id,
    };
  };
  // This run's key in the workflow-run region (#3418): concurrent targets of a
  // fan-out each get their own entry, progressing and settling independently.
  const runId = newId("wfrun");

  // The workflow runner reuses the macro `send_input` injector seam, bound to
  // the target tab, so send-based steps (send-command, run-script) route
  // through the single choke point.
  const injector = getTerminalInputInjector();
  // Each line it starts typing is marked in the terminal (#6021).
  const marked =
    injector &&
    markAutomationInput(injector, {
      automationId: workflowId,
      name: workflow.name,
      origin: triggeredBy,
    });
  const send: WorkflowSendSeam = (data) => {
    if (!marked || sessionless) return false;
    return marked(targetTabId, data);
  };

  // The authorization gate for a `run-local-process` step (#1857). The backend
  // holds the rule (#5994) and decides again when the program starts; this asks it
  // first, so that a program that is not on the list can be put to the user, and
  // any command of an imported automation that was not confirmed (#6019). Fails
  // closed.
  const askAuthorization = async (
    program: string,
    args: string[],
    callChain: readonly string[],
    goesOn: boolean
  ): Promise<LocalProcessDecision> => {
    if (!currentSettingsView().workflowLocalProcessEnabled) {
      toast.error("Local process execution is disabled", {
        description:
          "Enable it in Settings → Security before this automation can run a local program.",
      });
      return { ok: false };
    }
    let verdict: LocalProcessCheck;
    try {
      verdict = await checkLocalProcess(program, args, callChain);
    } catch (err) {
      return { ok: false, reason: `"${program}" was not started: ${errorMessage(err)}` };
    }
    if (verdict.status === "allowed") return { ok: true };
    if (verdict.status !== "ask") return { ok: false, reason: verdict.reason };
    if (unattended) {
      // Never prompt from an unattended run: an unlisted program, or a command that
      // was not confirmed, is refused.
      frontendLog("workflow", `unattended run refused local program: ${verdict.reason}`);
      return { ok: false, reason: verdict.reason };
    }

    // Not yet trusted — ask the user, once, via the confirmation dialog, about the
    // file that would start. The approval is for that file only.
    const { path, remember, imported, interpreter } = verdict;
    // The question is what it waits for; a spinner beside it would lie on it (B-004).
    if (!fanout) toast.dismiss(toastId);
    const decision = await new Promise<LocalProcessAuthDecision>((resolve) => {
      set({
        localProcessPrompt: {
          program,
          path,
          args,
          goesOn,
          workflowName: workflow.name,
          // Which run asks: its terminal, or all those one answer is for (#6132).
          terminals: fanout?.terminals ?? [tabTitle],
          remember,
          imported,
          interpreter,
          resolve,
        },
      });
    });
    set({ localProcessPrompt: null });
    if (!fanout && decision !== "cancel") {
      toast.loading(`Running automation “${workflow.name}”…`, { id: toastId });
    }

    if (decision === "cancel") {
      return { ok: false, reason: tf("automation.program.refused", { program }) };
    }
    if (decision === "always" && remember === "command") {
      // The backend remembers it, for this very command of these automations.
      try {
        await confirmLocalProcess(program, args, callChain, path);
      } catch (err) {
        // It was allowed for this run; it is asked about again the next time.
        toast.error("The command was not remembered", { description: errorMessage(err) });
      }
    }
    if (decision === "always" && remember === "program") {
      const current = currentSettingsView();
      const nextAllowlist = [...(current.workflowLocalProcessAllowlist ?? [])];
      // The file, not the name it was found by: another one is asked about again.
      if (!nextAllowlist.includes(path)) nextAllowlist.push(path);
      await get().updateSettings({
        ...current,
        workflowLocalProcessAllowlist: nextAllowlist,
      });
    }
    return { ok: true, approvedPath: path };
  };
  // The files the user approved for this run, by program + args.
  const approvedPaths = new Map<string, string>();
  const authorizeLocalProcess: WorkflowAuthorizeLocalProcessSeam = async (
    program,
    args,
    callChain,
    goesOn = false
  ) => {
    // The run was checked before it started; this catches an automation or the
    // switch that changed while it runs (#5988). Before the shared decisions, so
    // a fan-out cannot reuse one made while the switch was on. The backend
    // checks it once more.
    if (!experimentalFeaturesOn()) {
      frontendLog("workflow", `refused local program (experimental features are off): ${program}`);
      toast.error("Local process was not run", {
        id: localProcessRefusalToastId(workflowId),
        description: LOCAL_PROCESS_REASON,
      });
      return false;
    }
    // A fan-out shares one decision per command across its targets. The automations
    // behind it are part of it: one's own and an imported one are asked apart.
    const key = decisionKey(program, args, callChain);
    let decision = fanout?.authDecisions?.get(key);
    if (!decision) {
      // One prompt slot: queue behind any prompt a concurrent target has open.
      decision = authPromptQueue.then(() => askAuthorization(program, args, callChain, goesOn));
      // The caller awaiting `decision` handles its rejection; the queue only has to
      // settle so the next prompt is not blocked. Trace it here too (#4520).
      authPromptQueue = decision.catch((err: unknown) =>
        frontendLog("workflow", `local-process authorization prompt failed: ${errorMessage(err)}`)
      );
      fanout?.authDecisions?.set(key, decision);
    }
    const decided = await decision;
    approvedPaths.delete(key);
    if (!decided.ok) return decided.reason === undefined ? false : { refused: decided.reason };
    if (decided.approvedPath !== undefined) approvedPaths.set(key, decided.approvedPath);
    return true;
  };

  // Spawn an authorized local process through the guarded backend command,
  // streaming its output into the LogViewer (the app's observable surface)
  // and forwarding a cancel from the run's signal to the backend.
  const runLocalProcess: WorkflowRunLocalProcessSeam = async (program, args, options) => {
    const processRunId = newId(`wf-lp-${workflowId}`);
    frontendLog("workflow", `local process starting: ${[program, ...args].join(" ")}`);

    // Open the inline run-output surface for this spawn (#1865). A fresh
    // spawn owns the panel — its program/args and a clean line buffer — so a
    // second run-local-process step shows its own process, not the prior one.
    // The panel's identity + status are authoritative in the projected region
    // (dispatched below); its streamed lines/exitCode/timedOut are frontend-
    // owned and live in the bridge's content store (#2206 reducer-removal).
    let lineSeq = 0;
    openWorkflowOutputContent(workflowId, runId);
    await dispatchWorkflowOutputOpened({
      runId,
      workflowId,
      workflowName: workflow.name,
      program,
      args,
    });

    // Reuse the exact streamed-output events #1857 already emits (keyed by
    // run id): each line lands in the LogViewer AND the inline surface.
    const unlisten = await subscribeLocalProcessOutput(processRunId, (chunk) => {
      frontendLog("workflow", `[${chunk.stream}] ${chunk.line}`);
      const nextLine: WorkflowRunOutputLine = {
        id: lineSeq++,
        stream: chunk.stream,
        text: chunk.line,
      };
      // Frontend-owned streamed content — appended to the bridge's content
      // store (bounded there), not the projection.
      appendWorkflowOutputLine(nextLine, runId);
    });
    // Forward the run's cancel to the backend the moment it is signalled, so a
    // long-running process is killed when the run is cancelled. Event-driven
    // off `whenCancelled` rather than polling `isCancelled()` (#4381); the
    // `processSettled` flag drops a cancel that arrives after the process ended.
    let processSettled = false;
    void options.signal?.whenCancelled?.then(() => {
      if (!processSettled) void cancelLocalProcess(processRunId);
    });

    try {
      const outcome = await invokeRunLocalProcess({
        runId: processRunId,
        program,
        args,
        automationChain: options.callChain,
        approvedPath: approvedPaths.get(decisionKey(program, args, options.callChain)),
        timeoutMs: LOCAL_PROCESS_TIMEOUT_MS,
      });
      frontendLog(
        "workflow",
        `local process finished: exitCode=${outcome.exitCode ?? "null"} ` +
          `timedOut=${outcome.timedOut} cancelled=${outcome.cancelled}`
      );
      // Record the process outcome on the inline surface (frontend-owned
      // streamed content). The overall run status (completed / cancelled /
      // failed) is stamped on the projected panel once the run resolves; here
      // we surface only the raw exit code / timeout (#1865).
      setWorkflowOutputProcessResult(outcome.exitCode, outcome.timedOut, runId);
      return outcome;
    } catch (err) {
      // A backend refusal (it decides what may start, #5994) surfaces as a failed
      // step with its reason rather than crashing the run.
      const message = errorMessage(err);
      frontendLog("workflow", `local process error: ${message}`);
      setWorkflowOutputProcessResult(1, false, runId);
      return { exitCode: 1, timedOut: false, cancelled: false, error: message };
    } finally {
      processSettled = true;
      unlisten();
    }
  };

  // The `wait-for-output` seam (PROD-044): subscribe to the target session's
  // terminal-output events, accumulate a bounded, ANSI-stripped buffer, and
  // resolve on the first match, the timeout, or a run cancel. The runner has
  // already resolved `${param}` in the pattern and clamped the timeout.
  const waitForOutput: WorkflowWaitForOutputSeam = (matcher, timeoutMs, options) =>
    new Promise<WaitForOutputResult>((resolve) => {
      let settled = false;
      let buffer = "";
      const decoder = new TextDecoder();
      // Holds an escape sequence split across two output chunks until it completes.
      const stripper = new AnsiStreamStripper();
      let unlisten: (() => void) | null = null;

      // A cancel already requested before we start waiting ends immediately.
      if (options.signal?.isCancelled()) {
        resolve({ matched: false, timedOut: false, cancelled: true });
        return;
      }

      const finish = (result: WaitForOutputResult): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unlisten?.();
        resolve(result);
      };

      const feed = (text: string): void => {
        buffer += stripper.push(text);
        if (buffer.length > WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS) {
          buffer = buffer.slice(buffer.length - WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS);
        }
        if (matchesOutput(buffer, matcher)) {
          finish({ matched: true, timedOut: false, cancelled: false });
        }
      };

      const timer = window.setTimeout(
        () => finish({ matched: false, timedOut: true, cancelled: false }),
        timeoutMs
      );
      // End the wait the moment the run is cancelled — event-driven off
      // `whenCancelled` instead of polling `isCancelled()` (#4381). `finish`
      // is guarded by `settled`, so a late cancel after a match is a no-op.
      void options.signal?.whenCancelled?.then(() =>
        finish({ matched: false, timedOut: false, cancelled: true })
      );

      void onTerminalOutput((sid, data) => {
        if (settled || sid !== targetSessionId) return;
        feed(decoder.decode(data, { stream: true }));
      })
        .then((un) => {
          // If the wait already settled before the listener attached, drop it.
          if (settled) un();
          else unlisten = un;
        })
        .catch((err) => {
          frontendLog("workflow", `wait-for-output could not subscribe: ${errorMessage(err)}`);
          finish({ matched: false, timedOut: true, cancelled: false });
        });
    });

  // A "Wait for you" step (#6025): the run stops here until the user continues.
  const waitForUser: WorkflowWaitForUserSeam = (message, { signal }) => {
    // The bar above the terminals says it (B-004); the next step brings the toast back.
    if (fanout) fanout.onProgress?.(0, t("automation.wait.note"));
    else toast.dismiss(toastId);
    return get().waitForUser(
      {
        runId,
        tabId: targetTabId,
        sessionId: targetSessionId,
        tabTitle,
        automationName: workflow.name,
        message,
      },
      signal
    );
  };

  // A single-target run keeps its own toast; a fan-out target raises none and
  // reports to the fan-out's hooks, which render one shared status toast
  // (PROD-047, #3418).
  const toastId = `workflow-run-${workflowId}-${targetTabId}`;
  const total = workflow.steps.length;
  const tabTitle =
    targetLabel || collectLiveTabs(get()).find((x) => x.id === targetTabId)?.title || "Terminal";
  const stepNote = (completed: number): string =>
    `${stepProgress(completed, total)} in ${tabTitle}`;
  // Captured at the start so the persisted history record (PROD-0046) carries the
  // real run duration; `triggeredBy` defaults to a manual launch.
  let startedAt = "";
  const nestedRuns = new Map<string, AutomationRun>();
  const deps: WorkflowRunnerDeps = {
    send,
    resolveAutomation: (id) => automationForRun(get(), id),
    readScriptFile: localReadFile,
    // #4310 (FEC2-001): a run-script sourcePath is read only when the user
    // picked or confirmed it on this machine. The allowlist lives in the
    // machine-local settings, never in workflow data, so an imported file
    // cannot vouch for its own path.
    isScriptSourceTrusted: (path) =>
      isScriptSourceConfirmed(currentSettingsView().workflowScriptSourceAllowlist, path),
    authorizeLocalProcess,
    runLocalProcess,
    // A sessionless run has no output to wait for: the step fails loudly.
    waitForOutput: sessionless ? undefined : waitForOutput,
    // Nobody is there to continue a scheduled run or one without a session.
    waitForUser: unwatched ? undefined : waitForUser,
  };
  const start = async (): Promise<AutomationTargetDeps> => {
    const notRun = notStarted();
    if (notRun) return { notRun };
    startedAt = new Date().toISOString();
    // Another run in flight, in another terminal (#6042): its output panel stays.
    const beside = activeWorkflowRunCount() > 0;
    if (!fanout) {
      claimWorkflowRunToast(toastId);
      toast.loading(`Running automation “${workflow.name}”…`, {
        id: toastId,
        description: stepNote(0),
      });
      // Clear any prior run's frontend-owned streamed content when a fresh run
      // starts; a new panel is created lazily only if this run spawns a local
      // process (#1865). The projected panel is reset by `runStarted` below. A
      // fan-out clears once up front instead, so a concurrent sibling's panel
      // survives this target's start, and so does that of a run beside it.
      if (!beside) clearWorkflowOutputContent();
    }
    // The workflow-run region is authoritative (#2206 reducer-removal): the run
    // progress + output-panel status are driven solely by dispatching the
    // `workflow.*` intents. Keep the subscription warm so the render hook
    // receives the resulting diffs.
    try {
      // Logged in the bridge too; render simply stays on the last-known view.
      void ensureWorkflowSubscribed().catch((err: unknown) =>
        frontendLog("workflow_run", `keep-warm subscribe failed: ${errorMessage(err)}`)
      );
    } catch {
      // Not logged here: a non-Tauri env without a socket throws synchronously
      // from transport construction, and dispatchWorkflowRunStarted below hits
      // the same failure and logs it (#4520).
    }
    // Stoppable from the moment it shows as running, which is before its first step:
    // a Stop pressed meanwhile would find no run and be lost. The fan-out stops it
    // at once when its run starts.
    holdWorkflowRun(runId, {
      tabId: targetTabId,
      stop: (reason) => {
        stopReason ??= reason;
        cancel();
      },
    });
    await dispatchWorkflowRunStarted({
      runId,
      workflowId,
      workflowName: workflow.name,
      tabId: targetTabId,
      total,
      label: targetLabel,
      preserveOutput: fanout !== undefined || beside,
    });
    return deps;
  };

  const automation = automationForRun(get(), workflowId) ?? workflowToAutomation(workflow);
  const hooks: WorkflowRunHooks = {
    onProgress: (completed) => {
      // Advance the authoritative run progress (guarded server-side to the
      // still-current run). Fire-and-forget: the intent is submitted
      // synchronously, so successive advances apply in order.
      void dispatchWorkflowStepAdvanced({ runId, workflowId, tabId: targetTabId, completed });
      if (fanout) {
        fanout.onProgress?.(completed);
        return;
      }
      toast.loading(`Running automation “${workflow.name}”…`, {
        id: toastId,
        description: stepNote(completed),
      });
    },
    // Per-step error handling (PROD-045): surface each retry in the progress
    // toast and the LogViewer, and log every tolerated failure.
    onStepRetry: (event) => {
      frontendLog(
        "workflow",
        `"${workflow.name}" step ${event.stepIndex + 1} failed ` +
          `(attempt ${event.failedAttempt}/${event.maxAttempts}): ${event.error}; ` +
          `retrying in ${event.delayMs} ms`
      );
      const retryNote =
        `Retrying step ${event.stepIndex + 1} ` +
        `(attempt ${event.failedAttempt + 1} of ${event.maxAttempts})`;
      if (fanout) {
        fanout.onProgress?.(event.stepIndex, retryNote);
        return;
      }
      toast.loading(`Running automation “${workflow.name}”…`, {
        id: toastId,
        description: retryNote,
      });
    },
    // A `run-automation` step's callee gets its own history record, labeled
    // "Run by another automation", on the same terminal (#5818, slice 9).
    onNestedRunFinished: (event) =>
      collectNestedRun(nestedRuns, nestedRunRecord(event, targetTabId, targetLabel)),
    onStepContinued: (event) => {
      frontendLog(
        "workflow",
        `"${workflow.name}" step ${event.stepIndex + 1} failed after ` +
          `${event.attempts} attempt(s); continuing (continue-on-error): ${event.error}`
      );
    },
  };

  const settle = async (result: WorkflowRunResult): Promise<WorkflowRunResult> => {
    // Persist a metadata-only record of this run (PROD-0046). Fire-and-forget:
    // a history-write failure must NEVER fail or block the run, so it is logged
    // (never rethrown) and the returned, capped list is mirrored into the store.
    const runRecord: AutomationRun = {
      id: newId("workflow-run"),
      automationId: workflowId,
      automationName: workflow.name,
      // A run whose seams could not be made has no start of its own.
      startedAt: startedAt || new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: result.status,
      stepsCompleted: result.stepsCompleted,
      total,
      failedStepIndex: result.status === "failed" ? result.failedStepIndex : undefined,
      // A run another one stopped says which (#6042).
      error:
        result.status === "failed"
          ? result.error
          : result.status === "cancelled"
            ? stopReason
            : undefined,
      continuedFailures: result.continuedFailures?.length || undefined,
      tabId: targetTabId,
      targetLabel: targetLabel || undefined,
      origin: triggeredBy,
    };
    for (const nested of nestedRuns.values()) recordAutomationRun(set, nested, "workflow");
    recordAutomationRun(set, runRecord, "workflow");

    // Settle this run's keyed region entry (#3418). Keyed by run id, a run a newer
    // runWorkflow superseded settles only itself and cannot stamp the newer run's
    // output panel. The settle removes the projected run and stamps the terminal
    // status onto the output panel this run owns; the frontend streamed content
    // (exit code / lines) is kept.
    forgetWorkflowRun(runId);
    await dispatchWorkflowRunSettled(
      runId,
      result.status,
      result.status === "failed" ? result.error : undefined
    );

    // A fan-out run summarises all targets once at the end instead (PROD-047).
    if (!fanout) toastRunOutcome(workflow.name, result, total, toastId, automation, tabTitle);
    return { ...result, historyRunId: runRecord.id };
  };

  const notRun = (reason?: string): WorkflowRunResult => {
    // Stopped while it waited for its turn (#6133): recorded, never shown as started.
    const at = new Date().toISOString();
    const error = notRunBecause(reason);
    const record: AutomationRun = {
      id: newId("workflow-run"),
      automationId: workflowId,
      automationName: workflow.name,
      startedAt: at,
      endedAt: at,
      status: "cancelled",
      stepsCompleted: 0,
      total,
      error,
      tabId: targetTabId,
      targetLabel: targetLabel || undefined,
      origin: triggeredBy,
    };
    recordAutomationRun(set, record, "workflow");
    return { status: "cancelled", stepsCompleted: 0, historyRunId: record.id };
  };

  return { automation, start, hooks, settle, notRun };
}
