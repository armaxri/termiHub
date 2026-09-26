import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import { newId } from "@/services/transport/ids";
import {
  listWorkflows as apiListWorkflows,
  saveWorkflow as apiSaveWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  listWorkflowRuns as apiListWorkflowRuns,
  clearWorkflowRunHistory as apiClearWorkflowRunHistory,
} from "@/services/workflowApi";
import {
  parseWorkflowEnvelope,
  resolveImportCollisions as resolveWorkflowImportCollisions,
  summarizeLocalProcessSteps,
  type WorkflowImportResult,
} from "@/services/workflowIo";
import type { WorkflowParamValues } from "@/services/workflowRunner";
import { Workflow, WorkflowParameter, WorkflowRun, WorkflowRunTrigger } from "@/types/workflow";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

import { clearWorkflowOutputContent, dispatchWorkflowDismissOutput } from "../workflowRunBridge";
import { getActiveTab, type AppState } from "../appStore";
import {
  clampFanoutConcurrency,
  describeFanoutProgress,
  resolveConnectedTargets,
  runWithConcurrency,
  toastFanoutSummary,
  type FanoutOutcome,
  type FanoutTargetStatus,
} from "./workflowFanout";
import {
  cancelAllWorkflowRuns,
  cancelWorkflowRunById,
  replaceActiveWorkflowRun,
  runWorkflowOnTarget,
} from "./workflowRunOnTarget";

/** UI-facing metadata describing an in-flight workflow run (#1852). */
export interface WorkflowRunState {
  /** The run's id (#3418: several runs may be in flight at once). */
  runId: string;
  /** The workflow being run. */
  workflowId: string;
  /** The workflow's name, for the progress indicator. */
  workflowName: string;
  /** The terminal tab the workflow is running against. */
  tabId: string;
  /** A human-readable name for the target terminal, when known. */
  label?: string | null;
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
  /**
   * Run against this set of tabs instead (PROD-047). Takes precedence over
   * {@link targetTabId}. The targets run concurrently, at most
   * {@link concurrency} at a time (#3418). Tabs that are not connected are
   * skipped and reported; each target gets its own run-history record.
   */
  targetTabIds?: string[];
  /**
   * How many targets of a multi-target run execute at the same time (#3418),
   * clamped to `1..WORKFLOW_FANOUT_CONCURRENCY`. Defaults to the cap; `1` runs
   * them one after another.
   */
  concurrency?: number;
  /**
   * What launched the run, recorded in the persisted run history (PROD-0046).
   * Defaults to `"manual"` (palette / sidebar / toolbar); on-connect and hotkey
   * dispatch pass their own value.
   */
  triggeredBy?: WorkflowRunTrigger;
}

/**
 * The user's choice at a local-process authorization prompt (#1857):
 * `"once"` allows this single run, `"always"` allows it and adds the program to
 * the persisted allowlist, `"cancel"` refuses (the step does not run).
 */
export type LocalProcessAuthDecision = "once" | "always" | "cancel";

/**
 * State backing the open workflow-parameter prompt (PROD-0040), or `null` when
 * none is open. Set when a run reaches a workflow that declares parameters; the
 * prompt collects a value per parameter (pre-filled from each `default`) and
 * resolves the pending promise with the collected values, or `null` when the
 * user cancels (the run then does not start).
 */
export interface WorkflowParamPromptState {
  /** The name of the workflow requesting values, for the prompt copy. */
  workflowName: string;
  /** The parameters to collect, in declaration order. */
  parameters: WorkflowParameter[];
  /** Resolver wired to the pending prompt promise (`null` = cancelled). */
  resolve: (values: WorkflowParamValues | null) => void;
}

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

/** Cancellation flag of the in-flight multi-target run (PROD-047). */
interface FanoutState {
  /** Set when the fan-out was cancelled or superseded; no queued target starts. */
  cancelled: boolean;
}

