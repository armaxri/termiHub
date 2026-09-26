/**
 * Run one workflow against one terminal target — the per-target half of
 * `AppState.runWorkflow` (#1852, extracted for PROD-047 so a manual run can fan
 * out across several sessions). Builds the step seams bound to the target tab
 * (send / run-macro / local-process / wait-for-output), drives the
 * `workflow-run` projection region, records the run in history (PROD-0046),
 * and surfaces progress, retries (PROD-045), and the outcome as a toast.
 */
import { toast } from "@/components/ui";
import { localReadFile } from "@/services/api";
import {
  invokeRunLocalProcess,
  cancelLocalProcess,
  subscribeLocalProcessOutput,
} from "@/services/localProcessApi";
import { runMacroPlayback, getTerminalInputInjector } from "@/services/macroPlayback";
import { onTerminalOutput } from "@/services/events";
import { newId } from "@/services/transport/ids";
import { recordWorkflowRun as apiRecordWorkflowRun } from "@/services/workflowApi";
import {
  runWorkflow as runWorkflowSteps,
  matchesOutput,
  type WorkflowSendSeam,
  type WorkflowRunMacroSeam,
  type WorkflowRunHandle,
  type WorkflowRunResult,
  type WorkflowAuthorizeLocalProcessSeam,
  type WorkflowRunLocalProcessSeam,
  type WorkflowWaitForOutputSeam,
  type WaitForOutputResult,
  type WorkflowParamValues,
} from "@/services/workflowRunner";
import type { Workflow, WorkflowRun, WorkflowRunTrigger } from "@/types/workflow";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";
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
import type { LocalProcessAuthDecision, WorkflowRunOutputLine } from "./workflowsSlice";

/**
 * Default timeout (ms) applied to a `run-local-process` step from the frontend.
 * The backend clamps to its own hard cap regardless.
 */
const LOCAL_PROCESS_TIMEOUT_MS = 60_000;

/** How often (ms) a running local process polls the workflow cancel signal. */
const LOCAL_PROCESS_CANCEL_POLL_MS = 200;

/** How often (ms) a `wait-for-output` step polls the workflow cancel signal. */
const WAIT_FOR_OUTPUT_CANCEL_POLL_MS = 200;

/**
 * Max characters of recent terminal output a `wait-for-output` step retains
 * while matching, so a chatty session cannot grow the match buffer without
 * bound. A pattern longer than a chunk still matches across chunk boundaries
 * because the tail is preserved.
 */
const WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS = 65_536;

/**
 * Strips the common ANSI/VT escape sequences (CSI/SGR and friends) from
 * terminal output so a `wait-for-output` pattern matches the visible text, not
 * the control codes. Built with `\u001b`/`\u009b` escapes so no literal control
 * character appears in the source; `no-control-regex` is disabled because
 * matching the escape introducer is exactly the intent.
 */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Handle for the currently-running workflow, held at module scope so
 * {@link AppState.cancelWorkflowRun} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is running.
 */
let activeWorkflowRun: WorkflowRunHandle | null = null;

/** Cancel the in-flight run (if any) and forget it, so a fresh run takes over. */
export function replaceActiveWorkflowRun(): void {
  if (activeWorkflowRun) {
    activeWorkflowRun.cancel();
    activeWorkflowRun = null;
  }
}

/** Request cancellation of the in-flight run, if any. Idempotent. */
export function cancelActiveWorkflowRun(): void {
  activeWorkflowRun?.cancel();
}

/** Position of this target within a multi-target (fan-out) run (PROD-047). */
export interface WorkflowFanoutPosition {
  /** 0-based index of this target. */
  index: number;
  /** Total number of targets in the fan-out. */
  total: number;
  /** The toast id shared by every target of the fan-out. */
  toastId: string;
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
  triggeredBy: WorkflowRunTrigger;
  /** Set when this target is one of several in a fan-out run (PROD-047). */
  fanout?: WorkflowFanoutPosition;
}

