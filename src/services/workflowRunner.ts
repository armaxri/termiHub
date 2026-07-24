/**
 * Workflow run engine — the foundation (#1852) of the Workflow Automation epic
 * (#1851), extended with the remaining v1 terminal-native step types (#1853).
 *
 * Generalises the macro playback scheduler ({@link "@/services/macroPlayback"})
 * from a homogeneous list of recorded input chunks to an ordered list of *typed*
 * {@link WorkflowStep}s. The runner walks the steps in order, dispatching each by
 * `kind` through **injectable seams** so it is fully unit-testable with mocks and
 * no live terminal — exactly the `inject` seam macro playback uses.
 *
 * Run lifecycle (per the concept's state machine): a run is created in an
 * implicit *pending* state, transitions to *running* as it walks the steps, and
 * ends in exactly one terminal state — **completed** (last step done),
 * **cancelled** (the caller cancelled between steps, or a multi-line step
 * observed the cancel and aborted its remaining sends), or **failed** (a step's
 * seam reported failure, or the step kind is not yet executable). Cancellation is
 * honoured between steps; the multi-line `run-script` step additionally checks it
 * at each line boundary, so a cancel aborts its remaining line injections.
 *
 * Executable step kinds and the seam each routes through:
 *  - `send-command` / `run-script` — the `send_input` seam ({@link WorkflowRunnerDeps.send}).
 *  - `run-macro` — the macro-playback replay seam ({@link WorkflowRunnerDeps.runMacro}).
 *  - `wait` / `run-script` inter-line delays — the timer seam
 *    ({@link WorkflowRunnerDeps.wait}), with every delay clamped to
 *    {@link "@/services/macroPlayback".MAX_STEP_DELAY_MS} exactly as macro
 *    playback clamps its own delays.
 *
 * `run-local-process` (guarded, security-critical) is wired by #1857. It routes
 * through **two** seams — {@link WorkflowRunnerDeps.authorizeLocalProcess} and
 * {@link WorkflowRunnerDeps.runLocalProcess} — and is fail-closed: absent an
 * authorize seam, or when authorization is refused, the process is **never
 * spawned** and the step fails. Only an explicit `true` from the authorize seam
 * lets the run seam spawn the program.
 */

import { MAX_STEP_DELAY_MS } from "@/services/macroPlayback";
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
 * Replays a stored macro by id via the macro-playback service, reusing the
 * macro's own timing mode. Resolves `true` when the macro replayed to
 * completion, `false` when it was missing, empty, or the target session vanished.
 */
export type WorkflowRunMacroSeam = (macroId: string) => Promise<boolean> | boolean;

/**
 * Sleeps for `ms` milliseconds before resolving — the scheduler timer both the
 * `wait` step and the `run-script` inter-line delay route through. Injectable so
 * tests can assert the (already clamped) delay without real time passing.
 */
export type WorkflowWaitSeam = (ms: number) => Promise<void> | void;

/**
 * Reads a script body from an on-disk path (the `run-script` `sourcePath`
 * affordance). Resolves the file's UTF-8 contents; rejects when it cannot be
 * read, in which case the runner falls back to the step's embedded `script`.
 */
export type WorkflowReadFileSeam = (path: string) => Promise<string>;

/**
 * Terminal outcome of a spawned local process, surfaced to the runner. `exitCode`
 * is `null` when the process was killed before it could report one (cancelled or
 * timed out).
 */
export interface LocalProcessResult {
  /** The process exit code, or `null` when it was killed. */
  exitCode: number | null;
  /** `true` when the process was killed for exceeding its timeout. */
  timedOut: boolean;
  /** `true` when the process was killed because the run was cancelled. */
  cancelled: boolean;
}

/** Options threaded into a local-process spawn so it can observe cancellation. */
export interface LocalProcessRunOptions {
  /** A cancel poll: when it flips true, the seam kills the process. */
  signal?: WorkflowStepSignal;
}

/**
 * The **authorization gate** for a `run-local-process` step (#1857). Resolves
 * `true` only when the user has both opted in *and* authorized this specific
 * program (via a persisted allowlist or an interactive confirmation). The runner
 * treats every other resolution — `false`, or the seam being absent — as "not
 * authorized" and refuses to spawn. This is the security choke point: nothing
 * runs a local process without a `true` from here first.
 */