/** The in-flight multi-target run, or `null` when none is running. */
let activeFanout: FanoutState | null = null;

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
   * Persisted, metadata-only history of recent workflow runs (PROD-0046),
   * most-recent first. Populated by {@link loadWorkflowRuns} and refreshed as a
   * side effect of each finished run's fire-and-forget record.
   */
  workflowRuns: WorkflowRun[];
  /** Load the run history from the backend into the store. */
  loadWorkflowRuns: () => Promise<void>;
  /** Clear the persisted run history, then refresh the (now empty) list. */
  clearWorkflowRunHistory: () => Promise<void>;
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
   * Defaults the target to the active terminal tab; `targetTabIds` fans out
   * across several terminals concurrently (#3418). A fresh call cancels any
   * in-flight run (or fan-out) first. Surfaces a recoverable
   * toast when the workflow is missing/empty, the target terminal is not
   * connected, or a step fails.
   */
  runWorkflow: (workflowId: string, opts?: RunWorkflowOptions) => Promise<void>;
  /**
   * Cancel in-flight workflow runs. With no `runId`, cancels everything — every
   * running target of a fan-out, and no queued target starts (#3418). With a
   * `runId`, cancels just that one target's run; its siblings keep going.
   * Idempotent.
   */
  cancelWorkflowRun: (runId?: string) => void;
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
  /**
   * Pending workflow-parameter prompt (PROD-0040), or `null` when none is open.
   * Set when a run starts a workflow that declares parameters; resolved by the
   * user via the prompt dialog with the collected values (or `null` to cancel).
   */
  workflowParamPrompt: WorkflowParamPromptState | null;
  /** Resolve the open workflow-parameter prompt with collected values (or `null` to cancel). */
  resolveWorkflowParamPrompt: (values: WorkflowParamValues | null) => void;
}

