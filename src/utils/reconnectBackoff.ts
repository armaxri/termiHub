/**
 * Agentless auto-reconnect backoff state machine (#1962).
 *
 * A pure, timer-free model of the "resilient reconnect" loop used for plain SSH
 * connections over flaky links. It answers two questions the store's timer
 * driver needs:
 *
 *   1. How long to wait before the next connection attempt (exponential backoff
 *      with jitter, capped).
 *   2. What the next phase is after each event (drop / attempt / success /
 *      failure / cancel), including when to give up.
 *
 * Keeping this logic pure and injectable (`rand`) makes the backoff schedule and
 * the give-up decision unit-testable without fake timers or a live connection.
 * The store ({@link "@/store/appStore"}) owns the real `setTimeout` that drives
 * the machine and the side effects (calling `reconnectTerminal`).
 *
 * No agent means the remote shell state cannot be recovered — this machine only
 * models re-establishing the *transport*, not restoring server-side session
 * state. The UI is honest about that; see `TerminalDisconnectOverlay`.
 */

/** Tunables for the exponential backoff schedule. */
export interface BackoffConfig {
  /** Delay before the first retry, in ms. */
  baseDelayMs: number;
  /** Multiplier applied per attempt (2 → doubles each time). */
  factor: number;
  /** Upper bound on any single delay, in ms (before jitter). */
  maxDelayMs: number;
  /**
   * Maximum number of connection attempts before giving up. `0` means retry
   * forever (the user's Cancel is then the only way to stop).
   */
  maxAttempts: number;
  /**
   * Fraction of the computed delay applied as symmetric random jitter, in
   * `[0, 1]`. `0.2` spreads each delay by ±20% so a fleet of dropped tabs does
   * not stampede the server in lockstep. `0` disables jitter (deterministic).
   */
  jitterRatio: number;
}

/**
 * Defaults tuned for a truck-on-cellular field scenario (#1962): a quick first
 * retry so a brief blip recovers almost instantly, doubling up to a 30 s ceiling
 * so a long outage does not hammer the network, and a bounded attempt count so a
 * permanently-dead host eventually surfaces the manual "Reconnect failed"
 * overlay instead of spinning forever.
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
  maxAttempts: 10,
  jitterRatio: 0.2,
};

/**
 * Phase of the auto-reconnect loop for one tab.
 *
 * - `idle`       — not auto-reconnecting.
 * - `waiting`    — backoff timer is running before the next attempt.
 * - `connecting` — an attempt is in flight (the transport is being re-established).
 * - `connected`  — the transport came back; the loop settled successfully.
 * - `gaveup`     — attempts exhausted or the user cancelled; hand off to the
 *                  manual disconnect overlay.
 */
export type ReconnectPhase = "idle" | "waiting" | "connecting" | "connected" | "gaveup";

/** Immutable snapshot of the reconnect loop for one tab. */
export interface ReconnectState {
  phase: ReconnectPhase;
  /** Number of connection attempts started so far in this loop. */
  attempt: number;
  /** Delay the current `waiting` phase is counting down, in ms (0 otherwise). */
  delayMs: number;
}

/**
 * Events that drive the machine:
 *
 * - `drop`    — the connection was lost; begin (or, from `connected`, restart)
 *               the backoff loop.
 * - `attempt` — the backoff timer fired; start a connection attempt.
 * - `success` — the attempt connected.
 * - `failure` — the attempt failed; back off further or give up.
 * - `cancel`  — the user asked to stop retrying.
 */
export type ReconnectEvent = "drop" | "attempt" | "success" | "failure" | "cancel";

/** The starting state for a tab that is not auto-reconnecting. */
export const initialReconnectState: ReconnectState = {
  phase: "idle",
  attempt: 0,
  delayMs: 0,
};

/**
 * Pure exponential delay for a given attempt (1-based), before jitter and before
 * the cap-then-jitter in {@link nextReconnectDelay}. Attempt 1 → `baseDelayMs`,
 * attempt 2 → `baseDelayMs * factor`, and so on, clamped to `maxDelayMs`.
 *
 * `attempt < 1` is treated as attempt 1 so a caller never gets a negative or
 * sub-base delay.
 */