export type WorkflowAuthorizeLocalProcessSeam = (
  program: string,
  args: string[]
) => Promise<boolean> | boolean;

/**
 * Spawns an authorized local program with the discrete `args` (never a shell),
 * streaming its output to an observable surface, bounded by a timeout, and
 * killable when the run is cancelled. Resolves the process outcome. Only ever
 * called after {@link WorkflowAuthorizeLocalProcessSeam} resolves `true`.
 */
export type WorkflowRunLocalProcessSeam = (
  program: string,
  args: string[],
  options: LocalProcessRunOptions
) => Promise<LocalProcessResult>;

/**
 * Injectable dependencies the runner dispatches steps through. `send` is the only
 * required seam; the rest back a specific step kind and are optional so a step
 * kind that never appears needs no seam (and isolated unit tests can inject just
 * what they exercise). A step whose seam is absent fails loudly at that step.
 */
export interface WorkflowRunnerDeps {
  /** Injects text into the target session (the `send_input` seam). */
  send: WorkflowSendSeam;
  /** Replays a stored macro by id (the `run-macro` seam). */
  runMacro?: WorkflowRunMacroSeam;
  /** Sleeps for a (clamped) number of ms (the `wait` / inter-line-delay seam). */
  wait?: WorkflowWaitSeam;
  /** Reads a script body from disk (the `run-script` `sourcePath` seam). */
  readScriptFile?: WorkflowReadFileSeam;
  /**
   * Authorizes a `run-local-process` step before it runs (#1857). Absent → the
   * step is never authorized and never spawns.
   */
  authorizeLocalProcess?: WorkflowAuthorizeLocalProcessSeam;
  /** Spawns an authorized local process (#1857). */
  runLocalProcess?: WorkflowRunLocalProcessSeam;
}

/** A poll the runner threads into a step so long/multi-part steps can abort. */
export interface WorkflowStepSignal {
  /** `true` once the owning run has been cancelled. */
  isCancelled: () => boolean;
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

/**
 * Outcome of executing a single step. `cancelled` marks a multi-part step (i.e.
 * `run-script`) that observed the cancel and aborted mid-flight — the run ends
 * `cancelled` without counting that step as completed.
 */
type StepOutcome = { ok: true; cancelled?: boolean } | { ok: false; error: string };

/** Line terminator appended to each sent line; the `send_input` seam normalises
 * it to the session's configured line ending. */
const LINE_TERMINATOR = "\n";

/** Error surfaced when a session vanishes mid-send. */
const SESSION_GONE = "the target terminal is no longer connected";

/**
 * Clamp a caller-authored delay to `[0, MAX_STEP_DELAY_MS]` (and treat a
 * non-finite value as 0), matching the guard macro playback applies so a single
 * `wait` or per-line delay can never appear to hang the run for minutes.
 */
function clampDelay(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(ms, MAX_STEP_DELAY_MS));
}

