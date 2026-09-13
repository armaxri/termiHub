import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import { localReadFile } from "@/services/api";
import {
  invokeRunLocalProcess,
  cancelLocalProcess,
  subscribeLocalProcessOutput,
} from "@/services/localProcessApi";
import { runMacroPlayback, getTerminalInputInjector } from "@/services/macroPlayback";
import { newId } from "@/services/transport/ids";
import {
  listWorkflows as apiListWorkflows,
  saveWorkflow as apiSaveWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
} from "@/services/workflowApi";
import {
  parseWorkflowEnvelope,
  resolveImportCollisions as resolveWorkflowImportCollisions,
  summarizeLocalProcessSteps,
  type WorkflowImportResult,
} from "@/services/workflowIo";
import {
  runWorkflow as runWorkflowSteps,
  type WorkflowSendSeam,
  type WorkflowRunMacroSeam,
  type WorkflowRunHandle,
  type WorkflowAuthorizeLocalProcessSeam,
  type WorkflowRunLocalProcessSeam,
} from "@/services/workflowRunner";
import { Workflow } from "@/types/workflow";
import { frontendLog } from "@/utils/frontendLog";

import { currentSessionView, regionExited } from "../sessionBridge";
import { currentSettingsView } from "../settingsBridge";
import {
  appendWorkflowOutputLine,
  clearWorkflowOutputContent,
  dispatchWorkflowDismissOutput,
  dispatchWorkflowOutputOpened,
  dispatchWorkflowRunSettled,
  dispatchWorkflowRunStarted,
  dispatchWorkflowStepAdvanced,
  ensureWorkflowSubscribed,
  openWorkflowOutputContent,
  setWorkflowOutputProcessResult,
} from "../workflowRunBridge";

import { collectLiveTabs, getActiveTab, type AppState } from "../appStore";

/** UI-facing metadata describing an in-flight workflow run (#1852). */
export interface WorkflowRunState {
  /** The workflow being run. */
  workflowId: string;
  /** The workflow's name, for the progress indicator. */
  workflowName: string;
  /** The terminal tab the workflow is running against. */
  tabId: string;
  /** Total number of steps in the workflow. */
  total: number;
  /** Steps completed so far. */
  completed: number;
}

/** A single streamed line of a local process's output, tagged by its stream. */
export interface WorkflowRunOutputLine {
  /** Monotonic id within the current process, so React can key incremental appends. */
  id: number;
  /** Which stream produced the line. */
  stream: "stdout" | "stderr";
  /** The line of text (no trailing newline). */
  text: string;
}

/** Live status of the inline run-output surface (#1865). */
export type WorkflowRunOutputStatus = "running" | "completed" | "cancelled" | "failed";

/**
 * The inline run-output surface for a `run-local-process` step (#1865).
 *
 * Unlike {@link WorkflowRunState}, which is cleared the instant a run ends, this
 * persists after the run finishes so the streamed stdout/stderr and the final
 * exit outcome stay visible in the workflow panel until the user dismisses it or
 * starts another run. It is created lazily — only when a run actually spawns a
 * local process — so terminal-native workflows never surface an empty panel. It
 * reuses the exact `subscribeLocalProcessOutput` stream #1857 already emits; no
 * new backend channel is added.
 */
export interface WorkflowRunOutputState {
  /** The workflow whose local process produced this output. */
  workflowId: string;
  /** The workflow's name, for the panel header. */
  workflowName: string;
  /** The program the (most recent) `run-local-process` step spawned. */
  program: string;
  /** The discrete arguments it was spawned with. */
  args: string[];
  /** Streamed stdout/stderr lines, in arrival order. */
  lines: WorkflowRunOutputLine[];
  /** Live status: `running` until the run reaches a terminal state. */
  status: WorkflowRunOutputStatus;
  /** The process exit code once known (`null` when killed before it reported one). */
  exitCode: number | null;
  /** `true` when the process was killed for exceeding its timeout. */
  timedOut: boolean;
  /** A human-readable failure reason when `status` is `failed`. */
  error?: string;
}

/** Options for {@link AppState.runWorkflow}. */
export interface RunWorkflowOptions {
  /** Tab to run against; defaults to the active terminal tab. */
  targetTabId?: string;
}

/**
 * The user's choice at a local-process authorization prompt (#1857):
 * `"once"` allows this single run, `"always"` allows it and adds the program to
 * the persisted allowlist, `"cancel"` refuses (the step does not run).
 */
export type LocalProcessAuthDecision = "once" | "always" | "cancel";