export function backoffDelay(attempt: number, config: BackoffConfig): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = config.baseDelayMs * Math.pow(config.factor, n - 1);
  return Math.min(raw, config.maxDelayMs);
}

/**
 * The concrete delay to wait before the given attempt (1-based), applying the
 * cap and then symmetric jitter of `±jitterRatio`. `rand` is injectable for
 * deterministic tests; it must return a value in `[0, 1)`.
 *
 * The result is clamped to `>= 0` and rounded to whole milliseconds.
 */
export function nextReconnectDelay(
  attempt: number,
  config: BackoffConfig,
  rand: () => number = Math.random
): number {
  const base = backoffDelay(attempt, config);
  if (config.jitterRatio <= 0) return Math.round(base);
  // Map rand() ∈ [0,1) to a symmetric factor in [-1, 1).
  const swing = (rand() * 2 - 1) * config.jitterRatio;
  return Math.max(0, Math.round(base * (1 + swing)));
}

/**
 * Whether the loop should give up rather than start another attempt. With
 * `maxAttempts === 0` the loop never gives up on its own (unbounded retry). Once
 * `attempt` attempts have already been made, a further failure gives up when
 * `attempt >= maxAttempts`.
 */
export function shouldGiveUp(attempt: number, config: BackoffConfig): boolean {
  if (config.maxAttempts <= 0) return false;
  return attempt >= config.maxAttempts;
}

/**
 * Pure transition for the reconnect state machine. Given the current state, an
 * event, the config, and an injectable RNG, returns the next state. Unknown
 * transitions are a no-op (return the same state) so a stray event cannot
 * corrupt the loop.
 *
 * The `delayMs` on a `waiting` result is the concrete jittered delay the timer
 * driver should arm; `attempt` counts attempts that have been started.
 */
export function reconnectReducer(
  state: ReconnectState,
  event: ReconnectEvent,
  config: BackoffConfig,
  rand: () => number = Math.random
): ReconnectState {
  switch (event) {
    case "cancel":
      // The user stops the loop from any phase.
      return { phase: "gaveup", attempt: state.attempt, delayMs: 0 };

    case "drop": {
      // A fresh drop (from idle or a previously-connected loop) arms the first
      // backoff window. A drop while already waiting/connecting is ignored — the
      // loop is already running and `failure` handles a failed attempt.
      if (state.phase === "idle" || state.phase === "connected") {
        const nextAttempt = 1;
        return {
          phase: "waiting",
          attempt: state.attempt, // no attempt started yet; incremented on "attempt"
          delayMs: nextReconnectDelay(nextAttempt, config, rand),
        };
      }
      return state;
    }

    case "attempt": {
      // The backoff timer fired: begin a connection attempt.
      if (state.phase !== "waiting") return state;
      return { phase: "connecting", attempt: state.attempt + 1, delayMs: 0 };
    }

    case "success": {
      if (state.phase !== "connecting") return state;
      return { phase: "connected", attempt: 0, delayMs: 0 };
    }

    case "failure": {
      if (state.phase !== "connecting") return state;
      // `attempt` already counts this just-failed attempt (incremented on
      // "attempt"). Give up once we have used our budget; otherwise arm the next
      // backoff window sized for the *next* attempt number.
      if (shouldGiveUp(state.attempt, config)) {
        return { phase: "gaveup", attempt: state.attempt, delayMs: 0 };
      }
      const nextAttemptNumber = state.attempt + 1;
      return {
        phase: "waiting",
        attempt: state.attempt,
        delayMs: nextReconnectDelay(nextAttemptNumber, config, rand),
      };
    }

    default:
      return state;
  }
}

/** Whether a phase is one where the loop is actively trying (spinner/countdown). */
export function isActiveReconnectPhase(phase: ReconnectPhase): boolean {
  return phase === "waiting" || phase === "connecting";
}
