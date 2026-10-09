/**
 * Reconnect loop for a coordinated agent update (#1602, #4311).
 *
 * When another host updates an agent, this window suspends its connection and
 * must reconnect once the new agent binary is up. How long that takes is not
 * known: the agent's restart estimate is a fixed guess, and verifying and
 * swapping the binary can run longer on a slow host. So instead of a single
 * attempt after the estimate, the loop:
 *
 *   1. waits the initial restart window (the estimate plus a buffer),
 *   2. retries with the shared exponential backoff and jitter
 *      ({@link nextReconnectDelay}) on every failure,
 *   3. gives up once the overall deadline has passed, so the caller can show a
 *      clear failure state with a manual Reconnect.
 *
 * The loop is cancellable per agent (the user stops it, a newer update restarts
 * it, a manual connect supersedes it) and globally (the window unmounts). Every
 * callback is guarded by a generation token, so the late outcome of an attempt
 * that was already superseded never reaches the caller.
 *
 * Module-level and per-window on purpose: the loop belongs to the window that
 * received the update notice and owns its timers.
 */

import { nextReconnectDelay, type BackoffConfig } from "@/utils/reconnectBackoff";

/**
 * Overall budget for reconnecting after a coordinated update, from the notice
 * to giving up. Generous enough for a slow host to verify and swap the binary,
 * short enough that a failed update surfaces as an error instead of a spinner.
 */
export const AGENT_UPDATE_RECONNECT_DEADLINE_MS = 120_000;

/**
 * Backoff between attempts after the first one fails: 2, 4, 8, then 15 s
 * windows, each shortened by up to half through jitter. The overall deadline,
 * not an attempt count, bounds the loop.
 */
export const AGENT_UPDATE_RECONNECT_BACKOFF: BackoffConfig = {
  baseDelayMs: 2_000,
  factor: 2,
  maxDelayMs: 15_000,
  maxAttempts: 0,
  jitterRatio: 0.5,
};

/** What the loop needs from its caller. */
export interface AgentUpdateReconnectOptions {
  /** Wait before the first attempt (the agent's restart window). */
  initialDelayMs: number;
  /** Overall budget from the start of the loop; defaults to the shared deadline. */
  deadlineMs?: number;
  /** One connection attempt. Resolves when connected, rejects on failure. */
  attempt: () => Promise<void>;
  /** Whether the agent is already connected (for example by another window). */
  isConnected: () => boolean;
  /** The agent is back, after `attempts` attempts by this loop. */
  onSuccess: (attempts: number) => void;
  /** The deadline passed without a successful attempt. */
  onGiveUp: (attempts: number, lastError: unknown) => void;
  /** Jitter source; injectable for tests. */
  rand?: () => number;
}

interface LoopEntry {
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const loops = new Map<string, LoopEntry>();
let generationCounter = 0;
/** The agent whose automatic attempt is starting right now (synchronously). */
let autoAttemptAgentId: string | null = null;

/**
 * Start (or restart) the reconnect loop for `agentId`. A loop that is already
 * running for the agent is cancelled first, so a newer update notice always
 * wins over an older one.
 */
export function startAgentUpdateReconnect(
  agentId: string,
  options: AgentUpdateReconnectOptions
): void {
  cancelAgentUpdateReconnect(agentId);

  const generation = ++generationCounter;
  const entry: LoopEntry = { generation, timer: null };
  loops.set(agentId, entry);

  const deadline = Date.now() + (options.deadlineMs ?? AGENT_UPDATE_RECONNECT_DEADLINE_MS);
  const rand = options.rand ?? Math.random;
  let attempts = 0;

  const isLive = () => loops.get(agentId)?.generation === generation;
  const finish = () => {
    if (isLive()) loops.delete(agentId);
  };
  const schedule = (delayMs: number) => {
    entry.timer = setTimeout(fire, Math.max(0, delayMs));
  };

  const onFailure = (err: unknown) => {
    if (!isLive()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finish();
      options.onGiveUp(attempts, err);
      return;
    }
    // The n-th failure waits the n-th backoff window (the restart window
    // already preceded the first attempt). Never sleep past the deadline: the
    // last attempt lands on it.
    schedule(
      Math.min(nextReconnectDelay(attempts, AGENT_UPDATE_RECONNECT_BACKOFF, rand), remaining)
    );
  };

  function fire(): void {
    entry.timer = null;
    if (!isLive()) return;
    if (options.isConnected()) {
      finish();
      options.onSuccess(attempts);
      return;
    }
    attempts += 1;
    let pending: Promise<void>;
    autoAttemptAgentId = agentId;
    try {
      pending = options.attempt();
    } catch (err) {
      pending = Promise.reject(err);
    } finally {
      autoAttemptAgentId = null;
    }
    pending.then(() => {
      if (!isLive()) return;
      finish();
      options.onSuccess(attempts);
    }, onFailure);
  }

  schedule(Math.min(options.initialDelayMs, deadline - Date.now()));
}

/**
 * Stop the loop for `agentId`, if one is running. Returns whether a loop was
 * stopped. An attempt already in flight still settles, but its outcome is
 * ignored.
 */
export function cancelAgentUpdateReconnect(agentId: string): boolean {
  const entry = loops.get(agentId);
  if (!entry) return false;
  if (entry.timer !== null) clearTimeout(entry.timer);
  loops.delete(agentId);
  return true;
}

/** Stop every running loop (the window is unmounting or closing). */
export function cancelAllAgentUpdateReconnects(): void {
  for (const agentId of [...loops.keys()]) cancelAgentUpdateReconnect(agentId);
}

/** Whether a reconnect loop is running for `agentId`. */
export function isAgentUpdateReconnectActive(agentId: string): boolean {
  return loops.has(agentId);
}

/**
 * Whether the connect starting right now for `agentId` is the loop's own
 * automatic attempt. A connect for which this is false is a manual one (or
 * another caller's), and it supersedes the loop.
 */
export function isAgentUpdateAutoAttempt(agentId: string): boolean {
  return autoAttemptAgentId === agentId;
}