/** State backing the open local-process authorization dialog (#1857). */
export interface LocalProcessPromptState {
  /** The program the step wants to spawn. */
  program: string;
  /** The discrete arguments it would be spawned with. */
  args: string[];
  /** The name of the workflow requesting it, for the prompt copy. */
  workflowName: string;
  /** Resolver wired to the pending authorization promise. */
  resolve: (decision: LocalProcessAuthDecision) => void;
}

/**
 * Default timeout (ms) applied to a `run-local-process` step from the frontend.
 * The backend clamps to its own hard cap regardless.
 */
const LOCAL_PROCESS_TIMEOUT_MS = 60_000;

/** How often (ms) a running local process polls the workflow cancel signal. */
const LOCAL_PROCESS_CANCEL_POLL_MS = 200;

/**
 * Handle for the currently-running workflow, held at module scope so
 * {@link AppState.cancelWorkflowRun} can stop it without threading the handle
 * through store state (it is not serializable). `null` when nothing is running.
 */
let activeWorkflowRun: WorkflowRunHandle | null = null;

/** Generate a unique workflow id. */
function generateWorkflowId(): string {
  return newId("workflow");
}

/**
 * Workflow Automation domain slice (#1852 / epic #1851, extracted under #2077
 * via #2881): the stored-workflow library plus the run/local-process
 * orchestration and the actions that drive them. Extracted verbatim from the
 * monolithic root store as a behavior-preserving Zustand slice — every action
 * still receives the shared `set`/`get` typed against the full {@link AppState},
 * so the public store shape and behavior are unchanged. Mirrors the macros slice
 * (#2114), which shares the same terminal-injector / active-tab / session-view
 * seams. The in-flight run + inline output-panel state is region-authoritative
 * (#2206) and lives in the `workflow-run@<clientId>` projection, driven here by
 * dispatching the `workflow.*` intents through {@link import("../workflowRunBridge")}.
 */
export interface WorkflowsSlice {
  // Workflows (#1852) — the foundation of the Workflow Automation epic (#1851).
  /** All stored workflows. */
  workflows: Workflow[];
  /** Load the workflow library from the backend into the store. */
  loadWorkflows: () => Promise<void>;
  /** Save (add or update) a workflow, then refresh the list. Returns the stored workflow. */
  saveWorkflowToBackend: (workflow: Workflow) => Promise<Workflow>;
  /** Delete a workflow by ID; only mutates local state after the backend delete resolves. */
  deleteWorkflowFromBackend: (workflowId: string) => Promise<void>;
  /**
   * Import workflows from an exported-workflow file's JSON, merging them into the
   * library. Malformed/incompatible files reject with a clear error and leave
   * the library untouched; imported workflows get fresh ids and de-duplicated
   * names. Returns a {@link WorkflowImportResult} that also flags how many
   * imported workflows carry a (guarded, never auto-authorized) `run-local-process`
   * step so the caller can surface a security warning.
   */
  importWorkflows: (json: string) => Promise<WorkflowImportResult>;
  /**
   * Run a stored workflow's steps against a target terminal, dispatching each
   * step through the shared `send_input` seam and surfacing live progress.
   * Defaults the target to the active terminal tab. Only one run happens at a
   * time — a fresh call cancels any in-flight run first. Surfaces a recoverable
   * toast when the workflow is missing/empty, the target terminal is not
   * connected, or a step fails.
   */
  runWorkflow: (workflowId: string, opts?: RunWorkflowOptions) => Promise<void>;
  /** Cancel the in-flight workflow run, if any. Idempotent. */
  cancelWorkflowRun: () => void;
  /** Dismiss the inline run-output surface (clears the projected panel + streamed
   * content). The panel's live state is projected — see {@link
   * import("@/store/useProjectedWorkflowRun").useProjectedWorkflowRun}. */
  dismissWorkflowRunOutput: () => void;
  /**
   * Pending authorization prompt for a guarded `run-local-process` step (#1857),
   * or `null` when none is open. Set when a workflow reaches such a step whose
   * program is not yet on the allowlist; resolved by the user via the dialog.
   */
  localProcessPrompt: LocalProcessPromptState | null;
  /** Resolve the open local-process authorization prompt with the user's choice. */
  resolveLocalProcessPrompt: (decision: LocalProcessAuthDecision) => void;
}

