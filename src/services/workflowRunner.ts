/**
 * Workflow run engine — the foundation (#1852) of the Workflow Automation epic
 * (#1851), extended with the remaining v1 terminal-native step types (#1853).
 *
 * Generalises the macro playback scheduler ({@link "@/services/macroPlayback"})
 * from a homogeneous list of recorded input chunks to an ordered list of *typed*
 * {@link RunnableStep}s. The runner walks the steps in order, dispatching each by
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
 *
 * Automation steps (#5818, slice 3). The runner also executes the two step kinds
 * an {@link AutomationStep} adds, so automations and workflows share one engine:
 *  - `type-keys` — the recorded chunks are typed byte for byte through the same
 *    `send` seam (no newline, no `${param}` substitution), scheduled by the
 *    macro-playback scheduler with the step's saved timing (see
 *    {@link typeKeysTiming}); delays sleep through the `wait` seam.
 *  - `run-automation` — runs another automation's steps inline, on the same
 *    target, looked up through {@link WorkflowRunnerDeps.resolveAutomation}. The
 *    chain of automations being run is threaded down so a cycle fails with the
 *    path, and nesting is capped at {@link MAX_AUTOMATION_DEPTH}.
 */

import {
  DEFAULT_FIXED_DELAY_MS,
  MAX_STEP_DELAY_MS,
  runMacroPlayback,
  type MacroPlaybackOptions,
} from "@/services/macroPlayback";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { WorkflowCondition, WorkflowStepRetry } from "@/types/workflow";
import { frontendWarn } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

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
 *
 * @alias Deliberately a separate name for the same value (knip duplicate-export
 * check): the two bounds may diverge later.
 */
export const MAX_LOOP_DEPTH = MAX_CONDITIONAL_DEPTH;

/**
 * Maximum number of nested `run-automation` calls in one run (#5818). The top
 * automation calling another is 1. A deeper chain fails with a clear error
 * rather than recursing further. Shares the value of the conditional bound.
 *
 * @alias Deliberately a separate name for the same value (knip duplicate-export
 * check): the bounds may diverge later.
 */
export const MAX_AUTOMATION_DEPTH = MAX_CONDITIONAL_DEPTH;

/** A step the runner can execute. */
export type RunnableStep = AutomationStep;

/** The `type-keys` automation step. */
export type TypeKeysStep = Extract<AutomationStep, { kind: "type-keys" }>;

/**
 * The macro-playback options a `type-keys` step's saved timing maps to
 * (#5818). `recorded` (the default) replays each chunk's recorded delay,
 * clamped like macro playback; `fixed` waits `fixedDelayMs` (default
 * {@link DEFAULT_FIXED_DELAY_MS}) between chunks; `instant` waits not at all.
 * As in macro playback, the first chunk is always typed at once. A **pure**
 * helper.
 */
export function typeKeysTiming(step: TypeKeysStep): MacroPlaybackOptions {
  switch (step.timing ?? "recorded") {
    case "instant":
      return { timingMode: "instant" };
    case "fixed":
      return {
        timingMode: "fixed",
        fixedDelayMs:
          step.fixedDelayMs !== undefined && Number.isFinite(step.fixedDelayMs)
            ? step.fixedDelayMs
            : DEFAULT_FIXED_DELAY_MS,
      };
    case "recorded":
    default:
      return { timingMode: "real-time" };
  }
}

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
const LOOP_ITERATION_PARAM = "iteration";

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

/**
 * How long a `wait-for-user` step waits before its run stops (#6025). Not longer
 * than `sudo` keeps asking (five minutes): what is typed after that would land
 * in the shell, in plain view.
 */
export const WAIT_FOR_USER_LIMIT_MS = 300_000;

/** Why a `wait-for-user` step that was not continued ended its run. */
const WAIT_FOR_USER_ERROR: Record<Exclude<WaitForUserResult, "continued" | "cancelled">, string> = {
  "timed-out":
    `nobody pressed Continue within ${WAIT_FOR_USER_LIMIT_MS / 60_000} minutes; ` +
    "nothing more was typed",
  gone: "the terminal was closed or disconnected while it waited for you",
};

/** Why a `wait-for-user` step of a run nobody watches ended it. */
export const WAIT_FOR_USER_NOBODY = "it waits for somebody to type, and nobody was there";

/** Default timeout (ms) for a `wait-for-output` step when it declares none. */
export const WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap (ms) a `wait-for-output` timeout is clamped to, so the step can
 * never wait longer than this even if a larger value is authored. */