/** Default timer seam: a real `setTimeout` sleep (no-op for non-positive ms). */
function defaultWait(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep for `ms` through the injected timer seam, or the real timer by default. */
async function sleepFor(ms: number, deps: WorkflowRunnerDeps): Promise<void> {
  await (deps.wait ?? defaultWait)(ms);
}

/**
 * Split a script body into the lines to stream. Newlines of any flavour split
 * lines; a single trailing empty line produced by a terminating newline is
 * dropped so `"a\nb\n"` streams two commands, not two plus a blank enter.
 * Interior blank lines are preserved.
 */
function splitScriptLines(script: string): string[] {
  const lines = script.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Resolve a `run-script` step's body: read it fresh from `sourcePath` when both
 * the path and a read seam are present, falling back to the step's embedded
 * `script` when there is no path/seam or the read fails.
 */
async function resolveScriptBody(
  step: Extract<WorkflowStep, { kind: "run-script" }>,
  deps: WorkflowRunnerDeps
): Promise<string> {
  if (!step.sourcePath || !deps.readScriptFile) return step.script;
  try {
    return await deps.readScriptFile(step.sourcePath);
  } catch {
    return step.script;
  }
}

/**
 * Execute a single workflow step by dispatching on its `kind`. The `switch` is
 * exhaustive over the {@link WorkflowStep} union (the `never` default is a
 * compile-time guard), so adding a step kind to the model forces a matching
 * dispatch entry here.
 *
 * `signal` lets a long or multi-part step abort when the run is cancelled; it is
 * optional so a step can be unit-tested in isolation without a run around it.
 */
export async function executeStep(
  step: WorkflowStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal
): Promise<StepOutcome> {
  const cancelled = (): boolean => signal?.isCancelled() ?? false;

  switch (step.kind) {
    case "send-command": {
      const delivered = await deps.send(step.command + LINE_TERMINATOR);
      return delivered ? { ok: true } : { ok: false, error: SESSION_GONE };
    }
    case "run-script": {
      const lines = splitScriptLines(await resolveScriptBody(step, deps));
      const perLineDelay = clampDelay(step.perLineDelayMs);
      for (let i = 0; i < lines.length; i++) {
        if (cancelled()) return { ok: true, cancelled: true };
        if (i > 0 && perLineDelay > 0) await sleepFor(perLineDelay, deps);
        if (cancelled()) return { ok: true, cancelled: true };
        const delivered = await deps.send(lines[i] + LINE_TERMINATOR);
        if (!delivered) return { ok: false, error: SESSION_GONE };
      }
      return { ok: true };
    }
    case "run-macro": {
      if (!deps.runMacro) {
        return { ok: false, error: 'the "run-macro" step requires a macro-playback seam' };
      }
      const replayed = await deps.runMacro(step.macroId);
      return replayed
        ? { ok: true }
        : { ok: false, error: `macro "${step.macroId}" could not be replayed` };
    }
    case "wait": {
      await sleepFor(clampDelay(step.delayMs), deps);
      return { ok: true };
    }
    case "run-local-process": {
      // Guarded, security-critical (#1857). Fail-closed at every gate.
      if (!deps.runLocalProcess) {
        return { ok: false, error: 'the "run-local-process" step requires a local-process seam' };
      }
      // GUARDRAIL: never spawn without explicit authorization. Absent seam or a
      // refusal both mean "not authorized" — the process is never spawned.
      const authorized = deps.authorizeLocalProcess
        ? await deps.authorizeLocalProcess(step.program, step.args)
        : false;
      if (!authorized) {
        return {
          ok: false,
          error: `local process "${step.program}" is not authorized to run`,
        };
      }
      // A cancel observed before the spawn aborts the run without spawning.
      if (cancelled()) return { ok: true, cancelled: true };

      const result = await deps.runLocalProcess(step.program, step.args, { signal });
      if (result.cancelled) return { ok: true, cancelled: true };
      if (result.timedOut) {
        return { ok: false, error: `local process "${step.program}" timed out` };
      }
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        error: `local process "${step.program}" exited with code ${result.exitCode ?? "unknown"}`,
      };
    }
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
 * Cancellation is checked before each step and again after it: a `send-command`,
 * `run-macro`, or `wait` already in flight finishes and counts as completed,
 * then the run stops before the next step begins (status `cancelled`). A
 * `run-script` that observes the cancel between its lines aborts its remaining
 * sends and is *not* counted as completed. If a step's seam reports failure — or
 * the step kind is not yet executable — the run stops immediately with status
 * `failed` and records the offending step.
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

  const signal: WorkflowStepSignal = { isCancelled: () => cancelled };

  const done = (async (): Promise<WorkflowRunResult> => {
    // Yield once before the first step so a cancel() issued synchronously right
    // after this handle is returned lands before any step runs — a run cancelled
    // before it starts does nothing.
    await Promise.resolve();
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) return { status: "cancelled", stepsCompleted: i };

      const outcome = await executeStep(steps[i], deps, signal);
      if (!outcome.ok) {
        return {
          status: "failed",
          stepsCompleted: i,
          failedStepIndex: i,
          error: outcome.error,
        };
      }
      // A multi-part step that aborted mid-flight on cancel: end the run without
      // counting it as completed and without firing its progress hook.
      if (outcome.cancelled) return { status: "cancelled", stepsCompleted: i };

      hooks?.onProgress?.(i + 1, steps.length, steps[i]);
    }
    return { status: "completed", stepsCompleted: steps.length };
  })();

  return { done, cancel };
}
