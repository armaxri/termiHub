/**
 * Workflow run engine (#1852) — the foundation of the Workflow Automation epic
 * (#1851).
 *
 * Generalises the macro playback scheduler ({@link "@/services/macroPlayback"})
 * from a homogeneous list of recorded input chunks to an ordered list of *typed*
 * {@link WorkflowStep}s. The runner walks the steps in order, dispatching each by
 * `kind` through an **injectable send seam** so it is fully unit-testable with a
 * mock and no live terminal — exactly the `inject` seam macro playback uses.
 *
 * Run lifecycle (per the concept's state machine): a run is created in an
 * implicit *pending* state, transitions to *running* as it walks the steps, and
 * ends in exactly one terminal state — **completed** (last step done),
 * **cancelled** (the caller cancelled between steps), or **failed** (a step's
 * seam reported failure, or the step kind is not yet executable). Cancellation is
 * honoured between steps: a step already in flight finishes, then the run stops
 * before the next step begins.
 *
 * Only the `send-command` step executes in this foundation PR. The remaining v1
 * step kinds (`run-script`, `run-macro`, `wait`, `run-local-process`) are
 * clearly-marked dispatch placeholders that fail loudly until their owning child
 * issues wire them up:
 *  - #1853 — `run-script`, `run-macro`, `wait` (the latter reuses
 *    `macroPlayback.MAX_STEP_DELAY_MS` to clamp its delay).
 *  - #1857 — `run-local-process` (guarded, security-critical).
 * Later children extend the runner by adding their seam to
 * {@link WorkflowRunnerDeps} and replacing the placeholder in {@link executeStep}.
 */

import type { WorkflowStep } from "@/types/workflow";

/** Terminal outcome of a workflow run (the state machine's end states). */
export type WorkflowRunStatus = "completed" | "cancelled" | "failed";

/** Result of a finished workflow run. */
export interface WorkflowRunResult {
  /** Which terminal state the run ended in. */
  status: WorkflowRunStatus;
  /** Number of steps that completed successfully before the run ended. */
  stepsCompleted: number;
  /** For `failed`: the 0-based index of the step that failed. */
  failedStepIndex?: number;
  /** For `failed`: a human-readable reason. */
  error?: string;
}

/**
 * The single send seam every send-based step routes through — the same
 * `send_input` choke point macro playback uses. Resolves `true` when the input
 * was delivered, `false` when the target session has vanished.
 */
export type WorkflowSendSeam = (data: string) => Promise<boolean> | boolean;

/**
 * Injectable dependencies the runner dispatches steps through. `send` is the only
 * seam the foundation requires; later children add optional seams here (e.g. a
 * macro-playback runner for `run-macro`, a guarded local-process spawner for
 * `run-local-process`) alongside their dispatch handler in {@link executeStep}.
 */
export interface WorkflowRunnerDeps {
  /** Injects text into the target session (the `send_input` seam). */
  send: WorkflowSendSeam;
}

/** Optional lifecycle hooks fired as a run advances. */
export interface WorkflowRunHooks {
  /** Fired after each step completes, with the 1-based count, total, and step. */
  onProgress?: (completed: number, total: number, step: WorkflowStep) => void;
}

/** A running workflow that can be awaited or cancelled. */
export interface WorkflowRunHandle {
  /** Resolves when the run finishes (completed, cancelled, or failed). */
  done: Promise<WorkflowRunResult>;
  /** Request cancellation; the run stops before the next step begins. */
  cancel: () => void;
}

/** Outcome of executing a single step. */
type StepOutcome = { ok: true } | { ok: false; error: string };

/** Line terminator appended to an authored `send-command`; the `send_input` seam
 * normalises it to the session's configured line ending. */
const COMMAND_TERMINATOR = "\n";

/**
 * Error message for a step kind that is defined in the model but not yet
 * executable in the foundation. Surfacing it as a step failure (rather than a
 * silent skip) means a workflow authored with a not-yet-wired step fails loudly
 * at that step until the owning child issue implements it.
 */
function notYetImplemented(kind: WorkflowStep["kind"]): StepOutcome {
  return { ok: false, error: `workflow step kind "${kind}" is not yet implemented` };
}

/**
 * Execute a single workflow step by dispatching on its `kind`. The `switch` is
 * exhaustive over the {@link WorkflowStep} union (the `never` default is a
 * compile-time guard), so adding a step kind to the model forces a matching
 * dispatch entry here.
 */
export async function executeStep(
  step: WorkflowStep,
  deps: WorkflowRunnerDeps
): Promise<StepOutcome> {
  switch (step.kind) {
    case "send-command": {
      const delivered = await deps.send(step.command + COMMAND_TERMINATOR);
      return delivered
        ? { ok: true }
        : { ok: false, error: "the target terminal is no longer connected" };
    }
    // --- Placeholders wired by later epic children (see module docs). ---
    case "run-script": // #1853
    case "run-macro": // #1853
    case "wait": // #1853
    case "run-local-process": // #1857
      return notYetImplemented(step.kind);
    default: {
      // Exhaustiveness guard: a new step kind must add a case above.
      const _exhaustive: never = step;
      return { ok: false, error: `unknown workflow step kind: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/**
 * Run a workflow's steps in order through `deps`, honouring cancellation and
 * reporting progress. Returns a {@link WorkflowRunHandle} whose `done` promise
 * resolves once the run reaches a terminal state.
 *
 * Cancellation is checked before each step: a step already in flight finishes,
 * then the run stops before the next step begins (status `cancelled`). If a
 * step's seam reports failure — or the step kind is not yet executable — the run
 * stops immediately with status `failed` and records the offending step.
 */
export function runWorkflow(
  steps: WorkflowStep[],
  deps: WorkflowRunnerDeps,
  hooks?: WorkflowRunHooks
): WorkflowRunHandle {
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
  };

  const done = (async (): Promise<WorkflowRunResult> => {
    // Yield once before the first step so a cancel() issued synchronously right
    // after this handle is returned lands before any step runs — a run cancelled
    // before it starts does nothing.
    await Promise.resolve();
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) return { status: "cancelled", stepsCompleted: i };

      const outcome = await executeStep(steps[i], deps);
      if (!outcome.ok) {
        return {
          status: "failed",
          stepsCompleted: i,
          failedStepIndex: i,
          error: outcome.error,
        };
      }

      hooks?.onProgress?.(i + 1, steps.length, steps[i]);
    }
    return { status: "completed", stepsCompleted: steps.length };
  })();

  return { done, cancel };
}
