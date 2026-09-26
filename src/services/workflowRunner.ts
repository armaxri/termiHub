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
import type { WorkflowCondition, WorkflowStep, WorkflowStepRetry } from "@/types/workflow";
import { frontendWarn } from "@/utils/frontendLog";

/**
 * Maximum nesting depth of `conditional` steps the runner will descend into
 * (PROD-0044). A conditional whose `then`/`else` reaches this depth fails its
 * run rather than recursing further, bounding an authoring loop (a conditional
 * that nests itself) so it can never blow the stack. Top-level steps are depth
 * 0; each conditional branch entered adds 1.
 */
export const MAX_CONDITIONAL_DEPTH = 10;

/**
 * Maximum nesting depth of `loop` steps the runner will descend into (PROD-044),
 * the loop analogue of {@link MAX_CONDITIONAL_DEPTH}. A loop whose `body` nests
 * this deep fails its run rather than recursing further, bounding an authoring
 * loop (a loop that nests itself) so it can never blow the stack. Shares the
 * same value as the conditional bound — both cap the depth of nested step lists.
 */
export const MAX_LOOP_DEPTH = MAX_CONDITIONAL_DEPTH;

/**
 * Maximum number of iterations a single `loop` step will run (PROD-044). A
 * `count` loop is clamped to this; a `while` loop that reaches it **fails** the
 * run rather than spinning forever, so a mis-authored always-true condition can
 * never hang a run (ventilator-grade). A named constant so the cap is explicit.
 */
export const MAX_LOOP_ITERATIONS = 1000;

/**
 * The reserved parameter name a `loop` step exposes to its `body` and (for a
 * `while` loop) its condition: the current 0-based iteration index, as a string
 * (PROD-044). It is interpolated like any `${name}` reference, so a body step
 * can echo `${iteration}` and a while-condition can compare `${iteration}` — the
 * dynamic operand a structured while-loop needs, since a run's declared
 * parameters are otherwise fixed for the whole run.
 */
export const LOOP_ITERATION_PARAM = "iteration";

/**
 * Maximum number of retries a single step's {@link WorkflowStepRetry} policy may
 * request (PROD-045). A larger `count` is clamped to this, so a step runs at most
 * `MAX_STEP_RETRIES + 1` times — a mis-authored policy can never retry forever.
 */
export const MAX_STEP_RETRIES = 10;

/**
 * Maximum delay (ms) the runner waits between two attempts of a retried step
 * (PROD-045). Both the authored `delayMs` and every exponential-backoff step are
 * clamped to this, so a retry policy can never stall a run for hours.
 */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * The number of retries a step's policy actually grants (PROD-045): the
 * authored `count` floored and clamped to `[0, MAX_STEP_RETRIES]`; an absent
 * policy or a non-finite count grants none. A **pure** helper.
 */
export function effectiveRetryCount(retry: WorkflowStepRetry | undefined): number {
  if (!retry || !Number.isFinite(retry.count)) return 0;
  return Math.max(0, Math.min(Math.floor(retry.count), MAX_STEP_RETRIES));
}

/**
 * The delay (ms) to wait before retry number `retryNumber` (1-based) of a step
 * (PROD-045). `fixed` backoff always waits `delayMs`; `exponential` doubles it
 * per retry (`delayMs × 2^(retryNumber-1)`). The result is clamped to
 * `[0, MAX_RETRY_DELAY_MS]`, and an absent/non-finite delay means "retry
 * immediately". A **pure** helper.
 */