const WAIT_FOR_OUTPUT_MAX_TIMEOUT_MS = 600_000;

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
  /** It was refused before its first step: nothing was typed. */
  notStarted?: true;
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
 * Looks up a stored automation by id for a `run-automation` step (#5818).
 * Returns `undefined` when no automation has that id.
 */
export type WorkflowResolveAutomationSeam = (automationId: string) => Automation | undefined;

/**
 * Sleeps for `ms` milliseconds before resolving — the scheduler timer both the
 * `wait` step and the `run-script` inter-line delay route through. Injectable so
 * tests can assert the (already clamped) delay without real time passing.
 */
export type WorkflowWaitSeam = (ms: number) => Promise<void> | void;

/**
 * Reads a script body from an on-disk path (the `run-script` `sourcePath`
 * affordance). Resolves the file's UTF-8 contents; rejects when it cannot be
 * read, in which case the step fails with that error (#4310 — never a silent
 * fallback to the embedded `script`, which may not be what the file says).
 */
export type WorkflowReadFileSeam = (path: string) => Promise<string>;

/**
 * Reports whether the user picked or confirmed a `run-script` `sourcePath` on
 * this machine (#4310, FEC2-001). Backed by a machine-local allowlist that lives
 * outside the workflow data, so an imported workflow file can never mark its own
 * path as trusted. Absent → no path is trusted and a step with a `sourcePath`
 * fails rather than reading the file.
 */
export type WorkflowScriptSourceTrustSeam = (path: string) => boolean;

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

/** How a "Wait for you" step's wait ended (#6025). Only `continued` goes on. */
export type WaitForUserResult = "continued" | "cancelled" | "timed-out" | "gone";

/**
 * Waits until the user says to go on (#6025). Injectable: the store shows the
 * wait and its Continue. Absent → nobody is there, and the step ends the run.
 */
export type WorkflowWaitForUserSeam = (
  message: string | undefined,
  options: { signal?: WorkflowStepSignal }
) => Promise<WaitForUserResult>;

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
  /** Why it did not start or run, when it did not. */
  error?: string;
}

/** The authorization gate's answer: approved, or not, with the reason if known. */
export type LocalProcessAuthorization = boolean | { refused: string };

/** Options threaded into a local-process spawn so it can observe cancellation. */
export interface LocalProcessRunOptions {
  /** A cancel poll: when it flips true, the seam kills the process. */
  signal?: WorkflowStepSignal;
}

/**
 * The **authorization gate** for a `run-local-process` step (#1857). Resolves
 * `true` only when the user has both opted in *and* authorized this specific
 * program (via a persisted allowlist or an interactive confirmation). The runner
 * treats every other resolution — `false`, a refusal with its reason, or the seam
 * being absent — as "not authorized" and refuses to spawn: nothing runs a local
 * process without a `true` from here first. The backend decides again when the
 * program starts (#5994).
 */
export type WorkflowAuthorizeLocalProcessSeam = (
  program: string,
  args: string[]
) => Promise<LocalProcessAuthorization> | LocalProcessAuthorization;

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
  /**
   * Looks up an automation by id (the `run-automation` seam, #5818). Absent →
   * a `run-automation` step fails loudly.
   */
  resolveAutomation?: WorkflowResolveAutomationSeam;
  /** Sleeps for a (clamped) number of ms (the `wait` / inter-line-delay seam). */
  wait?: WorkflowWaitSeam;
  /** Reads a script body from disk (the `run-script` `sourcePath` seam). */
  readScriptFile?: WorkflowReadFileSeam;
  /**
   * Whether a `run-script` `sourcePath` was picked or confirmed by the user on
   * this machine (#4310). Absent → every `sourcePath` is refused (fail-closed).
   */
  isScriptSourceTrusted?: WorkflowScriptSourceTrustSeam;
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
  /** Waits for the user (#6025). Absent → a `wait-for-user` step ends the run. */
  waitForUser?: WorkflowWaitForUserSeam;
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
  step: RunnableStep;
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
  step: RunnableStep;
  /** The failure reason of the final attempt. */
  error: string;
  /** How many times the step was attempted. */
  attempts: number;
}

/**
 * An automation a `run-automation` step ran has finished (#5818, slice 9):
 * what the run history records as that automation's own run, started "by
 * another automation". Fired only once the called automation actually started
 * (not for a cycle, a missing automation or a too-deep chain).
 */