export const createWorkflowsSlice: StateCreator<AppState, [], [], WorkflowsSlice> = (set, get) => ({
  // Workflows (#1852)
  workflows: [],

  loadWorkflows: async () => {
    try {
      const workflows = await apiListWorkflows();
      set({ workflows });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to load workflows: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  saveWorkflowToBackend: async (workflow) => {
    const saved = await apiSaveWorkflow(workflow);
    await get().loadWorkflows();
    return saved;
  },

  deleteWorkflowFromBackend: async (workflowId) => {
    await apiDeleteWorkflow(workflowId);
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== workflowId),
    }));
  },

  importWorkflows: async (json) => {
    // parseWorkflowEnvelope throws on a malformed/incompatible file; let the
    // error propagate so the caller can surface a recoverable toast.
    const parsed = parseWorkflowEnvelope(json);
    const prepared = resolveWorkflowImportCollisions(parsed, get().workflows, generateWorkflowId);
    for (const workflow of prepared) {
      await apiSaveWorkflow(workflow);
    }
    // Refresh once, after all saves, rather than per-workflow.
    await get().loadWorkflows();
    // Flag any imported run-local-process steps: they are preserved (never
    // stripped) so #1857's run-time guard applies, but they are NOT
    // auto-authorized — the caller surfaces this to the user.
    const { workflowsWithLocalProcess, localProcessSteps } = summarizeLocalProcessSteps(prepared);
    return {
      imported: prepared.length,
      workflowsWithLocalProcess,
      localProcessSteps,
    } satisfies WorkflowImportResult;
  },

  runWorkflow: async (workflowId, opts) => {
    const state = get();
    const workflow = state.workflows.find((w) => w.id === workflowId);
    if (!workflow) {
      toast.error("Workflow not found");
      return;
    }

    const targetTabId = opts?.targetTabId ?? getActiveTab(state)?.id ?? null;
    if (!targetTabId) {
      toast.error("No active terminal to run the workflow against");
      return;
    }

    // Guard: only run against a connected, non-exited terminal session.
    const tab = collectLiveTabs(state).find((t) => t.id === targetTabId);
    if (
      !tab ||
      tab.contentType !== "terminal" ||
      !tab.sessionId ||
      // #2625: exited is region-only now the per-client slice is deleted.
      regionExited(currentSessionView()[targetTabId])
    ) {
      toast.error("The target terminal is not connected");
      return;
    }

    if (workflow.steps.length === 0) {
      toast.info(`Workflow "${workflow.name}" has no steps to run`);
      return;
    }

    // Only one run at a time — cancel any in-flight run first.
    if (activeWorkflowRun) {
      activeWorkflowRun.cancel();
      activeWorkflowRun = null;
    }

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
        const message = err instanceof Error ? err.message : String(err);
        frontendLog("workflow", `local process error: ${message}`);
        setWorkflowOutputProcessResult(1, false);
        return { exitCode: 1, timedOut: false, cancelled: false };
      } finally {
        window.clearInterval(poll);
        unlisten();
      }
    };

    const toastId = `workflow-run-${workflowId}-${targetTabId}`;
    const total = workflow.steps.length;
    toast.loading(`Running workflow "${workflow.name}"…`, {
      id: toastId,
      description: `0 / ${total} steps`,
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
      { send, runMacro, readScriptFile: localReadFile, authorizeLocalProcess, runLocalProcess },
      {
        onProgress: (completed, stepTotal) => {
          // Advance the authoritative run progress (guarded server-side to the
          // still-current run). Fire-and-forget: the intent is submitted
          // synchronously, so successive advances apply in order.
          void dispatchWorkflowStepAdvanced({ workflowId, tabId: targetTabId, completed });
          toast.loading(`Running workflow "${workflow.name}"…`, {
            id: toastId,
            description: `${completed} / ${stepTotal} steps`,
          });
        },
      }
    );
    activeWorkflowRun = handle;

    const result = await handle.done;

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

    if (result.status === "completed") {
      toast.success(`Ran workflow "${workflow.name}"`, { id: toastId });
    } else if (result.status === "cancelled") {
      toast.info(`Workflow "${workflow.name}" cancelled`, {
        id: toastId,
        description: `Stopped after ${result.stepsCompleted} of ${total} steps`,
      });
    } else {
      const stepNumber = (result.failedStepIndex ?? result.stepsCompleted) + 1;
      toast.error(`Workflow "${workflow.name}" failed at step ${stepNumber}`, {
        id: toastId,
        description: result.error,
      });
    }
  },

  cancelWorkflowRun: () => {
    if (activeWorkflowRun) {
      activeWorkflowRun.cancel();
    }
  },

  dismissWorkflowRunOutput: () => {
    // Clear the frontend-owned streamed content and dismiss the projected panel
    // (the region is authoritative for the panel's presence + status).
    clearWorkflowOutputContent();
    void dispatchWorkflowDismissOutput();
  },

  localProcessPrompt: null,
  resolveLocalProcessPrompt: (decision) => {
    const prompt = get().localProcessPrompt;
    if (!prompt) return;
    // Clear first so a second click cannot double-resolve the promise.
    set({ localProcessPrompt: null });
    prompt.resolve(decision);
  },
});