/** Show the terminal toast for a single-target run's outcome. */
export function toastRunOutcome(
  workflowName: string,
  result: WorkflowRunResult,
  total: number,
  toastId: string
): void {
  const tolerated = result.continuedFailures ?? [];
  if (result.status === "completed" && tolerated.length === 0) {
    toast.success(`Ran workflow "${workflowName}"`, { id: toastId });
  } else if (result.status === "completed") {
    // Completed, but some steps failed and were tolerated via continue-on-error
    // (PROD-045) — say so rather than reporting a clean success.
    const first = tolerated[0];
    toast.info(
      `Ran workflow "${workflowName}" with ${tolerated.length} tolerated step failure` +
        (tolerated.length === 1 ? "" : "s"),
      { id: toastId, description: `Step ${first.stepIndex + 1}: ${first.error}` }
    );
  } else if (result.status === "cancelled") {
    toast.info(`Workflow "${workflowName}" cancelled`, {
      id: toastId,
      description: `Stopped after ${result.stepsCompleted} of ${total} steps`,
    });
  } else {
    const stepNumber = (result.failedStepIndex ?? result.stepsCompleted) + 1;
    toast.error(`Workflow "${workflowName}" failed at step ${stepNumber}`, {
      id: toastId,
      description: result.error,
    });
  }
}

/**
 * Run `workflow` against one connected terminal tab and resolve its result.
 * See the module docs; the caller has already validated the target, collected
 * parameters, and cancelled any previous run.
 */