export interface WorkflowNestedRunEvent {
  /** The automation the step ran. */
  automation: Automation;
  /** When its first step started. */
  startedAt: Date;
  /** When it reached its terminal state. */
  endedAt: Date;
  /** How it ended. */
  status: "completed" | "cancelled" | "failed";
  /** Its steps that completed before it ended. */
  stepsCompleted: number;
  /** For a failed run: the 0-based index of its step that failed. */
  failedStepIndex?: number;
  /** For a failed run: why its step failed. */
  error?: string;
}

/** Optional lifecycle hooks fired as a run advances. */
export interface WorkflowRunHooks {
  /** Fired when an automation a `run-automation` step ran has finished (#5818). */
  onNestedRunFinished?: (event: WorkflowNestedRunEvent) => void;
  /** Fired after each step completes, with the 1-based count, total, and step. */
  onProgress?: (completed: number, total: number, step: RunnableStep) => void;
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
type StepOutcome =
  | { ok: true; cancelled?: boolean }
  | {
      ok: false;
      error: string;
      /** Ends the run whatever the error handling of this step and those around it says. */
      fatal?: true;
    };

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
 * Resolve a `run-script` step's body. Without a `sourcePath` the step's visible
 * embedded `script` is the body. With one, the file is read fresh — but only
 * when the user picked or confirmed that exact path on this machine (#4310,
 * FEC2-001): an imported workflow must never be able to make a step type an
 * arbitrary local file (an SSH key, cloud credentials) into a remote shell. An
 * unconfirmed path, a missing read seam, or a failed read all fail the step
 * with a clear error instead of silently running the embedded copy.
 */
async function resolveScriptBody(
  step: Extract<RunnableStep, { kind: "run-script" }>,
  deps: WorkflowRunnerDeps
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const path = step.sourcePath;
  if (!path) return { ok: true, body: step.script };
  if (!deps.isScriptSourceTrusted?.(path)) {
    return {
      ok: false,
      error: `script file "${path}" was not confirmed on this machine; confirm or re-pick it in the step editor before running`,
    };
  }
  if (!deps.readScriptFile) {
    return { ok: false, error: `script file "${path}" cannot be read in this context` };
  }
  try {
    return { ok: true, body: await deps.readScriptFile(path) };
  } catch (err) {
    return { ok: false, error: `could not read script file "${path}": ${errorMessage(err)}` };
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
export function resolveStepParams<S extends RunnableStep>(
  step: S,
  paramValues: WorkflowParamValues,
  onUnknownParam?: (name: string) => void
): S {
  return resolveAnyStepParams(step, paramValues, onUnknownParam) as S;
}

/** {@link resolveStepParams} over the whole {@link RunnableStep} union. */
function resolveAnyStepParams(
  step: RunnableStep,
  paramValues: WorkflowParamValues,
  onUnknownParam?: (name: string) => void
): RunnableStep {
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
    case "wait":
    case "wait-for-user":
      return step;
    case "type-keys":
      // Recorded bytes are typed exactly: a `${` in a chunk stays literal.
      return step;
    case "run-automation":
      // The callee resolves its own steps against its own parameter values.
      return step;
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

/** Options of a whole run (#5818). */
export interface WorkflowRunOptions {
  /** Ids of the automations already being run, outermost first. */
  callChain?: readonly string[];
}

/** A human-readable name of an automation id for error messages. */
function automationLabel(id: string, deps: Pick<WorkflowRunnerDeps, "resolveAutomation">): string {
  const name = deps.resolveAutomation?.(id)?.name;
  return name ? `“${name}”` : `“${id}”`;
}

/**
 * Describe an automation call chain that closes a cycle, e.g.
 * `"Deploy" → "Build" → "Deploy"` (#5818).
 */
export function describeAutomationCycle(
  chain: readonly string[],
  deps: Pick<WorkflowRunnerDeps, "resolveAutomation">
): string {
  return chain.map((id) => automationLabel(id, deps)).join(" → ");
}

/**
 * The parameter values a called automation runs with (#5818): each parameter
 * it declares takes the caller's value of the same name, else its own default.
 * Parameters with neither are left out, so a `${name}` reference to them stays
 * literal exactly as in a top-level run. A **pure** helper.
 */
function calleeParamValues(
  callee: Automation,
  callerValues: WorkflowParamValues | undefined
): WorkflowParamValues {
  const values: WorkflowParamValues = {};
  for (const param of callee.parameters ?? []) {
    if (callerValues && Object.prototype.hasOwnProperty.call(callerValues, param.name)) {
      values[param.name] = callerValues[param.name];
    } else if (param.default !== undefined) {
      values[param.name] = param.default;
    }
  }
  return values;
}

/**
 * Type a `type-keys` step's chunks through the `send` seam (#5818). Reuses the
 * macro-playback scheduler with the step's saved timing; its delays sleep
 * through the `wait` seam. Each chunk's `data` is sent exactly as stored. A
 * cancel stops before the next chunk; a target that stops accepting input fails
 * the step, saying how many chunks were typed.
 */
async function typeKeys(
  step: TypeKeysStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal
): Promise<StepOutcome> {
  if (signal?.isCancelled()) return { ok: true, cancelled: true };
  const handle = runMacroPlayback(step.chunks, (data) => deps.send(data), {
    ...typeKeysTiming(step),
    sleep: deps.wait,
  });
  void signal?.whenCancelled?.then(() => handle.cancel());
  const result = await handle.done;
  switch (result.status) {
    case "completed":
      return { ok: true };
    case "cancelled":
      return { ok: true, cancelled: true };
    case "error":
    default:
      return {
        ok: false,
        error:
          `${SESSION_GONE} (typed ${result.stepsPlayed} of ${step.chunks.length} ` +
          `chunk${step.chunks.length === 1 ? "" : "s"})`,
      };
  }
}

/**
 * Run another automation's steps inline for a `run-automation` step (#5818),
 * on the same target and under the same cancel signal and error-handling
 * bookkeeping. Fails when the lookup seam is absent, the automation is missing,
 * it is already on the call chain (a cycle), or the chain is already
 * {@link MAX_AUTOMATION_DEPTH} calls deep.
 */
async function runNestedAutomation(
  automationId: string,
  deps: WorkflowRunnerDeps,
  signal: WorkflowStepSignal | undefined,
  paramValues: WorkflowParamValues | undefined,
  policy: WorkflowPolicyContext | undefined,
  callChain: readonly string[]
): Promise<StepOutcome> {
  if (!deps.resolveAutomation) {
    return { ok: false, error: 'the "run-automation" step requires an automation lookup' };
  }
  if (callChain.includes(automationId)) {
    return {
      ok: false,
      error: `automation calls itself: ${describeAutomationCycle([...callChain, automationId], deps)}`,
    };
  }
  // The outermost automation is not a call, so a chain of N ids makes this the
  // N-th call (the first call when the run was started without a chain).
  const calls = Math.max(1, callChain.length);
  if (calls > MAX_AUTOMATION_DEPTH) {
    return {
      ok: false,
      error: `automations call each other more than ${MAX_AUTOMATION_DEPTH} levels deep`,
    };
  }
  const callee = deps.resolveAutomation(automationId);
  if (!callee) return { ok: false, error: `automation “${automationId}” was not found` };

  const chain = [...callChain, automationId];
  const values = calleeParamValues(callee, paramValues);
  const startedAt = new Date();
  const finish = (
    status: WorkflowNestedRunEvent["status"],
    stepsCompleted: number,
    failure?: { index: number; error: string }
  ): void => {
    const event: WorkflowNestedRunEvent = {
      automation: callee,
      startedAt,
      endedAt: new Date(),
      status,
      stepsCompleted,
    };
    if (failure) {
      event.failedStepIndex = failure.index;
      event.error = failure.error;
    }
    policy?.hooks?.onNestedRunFinished?.(event);
  };
  for (let i = 0; i < callee.steps.length; i++) {
    if (signal?.isCancelled()) {
      finish("cancelled", i);
      return { ok: true, cancelled: true };
    }
    const outcome = await executeStepWithPolicy(
      callee.steps[i],
      deps,
      signal,
      values,
      // Each automation counts its own conditional/loop nesting from 0; the
      // call depth itself is capped above, so the stack stays bounded.
      0,
      policy,
      chain
    );
    if (!outcome.ok) {
      finish("failed", i, { index: i, error: outcome.error });
      return {
        ok: false,
        error: `in automation “${callee.name}”, step ${i + 1}: ${outcome.error}`,
        ...(outcome.fatal ? { fatal: true } : {}),
      };
    }
    if (outcome.cancelled) {
      finish("cancelled", i);
      return { ok: true, cancelled: true };
    }
  }
  finish("completed", callee.steps.length);
  return { ok: true };
}

/**
 * Execute a single workflow step by dispatching on its `kind`. The `switch` is
 * exhaustive over the {@link RunnableStep} union (the `never` default is a
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
 *
 * `callChain` (#5818) is the ids of the automations being run, outermost first.
 * A `run-automation` step fails when its target is already on the chain (a
 * cycle) or the chain is already {@link MAX_AUTOMATION_DEPTH} calls deep.
 */
export async function executeStep(
  step: RunnableStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal,
  paramValues?: WorkflowParamValues,
  depth = 0,
  policy?: WorkflowPolicyContext,
  callChain: readonly string[] = []
): Promise<StepOutcome> {
  const cancelled = (): boolean => signal?.isCancelled() ?? false;

  // Distinct substitution pass ahead of the dispatch switch. Identity when no
  // parameter values are supplied, so the switch below is unchanged for a
  // parameter-free workflow.
  const resolved = resolveStepParams(step, paramValues ?? {}, (name) =>
    frontendWarn(
      "workflow",
      `parameter "\${${name}}" is not declared by this automation; leaving it literal`
    )
  );

  switch (resolved.kind) {
    case "send-command": {
      const delivered = await deps.send(resolved.command + LINE_TERMINATOR);
      return delivered ? { ok: true } : { ok: false, error: SESSION_GONE };
    }
    case "run-script": {
      const body = await resolveScriptBody(resolved, deps);
      if (!body.ok) return { ok: false, error: body.error };
      const lines = splitScriptLines(body.body);
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
    case "wait": {
      await sleepFor(clampDelay(resolved.delayMs), deps);
      return { ok: true };
    }
    case "type-keys":
      return typeKeys(resolved, deps, signal);
    case "run-automation":
      return runNestedAutomation(
        resolved.automationId,
        deps,
        signal,
        paramValues,
        policy,
        callChain
      );
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
      if (authorized !== true) {
        return {
          ok: false,
          error: authorized
            ? authorized.refused
            : `local process "${resolved.program}" is not authorized to run`,
        };
      }
      // A cancel observed before the spawn aborts the run without spawning.
      if (cancelled()) return { ok: true, cancelled: true };

      const result = await deps.runLocalProcess(resolved.program, resolved.args, { signal });
      if (result.cancelled) return { ok: true, cancelled: true };
      if (result.error !== undefined) return { ok: false, error: result.error };
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
          policy,
          callChain
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
            policy,
            callChain
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
    case "wait-for-user": {
      if (!deps.waitForUser) return { ok: false, error: WAIT_FOR_USER_NOBODY, fatal: true };
      const result = await deps.waitForUser(resolved.message, { signal });
      if (result === "cancelled") return { ok: true, cancelled: true };
      if (result === "continued") return { ok: true };
      return { ok: false, error: WAIT_FOR_USER_ERROR[result], fatal: true };
    }
    default: {
      // Exhaustiveness guard: a new step kind must add a case above.
      const _exhaustive: never = resolved;
      // Only the kind: the error is kept in the run history, the step is not.
      const { kind } = _exhaustive as { kind: string };
      return { ok: false, error: `unknown workflow step kind: "${kind}"` };
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
 * A fatal failure (nobody answered a `wait-for-user` step, #6025) is neither
 * retried nor tolerated, at this level or around it: going on would type into
 * whatever the terminal still asks.
 *
 * A step with neither option behaves exactly like {@link executeStep}.
 */
export async function executeStepWithPolicy(
  step: RunnableStep,
  deps: WorkflowRunnerDeps,
  signal?: WorkflowStepSignal,
  paramValues?: WorkflowParamValues,
  depth = 0,
  policy?: WorkflowPolicyContext,
  callChain: readonly string[] = []
): Promise<StepOutcome> {
  const maxRetries = effectiveRetryCount(step.retry);
  const maxAttempts = maxRetries + 1;
  let attempt = 0;
  let lastError = "";
  for (;;) {
    attempt += 1;
    const outcome = await executeStep(step, deps, signal, paramValues, depth, policy, callChain);
    if (outcome.ok || outcome.fatal) return outcome;
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
 *
 * `options.callChain` (#5818) seeds the `run-automation` cycle check with the
 * id of the automation being run, so it cannot call itself.
 */
export function runWorkflow(
  steps: readonly RunnableStep[],
  deps: WorkflowRunnerDeps,
  hooks?: WorkflowRunHooks,
  paramValues?: WorkflowParamValues,
  options?: WorkflowRunOptions
): WorkflowRunHandle {
  const callChain = options?.callChain ?? [];
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
      const outcome = await executeStepWithPolicy(
        steps[i],
        deps,
        signal,
        paramValues,
        0,
        policy,
        callChain
      );
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