export const createWorkflowsSlice: StateCreator<AppState, [], [], WorkflowsSlice> = (set, get) => ({
  // Workflows (#1852)
  workflows: [],

  loadWorkflows: async () => {
    try {
      const workflows = await apiListWorkflows();
      set({ workflows });
    } catch (err) {
      frontendLog("app_store", `Failed to load workflows: ${errorMessage(err)}`);
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

  workflowRuns: [],

  loadWorkflowRuns: async () => {
    try {
      const runs = await apiListWorkflowRuns();
      set({ workflowRuns: Array.isArray(runs) ? runs : [] });
    } catch (err) {
      frontendLog("app_store", `Failed to load workflow run history: ${errorMessage(err)}`);
    }
  },

  clearWorkflowRunHistory: async () => {
    const runs = await apiClearWorkflowRunHistory();
    set({ workflowRuns: Array.isArray(runs) ? runs : [] });
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

    // Resolve the target set: an explicit multi-target selection (PROD-047), an
    // explicit single tab, or the active terminal tab.
    const multi = opts?.targetTabIds !== undefined;
    const requested = multi
      ? [...new Set(opts.targetTabIds)]
      : [opts?.targetTabId ?? getActiveTab(state)?.id].filter((id): id is string => !!id);
    if (requested.length === 0) {
      toast.error(
        multi
          ? "No terminals selected to run the workflow against"
          : "No active terminal to run the workflow against"
      );
      return;
    }

    // Guard: only run against connected, non-exited terminal sessions. A
    // multi-target run skips (and reports) the ones that are not connected.
    const { targets, skipped } = resolveConnectedTargets(state, requested);
    if (targets.length === 0) {
      toast.error(
        multi && requested.length > 1
          ? "None of the selected terminals are connected"
          : "The target terminal is not connected"
      );
      return;
    }

    if (workflow.steps.length === 0) {
      toast.info(`Workflow "${workflow.name}" has no steps to run`);
      return;
    }

    // Collect declared parameter values before starting the run (PROD-0040) —
    // once for the whole run, shared by every target. Cancelling the prompt
    // aborts the run before any in-flight run is disturbed. A parameter-free
    // workflow skips this entirely and runs with an empty value map.
    let paramValues: WorkflowParamValues = {};
    const parameters = workflow.parameters ?? [];
    if (parameters.length > 0) {
      const collected = await new Promise<WorkflowParamValues | null>((resolve) => {
        set({
          workflowParamPrompt: { workflowName: workflow.name, parameters, resolve },
        });
      });
      set({ workflowParamPrompt: null });
      if (collected === null) {
        toast.info(`Workflow "${workflow.name}" cancelled`);
        return;
      }
      paramValues = collected;
    }

    // A fresh run supersedes any in-flight run (and fan-out): cancel them first.
    if (activeFanout) activeFanout.cancelled = true;
    replaceActiveWorkflowRun();

    const triggeredBy: WorkflowRunTrigger = opts?.triggeredBy ?? "manual";
    const base = { set, get, workflow, paramValues, triggeredBy };

    if (!multi) {
      const [target] = targets;
      await runWorkflowOnTarget({
        ...base,
        targetTabId: target.id,
        targetSessionId: target.sessionId,
      });
      return;
    }

    // Fan-out (PROD-047, #3418): run the targets concurrently — at most
    // `concurrency` at a time, the rest queued — under one shared per-target
    // status toast. Each target is an ordinary run (own run id, own history
    // record); a failure on one target never stops the others. Cancel-all stops
    // every running target and starts no queued one; a single target can be
    // cancelled on its own.
    const fanout: FanoutState = { cancelled: false };
    activeFanout = fanout;
    const toastId = `workflow-run-${workflowId}-fanout`;
    const statuses: FanoutTargetStatus[] = targets.map(() => "queued");
    const authDecisions = new Map<string, Promise<boolean>>();
    const title = `Running workflow "${workflow.name}" on ${targets.length} terminals…`;
    const renderProgress = (note?: string) => {
      const line = describeFanoutProgress(statuses);
      toast.loading(title, { id: toastId, description: note ? `${line} — ${note}` : line });
    };
    // One clean output panel for the whole fan-out; targets then preserve it.
    clearWorkflowOutputContent();
    void dispatchWorkflowDismissOutput();
    renderProgress();

    const results = await runWithConcurrency(
      targets,
      clampFanoutConcurrency(opts?.concurrency),
      async (target, index) => {
        statuses[index] = "running";
        renderProgress();
        const result = await runWorkflowOnTarget({
          ...base,
          targetTabId: target.id,
          targetSessionId: target.sessionId,
          targetLabel: target.title,
          fanout: {
            authDecisions,
            // A target whose run went live after cancel-all is stopped at once.
            onStart: (_runId, cancel) => {
              if (fanout.cancelled) cancel();
            },
            onProgress: (_completed, retryNote) =>
              renderProgress(retryNote ? `${target.title}: ${retryNote}` : undefined),
          },
        });
        statuses[index] = result.status;
        renderProgress();
        return result;
      },
      () => fanout.cancelled
    );
    const outcomes: FanoutOutcome[] = [];
    results.forEach((result, index) => {
      if (result) outcomes.push({ title: targets[index].title, result });
    });
    if (activeFanout === fanout) activeFanout = null;
    toastFanoutSummary(workflow.name, outcomes, targets.length, skipped, toastId);
  },

  cancelWorkflowRun: (runId) => {
    if (runId !== undefined) {
      cancelWorkflowRunById(runId);
      return;
    }
    if (activeFanout) activeFanout.cancelled = true;
    cancelAllWorkflowRuns();
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

  workflowParamPrompt: null,
  resolveWorkflowParamPrompt: (values) => {
    const prompt = get().workflowParamPrompt;
    if (!prompt) return;
    // Clear first so a second submit/cancel cannot double-resolve the promise.
    set({ workflowParamPrompt: null });
    prompt.resolve(values);
  },
});