export function retryDelayMs(retry: WorkflowStepRetry | undefined, retryNumber: number): number {
  const base = retry?.delayMs;
  if (base === undefined || !Number.isFinite(base) || base <= 0) return 0;
  const clampedBase = Math.min(base, MAX_RETRY_DELAY_MS);
  if (retry?.backoff !== "exponential") return clampedBase;
  const exponent = Math.max(0, retryNumber - 1);
  return Math.min(clampedBase * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

/** Default timeout (ms) for a `wait-for-output` step when it declares none. */
export const WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap (ms) a `wait-for-output` timeout is clamped to, so the step can
 * never wait longer than this even if a larger value is authored. */
export const WAIT_FOR_OUTPUT_MAX_TIMEOUT_MS = 600_000;

/** A resolved `wait-for-output` matcher: the pattern plus whether it is a regex. */
export interface WaitForOutputMatcher {
  /** The pattern to test terminal output against. */
  pattern: string;
  /** When `true`, `pattern` is a regular expression; otherwise a literal substring. */
  isRegex: boolean;
}

/**
 * Test whether accumulated terminal `text` satisfies a `wait-for-output` matcher
 * (PROD-044) — a **pure**, total predicate. A substring matcher uses
 * `String.includes`; a regex matcher tests a fresh `RegExp` and treats an
 * invalid pattern as a non-match (the runner rejects an invalid regex up front,
 * so this is only a defensive fallback).
 */
export function matchesOutput(text: string, matcher: WaitForOutputMatcher): boolean {
  if (matcher.isRegex) {
    try {
      return new RegExp(matcher.pattern).test(text);
    } catch {
      return false;
    }
  }
  return text.includes(matcher.pattern);
}

/**
 * Evaluate a {@link WorkflowCondition} to the branch it selects (PROD-0044).
 *
 * A **pure**, total comparison over the operands *as already resolved* — any
 * `${param}` references are interpolated by {@link resolveStepParams} before the
 * step reaches here, so this compares plain strings:
 *  - `eq`/`ne` — string (in)equality.
 *  - `gt`/`lt`/`gte`/`lte` — numeric comparison when **both** operands parse as
 *    finite numbers, lexicographic string comparison otherwise.
 *  - `contains` — `left` contains `right` as a substring.
 */
export function evaluateCondition(condition: WorkflowCondition): boolean {
  const { left, op, right } = condition;
  // Ordering used by the relational operators: numeric when both sides are
  // finite numbers, lexicographic otherwise. Returns -1 | 0 | 1.
  const order = (): number => {
    const l = Number(left);
    const r = Number(right);
    if (Number.isFinite(l) && Number.isFinite(r)) return l < r ? -1 : l > r ? 1 : 0;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  switch (op) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "gt":
      return order() > 0;
    case "lt":
      return order() < 0;
    case "gte":
      return order() >= 0;
    case "lte":
      return order() <= 0;
    default: {
      // Exhaustiveness guard: a new operator must add a case above.
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/** Terminal outcome of a workflow run (the state machine's end states). */
export type WorkflowRunStatus = "completed" | "cancelled" | "failed";

/**
 * A step failure the run tolerated because the step was marked
 * `continueOnError` (PROD-045).
 */
export interface WorkflowToleratedFailure {
  /** The 0-based index of the top-level step the failure occurred in. */
  stepIndex: number;
  /** The failure reason of the step's final attempt. */
  error: string;
  /** How many times the step was attempted (1 + retries used). */
  attempts: number;
}

/** Result of a finished workflow run. */
export interface WorkflowRunResult {
  /** Which terminal state the run ended in. */
  status: WorkflowRunStatus;
  /**
   * Number of top-level steps the run got past before it ended. A step whose
   * failure was tolerated via `continueOnError` counts as got-past (PROD-045).
   */
  stepsCompleted: number;
  /** For `failed`: the 0-based index of the step that failed. */
  failedStepIndex?: number;
  /** For `failed`: a human-readable reason. */
  error?: string;
  /**
   * Id of the persisted run-history record (PROD-0046) of this run. Set by the
   * store-level runner once the record is written; the engine never sets it.
   */
  historyRunId?: string;
  /**
   * Step failures tolerated via `continueOnError` (PROD-045), in the order they
   * happened. Absent when no failure was tolerated, so a run of a workflow that
   * uses no error handling reports exactly the same result shape as before.
   */
  continuedFailures?: WorkflowToleratedFailure[];
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

/** Terminal outcome of a `wait-for-output` step, surfaced to the runner. Exactly
 * one of `matched` / `timedOut` / `cancelled` is `true`. */
export interface WaitForOutputResult {
  /** `true` when the session output matched the pattern before the timeout. */
  matched: boolean;
  /** `true` when the timeout elapsed with no match. */
  timedOut: boolean;
  /** `true` when the run was cancelled while the step was waiting. */
  cancelled: boolean;
}

/**
 * Waits until the target session's terminal output matches `matcher`, or
 * `timeoutMs` elapses, or the run is cancelled (PROD-044). Injectable so the
 * runner stays pure and unit-testable — the real seam (wired in the store)
 * subscribes to the existing `terminal-output` event for the target session and
 * tests the accumulated text with {@link matchesOutput}.
 */
export type WorkflowWaitForOutputSeam = (
  matcher: WaitForOutputMatcher,
  timeoutMs: number,
  options: { signal?: WorkflowStepSignal }
) => Promise<WaitForOutputResult>;

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
  /**
   * Waits for the target session's terminal output to match a pattern, or a
   * timeout (PROD-044). Absent → a `wait-for-output` step fails loudly.
   */
  waitForOutput?: WorkflowWaitForOutputSeam;
}

/** A poll the runner threads into a step so long/multi-part steps can abort. */
export interface WorkflowStepSignal {
  /** `true` once the owning run has been cancelled. */
  isCancelled: () => boolean;
  /**
   * Optional promise that resolves the moment the run is cancelled. A retry
   * back-off wait races it so a cancel interrupts the wait immediately instead
   * of after the full delay (PROD-045). Absent → the wait runs to completion and
   * the cancel is observed right after it.
   */
  whenCancelled?: Promise<void>;
}

/** A retry of a failing step is about to be attempted (PROD-045). */
export interface WorkflowStepRetryEvent {
  /** The 0-based index of the top-level step this (possibly nested) step is in. */
  stepIndex: number;
  /** The step that failed and will be retried. */
  step: WorkflowStep;
  /** The attempt that just failed (1-based). */
  failedAttempt: number;
  /** The total attempts the policy allows (1 + effective retries). */
  maxAttempts: number;
  /** Why the attempt failed. */
  error: string;
  /** How long (ms) the runner waits before the next attempt. */
  delayMs: number;
}

/** A failing step was tolerated via `continueOnError` (PROD-045). */
export interface WorkflowStepContinuedEvent {
  /** The 0-based index of the top-level step this (possibly nested) step is in. */
  stepIndex: number;
  /** The step whose failure was tolerated. */
  step: WorkflowStep;
  /** The failure reason of the final attempt. */
  error: string;
  /** How many times the step was attempted. */
  attempts: number;
}

/** Optional lifecycle hooks fired as a run advances. */
export interface WorkflowRunHooks {
  /** Fired after each step completes, with the 1-based count, total, and step. */
  onProgress?: (completed: number, total: number, step: WorkflowStep) => void;
  /** Fired before a failing step is retried (PROD-045). */
  onStepRetry?: (event: WorkflowStepRetryEvent) => void;
  /** Fired when a failing step is tolerated via `continueOnError` (PROD-045). */
  onStepContinued?: (event: WorkflowStepContinuedEvent) => void;
}

/**
 * Per-run bookkeeping threaded through {@link executeStep} so the error-handling
 * policy of nested steps (inside a conditional/loop) reports into the same run
 * (PROD-045). Optional: an isolated `executeStep` call runs without it.
 */
export interface WorkflowPolicyContext {
  /** The 0-based index of the top-level step currently executing. */
  stepIndex: number;
  /** Hooks to notify about retries and tolerated failures. */
  hooks?: WorkflowRunHooks;
  /** Collected tolerated failures, appended in order. */
  continuedFailures: WorkflowToleratedFailure[];
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

/**
 * Clamp a caller-authored `wait-for-output` timeout to `[0, WAIT_FOR_OUTPUT_MAX_TIMEOUT_MS]`,
 * substituting {@link WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS} for an absent or
 * non-finite value, so the step always has a bounded, sane timeout.
 */
function clampWaitTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.min(ms, WAIT_FOR_OUTPUT_MAX_TIMEOUT_MS));
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
 * Sleep for `ms` unless the run is cancelled first (PROD-045 retry back-off).
 * Races the timer seam against {@link WorkflowStepSignal.whenCancelled} so a
 * cancel interrupts the wait immediately. Resolves `true` when the run was
 * cancelled (before, during, or right after the wait), `false` otherwise.
 */
async function sleepUnlessCancelled(
  ms: number,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal
): Promise<boolean> {
  const cancelled = (): boolean => signal?.isCancelled() ?? false;
  if (cancelled()) return true;
  if (ms > 0) {
    const sleep = Promise.resolve(sleepFor(ms, deps));
    await (signal?.whenCancelled ? Promise.race([sleep, signal.whenCancelled]) : sleep);
  }
  return cancelled();
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
 * Run-time values for a workflow's declared parameters (PROD-0040), keyed by
 * parameter name. An empty map means "no parameters" — {@link resolveStepParams}
 * is then a strict identity pass, so a workflow that declares no parameters
 * behaves byte-identically to before this feature.
 */
export type WorkflowParamValues = Record<string, string | number | boolean>;

/** Matches a `$${` escape (literal `${`) or a `${name}` reference token. */
const PARAM_TOKEN = /\$\$\{|\$\{([^}]*)\}/g;

/**
 * Interpolate `${name}` parameter references in `text` (PROD-0040).
 *
 * Substitution rules — this is a **pure** transform:
 *  - `$${` is an escape for a literal `${` (never a reference); it is emitted
 *    verbatim as `${` and the emitted text is not re-scanned.
 *  - `${name}` is replaced with `paramValues[name]` (stringified) only when
 *    `name` is a declared parameter (present as a key in `paramValues`).
 *  - An **unknown** `${x}` (not a declared parameter) is left VERBATIM and
 *    reported through `onUnknownParam` so the caller can warn; the run never
 *    fails over it. This tolerates the collision with shell `${VAR}` syntax.
 */
export function interpolateParams(
  text: string,
  paramValues: WorkflowParamValues,
  onUnknownParam?: (name: string) => void
): string {
  return text.replace(PARAM_TOKEN, (match, name?: string) => {
    // `$${` escape → literal `${`. The replaced text is not re-scanned by
    // String.replace, so the emitted `${` can never start a new reference.
    if (name === undefined) return "${";
    if (Object.prototype.hasOwnProperty.call(paramValues, name)) {
      return String(paramValues[name]);
    }
    onUnknownParam?.(name);
    return match;
  });
}

/**
 * Apply parameter substitution to a step's text fields (PROD-0040), returning a
 * new step with `${name}` references resolved. A **pure** transform, applied as
 * a distinct pass ahead of {@link executeStep}'s dispatch switch.
 *
 * When `paramValues` is empty this is a strict identity: the exact same step
 * reference is returned, so a workflow with no declared parameters incurs no
 * observable interpolation pass. Only the send-based text fields carry
 * references — `send-command.command`, `run-script.script`, and
 * `run-local-process.program`/`args`; `run-macro`, `wait`, and the non-text
 * fields of the others are returned unchanged.
 */
export function resolveStepParams(
  step: WorkflowStep,
  paramValues: WorkflowParamValues,
  onUnknownParam?: (name: string) => void
): WorkflowStep {
  // Identity fast-path: no declared parameters → no interpolation at all.
  if (Object.keys(paramValues).length === 0) return step;
  const sub = (text: string): string => interpolateParams(text, paramValues, onUnknownParam);
  switch (step.kind) {
    case "send-command":
      return { ...step, command: sub(step.command) };
    case "run-script":
      return { ...step, script: sub(step.script) };
    case "run-local-process":
      return { ...step, program: sub(step.program), args: step.args.map(sub) };
    case "conditional":
      // Resolve only the condition operands here; the `then`/`else` sub-steps
      // are resolved individually when the conditional arm executes them (each
      // through its own pass), so they are left untouched by this shallow pass.
      return {
        ...step,
        condition: {
          ...step.condition,
          left: sub(step.condition.left),
          right: sub(step.condition.right),
        },
      };
    case "wait-for-output":
      // Only the pattern carries `${param}` references; the flags/timeout are
      // plain scalars. Resolved once here (the pattern does not reference the
      // per-iteration `${iteration}`, which is a loop-body concept).
      return { ...step, pattern: sub(step.pattern) };
    case "loop":
      // Leave the loop untouched by this shallow pass: its while-condition and
      // body steps are resolved during execution against a per-iteration map
      // that adds the reserved `${iteration}` value (mirroring how a
      // conditional's sub-steps are resolved when the arm executes them).
      return step;
    case "run-macro":
    case "wait":
      return step;
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
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
 *
 * `paramValues` (PROD-0040) feeds a distinct parameter-substitution pass applied
 * before the dispatch switch: `${name}` references in the step's text fields are
 * resolved against it. It is optional and defaults to empty, which makes the
 * pass a strict identity so a parameter-free workflow is unaffected.
 */
export async function executeStep(
  step: WorkflowStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal,
  paramValues?: WorkflowParamValues,
  depth = 0,
  policy?: WorkflowPolicyContext
): Promise<StepOutcome> {
  const cancelled = (): boolean => signal?.isCancelled() ?? false;

  // Distinct substitution pass ahead of the dispatch switch. Identity when no
  // parameter values are supplied, so the switch below is unchanged for a
  // parameter-free workflow.
  const resolved = resolveStepParams(step, paramValues ?? {}, (name) =>
    frontendWarn(
      "workflow",
      `parameter "\${${name}}" is not declared by this workflow; leaving it literal`
    )
  );

  switch (resolved.kind) {
    case "send-command": {
      const delivered = await deps.send(resolved.command + LINE_TERMINATOR);
      return delivered ? { ok: true } : { ok: false, error: SESSION_GONE };
    }
    case "run-script": {
      const lines = splitScriptLines(await resolveScriptBody(resolved, deps));
      const perLineDelay = clampDelay(resolved.perLineDelayMs);
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
      const replayed = await deps.runMacro(resolved.macroId);
      return replayed
        ? { ok: true }
        : { ok: false, error: `macro "${resolved.macroId}" could not be replayed` };
    }
    case "wait": {
      await sleepFor(clampDelay(resolved.delayMs), deps);
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
        ? await deps.authorizeLocalProcess(resolved.program, resolved.args)
        : false;
      if (!authorized) {
        return {
          ok: false,
          error: `local process "${resolved.program}" is not authorized to run`,
        };
      }
      // A cancel observed before the spawn aborts the run without spawning.
      if (cancelled()) return { ok: true, cancelled: true };

      const result = await deps.runLocalProcess(resolved.program, resolved.args, { signal });
      if (result.cancelled) return { ok: true, cancelled: true };
      if (result.timedOut) {
        return { ok: false, error: `local process "${resolved.program}" timed out` };
      }
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        error: `local process "${resolved.program}" exited with code ${result.exitCode ?? "unknown"}`,
      };
    }
    case "conditional": {
      // Bound nesting before descending so a conditional that nests itself
      // (an authoring loop) fails fast instead of blowing the stack.
      if (depth >= MAX_CONDITIONAL_DEPTH) {
        return {
          ok: false,
          error: `conditional nesting exceeds the maximum depth of ${MAX_CONDITIONAL_DEPTH}`,
        };
      }
      // The operands were interpolated by the substitution pass above, so the
      // comparison is over resolved values. A false condition with no `else`
      // selects an empty branch — a no-op that never fails the run.
      const branch = evaluateCondition(resolved.condition) ? resolved.then : (resolved.else ?? []);
      for (const child of branch) {
        if (cancelled()) return { ok: true, cancelled: true };
        // Sub-steps run through their own substitution pass; forward the raw
        // (un-substituted) paramValues, not the resolved ones.
        const outcome = await executeStepWithPolicy(
          child,
          deps,
          signal,
          paramValues,
          depth + 1,
          policy
        );
        if (!outcome.ok) return outcome;
        if (outcome.cancelled) return { ok: true, cancelled: true };
      }
      return { ok: true };
    }
    case "loop": {
      // Bound nesting before descending so a loop that nests itself fails fast
      // instead of blowing the stack (the loop analogue of the conditional bound).
      if (depth >= MAX_LOOP_DEPTH) {
        return { ok: false, error: `loop nesting exceeds the maximum depth of ${MAX_LOOP_DEPTH}` };
      }
      const base = paramValues ?? {};
      // Run the body once for iteration `i`, exposing the reserved
      // `${iteration}` value to every body step. Returns a terminal outcome to
      // propagate (failure/cancel), or `null` when the body completed normally.
      const runBody = async (i: number): Promise<StepOutcome | null> => {
        const augmented: WorkflowParamValues = { ...base, [LOOP_ITERATION_PARAM]: String(i) };
        for (const child of resolved.body) {
          if (cancelled()) return { ok: true, cancelled: true };
          const outcome = await executeStepWithPolicy(
            child,
            deps,
            signal,
            augmented,
            depth + 1,
            policy
          );
          if (!outcome.ok) return outcome;
          if (outcome.cancelled) return { ok: true, cancelled: true };
        }
        return null;
      };

      if (resolved.loop.kind === "count") {
        const requested = Number.isFinite(resolved.loop.count)
          ? Math.max(0, Math.floor(resolved.loop.count))
          : 0;
        const iterations = Math.min(requested, MAX_LOOP_ITERATIONS);
        if (iterations < requested) {
          frontendWarn(
            "workflow",
            `loop count ${requested} exceeds the maximum of ${MAX_LOOP_ITERATIONS}; clamping`
          );
        }
        for (let i = 0; i < iterations; i++) {
          if (cancelled()) return { ok: true, cancelled: true };
          const early = await runBody(i);
          if (early) return early;
        }
        return { ok: true };
      }

      // `while` loop: re-evaluate the condition each iteration against the
      // per-iteration augmented map, bounded by the safety cap so an always-true
      // condition can never spin forever.
      const condition = resolved.loop.condition;
      for (let i = 0; ; i++) {
        if (cancelled()) return { ok: true, cancelled: true };
        const augmented: WorkflowParamValues = { ...base, [LOOP_ITERATION_PARAM]: String(i) };
        const resolvedCondition: WorkflowCondition = {
          ...condition,
          left: interpolateParams(condition.left, augmented),
          right: interpolateParams(condition.right, augmented),
        };
        if (!evaluateCondition(resolvedCondition)) return { ok: true };
        if (i >= MAX_LOOP_ITERATIONS) {
          return {
            ok: false,
            error: `while-loop exceeded the maximum of ${MAX_LOOP_ITERATIONS} iterations`,
          };
        }
        const early = await runBody(i);
        if (early) return early;
      }
    }
    case "wait-for-output": {
      if (!deps.waitForOutput) {
        return {
          ok: false,
          error: 'the "wait-for-output" step requires a terminal-output seam',
        };
      }
      const isRegex = resolved.isRegex ?? false;
      // Reject an invalid regex up front so the run fails with a clear message
      // rather than silently never matching.
      if (isRegex) {
        try {
          new RegExp(resolved.pattern);
        } catch {
          return {
            ok: false,
            error: `wait-for-output has an invalid regular expression: ${resolved.pattern}`,
          };
        }
      }
      const timeoutMs = clampWaitTimeout(resolved.timeoutMs);
      const result = await deps.waitForOutput({ pattern: resolved.pattern, isRegex }, timeoutMs, {
        signal,
      });
      if (result.cancelled) return { ok: true, cancelled: true };
      if (result.matched) return { ok: true };
      if (result.timedOut) {
        return {
          ok: false,
          error:
            `wait-for-output timed out after ${timeoutMs} ms waiting for ` +
            `${isRegex ? "pattern" : "text"} "${resolved.pattern}"`,
        };
      }
      return { ok: false, error: "wait-for-output ended without a match" };
    }
    default: {
      // Exhaustiveness guard: a new step kind must add a case above.
      const _exhaustive: never = resolved;
      return { ok: false, error: `unknown workflow step kind: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/**
 * Execute a step under its per-step error-handling policy (PROD-045).
 *
 * - **Retry.** A failing attempt is re-run up to {@link effectiveRetryCount}
 *   more times, waiting {@link retryDelayMs} before each retry. The wait is
 *   cancellable: a cancel during it ends the step as `cancelled` without another
 *   attempt. A cancelled attempt is never retried.
 * - **Continue on error.** When every attempt failed and the step is marked
 *   `continueOnError`, the failure is recorded on `policy` and reported as a
 *   success so the enclosing list moves on; otherwise the final failure is
 *   returned (annotated with the attempt count when retries were used).
 *
 * A step with neither option behaves exactly like {@link executeStep}.
 */
export async function executeStepWithPolicy(
  step: WorkflowStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal,
  paramValues?: WorkflowParamValues,
  depth = 0,
  policy?: WorkflowPolicyContext
): Promise<StepOutcome> {
  const maxRetries = effectiveRetryCount(step.retry);
  const maxAttempts = maxRetries + 1;
  let attempt = 0;
  let lastError = "";
  for (;;) {
    attempt += 1;
    const outcome = await executeStep(step, deps, signal, paramValues, depth, policy);
    if (outcome.ok) return outcome;
    lastError = outcome.error;
    if (attempt >= maxAttempts) break;
    const delayMs = retryDelayMs(step.retry, attempt);
    frontendWarn(
      "workflow",
      `step "${step.kind}" failed (attempt ${attempt}/${maxAttempts}): ${lastError}; ` +
        `retrying in ${delayMs} ms`
    );
    policy?.hooks?.onStepRetry?.({
      stepIndex: policy.stepIndex,
      step,
      failedAttempt: attempt,
      maxAttempts,
      error: lastError,
      delayMs,
    });
    if (await sleepUnlessCancelled(delayMs, deps, signal)) return { ok: true, cancelled: true };
  }

  if (step.continueOnError) {
    frontendWarn(
      "workflow",
      `step "${step.kind}" failed after ${attempt} attempt(s) but is marked ` +
        `continue-on-error; continuing: ${lastError}`
    );
    if (policy) {
      policy.continuedFailures.push({
        stepIndex: policy.stepIndex,
        error: lastError,
        attempts: attempt,
      });
      policy.hooks?.onStepContinued?.({
        stepIndex: policy.stepIndex,
        step,
        error: lastError,
        attempts: attempt,
      });
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: attempt > 1 ? `${lastError} (after ${attempt} attempts)` : lastError,
  };
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
 *
 * `paramValues` (PROD-0040) is forwarded to each step's substitution pass. Absent
 * or empty, the run is byte-identical to a parameter-free run.
 *
 * Each step runs under its error-handling policy (PROD-045, see
 * {@link executeStepWithPolicy}): a step with a `retry` policy is re-attempted
 * before the run fails, and a step marked `continueOnError` records its failure
 * in {@link WorkflowRunResult.continuedFailures} and lets the run carry on. A
 * cancel interrupts a retry back-off wait immediately.
 */
export function runWorkflow(
  steps: WorkflowStep[],
  deps: WorkflowRunnerDeps,
  hooks?: WorkflowRunHooks,
  paramValues?: WorkflowParamValues
): WorkflowRunHandle {
  let cancelled = false;
  let resolveCancelled: () => void = () => {};
  const whenCancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });

  const cancel = (): void => {
    cancelled = true;
    resolveCancelled();
  };

  const signal: WorkflowStepSignal = { isCancelled: () => cancelled, whenCancelled };
  const policy: WorkflowPolicyContext = { stepIndex: 0, hooks, continuedFailures: [] };
  // Attach the tolerated failures only when there were any, so a run that uses
  // no error handling reports exactly the pre-PROD-045 result shape.
  const withFailures = (result: WorkflowRunResult): WorkflowRunResult =>
    policy.continuedFailures.length > 0
      ? { ...result, continuedFailures: [...policy.continuedFailures] }
      : result;

  const done = (async (): Promise<WorkflowRunResult> => {
    // Yield once before the first step so a cancel() issued synchronously right
    // after this handle is returned lands before any step runs — a run cancelled
    // before it starts does nothing.
    await Promise.resolve();
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) return withFailures({ status: "cancelled", stepsCompleted: i });

      policy.stepIndex = i;
      const outcome = await executeStepWithPolicy(steps[i], deps, signal, paramValues, 0, policy);
      if (!outcome.ok) {
        return withFailures({
          status: "failed",
          stepsCompleted: i,
          failedStepIndex: i,
          error: outcome.error,
        });
      }
      // A multi-part step that aborted mid-flight on cancel: end the run without
      // counting it as completed and without firing its progress hook.
      if (outcome.cancelled) return withFailures({ status: "cancelled", stepsCompleted: i });

      hooks?.onProgress?.(i + 1, steps.length, steps[i]);
    }
    return withFailures({ status: "completed", stepsCompleted: steps.length });
  })();

  return { done, cancel };
}