export async function runWorkflowOnTarget(run: WorkflowTargetRun): Promise<WorkflowRunResult> {
  const { set, get, workflow, targetTabId, targetSessionId, paramValues, triggeredBy, fanout } =
    run;
  const workflowId = workflow.id;

  // The workflow runner reuses the macro `send_input` injector seam, bound to
  // the target tab, so send-based steps (send-command, run-script) route
  // through the single choke point.
  const injector = getTerminalInputInjector();
  const send: WorkflowSendSeam = (data) => {
    if (!injector) return false;
    return injector(targetTabId, data);
  };

  // A `run-macro` step replays a stored macro by id through the macro-playback
  // service, into the same target tab, reusing the macro's recorded timing.
  const runMacro: WorkflowRunMacroSeam = async (macroId) => {
    if (!injector) return false;
    const macro = get().macros.find((m) => m.id === macroId);
    if (!macro || macro.steps.length === 0) return false;
    const macroHandle = runMacroPlayback(macro.steps, (data) => injector(targetTabId, data), {
      timingMode: "real-time",
    });
    const macroResult = await macroHandle.done;
    return macroResult.status === "completed";
  };

  // The authorization gate for a `run-local-process` step (#1857). Fails
  // closed: unless the user has opted in AND authorized this specific
  // program (allowlist hit or an interactive confirmation), it returns
  // false and the step never spawns. An imported workflow's step is never
  // pre-authorized — the program is not on the allowlist and the master
  // opt-in defaults off, so it lands here and is gated exactly like any
  // other untrusted program.
  const authorizeLocalProcess: WorkflowAuthorizeLocalProcessSeam = async (program, args) => {
    const settings = currentSettingsView();
    if (!settings.workflowLocalProcessEnabled) {
      toast.error("Local process execution is disabled", {
        description:
          "Enable it in Settings → Security before this workflow can run a local program.",
      });
      return false;
    }
    const allowlist = settings.workflowLocalProcessAllowlist ?? [];
    if (allowlist.includes(program)) return true;

    // Not yet trusted — ask the user, once, via the confirmation dialog.
    const decision = await new Promise<LocalProcessAuthDecision>((resolve) => {
      set({
        localProcessPrompt: { program, args, workflowName: workflow.name, resolve },
      });
    });
    set({ localProcessPrompt: null });

    if (decision === "cancel") return false;
    if (decision === "always") {
      const current = currentSettingsView();
      const nextAllowlist = [...(current.workflowLocalProcessAllowlist ?? [])];
      if (!nextAllowlist.includes(program)) nextAllowlist.push(program);
      await get().updateSettings({
        ...current,
        workflowLocalProcessAllowlist: nextAllowlist,
      });
    }
    return true;
  };

  // Spawn an authorized local process through the guarded backend command,
  // streaming its output into the LogViewer (the app's observable surface)
  // and forwarding a cancel from the run's signal to the backend.
  const runLocalProcess: WorkflowRunLocalProcessSeam = async (program, args, options) => {
    const runId = `wf-lp-${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    frontendLog("workflow", `local process starting: ${[program, ...args].join(" ")}`);

    // Open the inline run-output surface for this spawn (#1865). A fresh
    // spawn owns the panel — its program/args and a clean line buffer — so a
    // second run-local-process step shows its own process, not the prior one.
    // The panel's identity + status are authoritative in the projected region
    // (dispatched below); its streamed lines/exitCode/timedOut are frontend-
    // owned and live in the bridge's content store (#2206 reducer-removal).
    let lineSeq = 0;
    openWorkflowOutputContent(workflowId);
    await dispatchWorkflowOutputOpened({
      workflowId,
      workflowName: workflow.name,
      program,
      args,
    });

    // Reuse the exact streamed-output events #1857 already emits (keyed by
    // run id): each line lands in the LogViewer AND the inline surface.
    const unlisten = await subscribeLocalProcessOutput(runId, (chunk) => {
      frontendLog("workflow", `[${chunk.stream}] ${chunk.line}`);
      const nextLine: WorkflowRunOutputLine = {
        id: lineSeq++,
        stream: chunk.stream,
        text: chunk.line,
      };
      // Frontend-owned streamed content — appended to the bridge's content
      // store (bounded there), not the projection.
      appendWorkflowOutputLine(nextLine);
    });
    // Poll the run's cancel signal and forward it to the backend so a
    // long-running process is killed when the run is cancelled.
    const poll = window.setInterval(() => {
      if (options.signal?.isCancelled()) {
        void cancelLocalProcess(runId);
      }
    }, LOCAL_PROCESS_CANCEL_POLL_MS);

    try {
      const outcome = await invokeRunLocalProcess({
        runId,
        program,
        args,
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
      setWorkflowOutputProcessResult(outcome.exitCode, outcome.timedOut);
      return outcome;
    } catch (err) {
      // A backend rejection (e.g. opt-in disabled at the trust boundary)
      // surfaces as a failed step rather than crashing the run.
      const message = errorMessage(err);
      frontendLog("workflow", `local process error: ${message}`);
      setWorkflowOutputProcessResult(1, false);
      return { exitCode: 1, timedOut: false, cancelled: false };
    } finally {
      window.clearInterval(poll);
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
        window.clearInterval(poll);
        unlisten?.();
        resolve(result);
      };

      const feed = (text: string): void => {
        buffer += text.replace(ANSI_ESCAPE_RE, "");
        if (buffer.length > WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS) {
          buffer = buffer.slice(buffer.length - WAIT_FOR_OUTPUT_BUFFER_MAX_CHARS);
        }
        if (matchesOutput(buffer, matcher)) {
          finish({ matched: true, timedOut: false, cancelled: false });
        }
      };

      const poll = window.setInterval(() => {
        if (options.signal?.isCancelled()) {
          finish({ matched: false, timedOut: false, cancelled: true });
        }
      }, WAIT_FOR_OUTPUT_CANCEL_POLL_MS);
      const timer = window.setTimeout(
        () => finish({ matched: false, timedOut: true, cancelled: false }),
        timeoutMs
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

  // A fan-out run (PROD-047) shares one toast across all its targets; a
  // single-target run keeps its own per-target toast.
  const toastId = fanout?.toastId ?? `workflow-run-${workflowId}-${targetTabId}`;
  const total = workflow.steps.length;
  const progressLabel = (completed: number): string =>
    fanout
      ? `Terminal ${fanout.index + 1} / ${fanout.total} · ${completed} / ${total} steps`
      : `${completed} / ${total} steps`;
  // Captured up front so the persisted history record (PROD-0046) carries the
  // real run duration; `triggeredBy` defaults to a manual launch.
  const startedAt = new Date().toISOString();
  toast.loading(`Running workflow "${workflow.name}"…`, {
    id: toastId,
    description: progressLabel(0),
  });
  // Clear any prior run's frontend-owned streamed content when a fresh run
  // starts; a new panel is created lazily only if this run spawns a local
  // process (#1865). The projected panel is reset by `runStarted` below.
  clearWorkflowOutputContent();
  // The workflow-run region is authoritative (#2206 reducer-removal): the run
  // progress + output-panel status are driven solely by dispatching the
  // `workflow.*` intents. Keep the subscription warm so the render hook
  // receives the resulting diffs.
  try {
    void ensureWorkflowSubscribed().catch(() => {
      /* logged in the bridge; render simply stays on the last-known view */
    });
  } catch {
    /* non-Tauri env without a socket — dispatch logs + no-ops */
  }
  await dispatchWorkflowRunStarted({
    workflowId,
    workflowName: workflow.name,
    tabId: targetTabId,
    total,
  });

  const handle = runWorkflowSteps(
    workflow.steps,
    {
      send,
      runMacro,
      readScriptFile: localReadFile,
      authorizeLocalProcess,
      runLocalProcess,
      waitForOutput,
    },
    {
      onProgress: (completed) => {
        // Advance the authoritative run progress (guarded server-side to the
        // still-current run). Fire-and-forget: the intent is submitted
        // synchronously, so successive advances apply in order.
        void dispatchWorkflowStepAdvanced({ workflowId, tabId: targetTabId, completed });
        toast.loading(`Running workflow "${workflow.name}"…`, {
          id: toastId,
          description: progressLabel(completed),
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
        toast.loading(`Running workflow "${workflow.name}"…`, {
          id: toastId,
          description:
            `Retrying step ${event.stepIndex + 1} ` +
            `(attempt ${event.failedAttempt + 1} of ${event.maxAttempts})`,
        });
      },
      onStepContinued: (event) => {
        frontendLog(
          "workflow",
          `"${workflow.name}" step ${event.stepIndex + 1} failed after ` +
            `${event.attempts} attempt(s); continuing (continue-on-error): ${event.error}`
        );
      },
    },
    paramValues
  );
  activeWorkflowRun = handle;

  const result = await handle.done;

  // Persist a metadata-only record of this run (PROD-0046). Fire-and-forget:
  // a history-write failure must NEVER fail or block the run, so it is logged
  // (never rethrown) and the returned, capped list is mirrored into the store.
  const runRecord: WorkflowRun = {
    id: newId("workflow-run"),
    workflowId,
    workflowName: workflow.name,
    startedAt,
    endedAt: new Date().toISOString(),
    status: result.status,
    stepsCompleted: result.stepsCompleted,
    total,
    failedStepIndex: result.status === "failed" ? result.failedStepIndex : undefined,
    error: result.status === "failed" ? result.error : undefined,
    continuedFailures: result.continuedFailures?.length || undefined,
    tabId: targetTabId,
    triggeredBy,
  };
  try {
    void apiRecordWorkflowRun(runRecord)
      .then((runs) => set({ workflowRuns: Array.isArray(runs) ? runs : [] }))
      .catch((err) => {
        frontendLog("workflow", `Failed to record workflow run: ${errorMessage(err)}`);
      });
  } catch (err) {
    // Guard even a synchronous throw (e.g. no Tauri bridge): recording must
    // never fail or block the run.
    frontendLog("workflow", `Failed to record workflow run: ${errorMessage(err)}`);
  }

  // Only settle the run when it is still the current one — a newer
  // runWorkflow may have replaced it while this one was cancelled. The settle
  // clears the projected run and stamps the terminal status onto the projected
  // output panel; the frontend streamed content (exit code / lines) is kept.
  if (activeWorkflowRun === handle) {
    activeWorkflowRun = null;
    await dispatchWorkflowRunSettled(
      result.status,
      result.status === "failed" ? result.error : undefined
    );
  }

  // A fan-out run summarises all targets once at the end instead (PROD-047).
  if (!fanout) toastRunOutcome(workflow.name, result, total, toastId);
  return result;
}
