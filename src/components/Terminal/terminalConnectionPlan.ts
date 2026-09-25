import type { BackendAgentReconnectOutcome, ProjectedSessionStatus } from "@/store/sessionBridge";
import type { TerminalExitReason } from "@/types/terminal";

/**
 * The establishment path chosen for a terminal (re)connect. This is the *pure*
 * classification of "how should this tab obtain a live backend session" — it
 * decides the branch only; the caller runs the concrete, side-effectful effect
 * for the chosen kind (create / restart / await-redrive / reattach + replay).
 *
 * Mirrors the `reconnectReducer` idiom in `src/utils/reconnectBackoff.ts`: a
 * pure function over an explicit input snapshot, no store reads, no `await`.
 *
 * - `reattach`         — attach to an already-known live session id (initial
 *                        mount: workspace restore / persistent attach /
 *                        cross-window re-parent). `replay` says how the caller
 *                        should repaint scrollback into the fresh xterm.
 * - `freshCreate`      — open a brand-new session via the client create loop
 *                        (initial mount with no session, a force-fresh "start
 *                        new shell", or a user-initiated reconnect).
 * - `restartPersistent`— persistent/agent reconnect: the caller awaits
 *                        `restartPersistentSessionForTab` and reattaches to the
 *                        (possibly new) live id — never the dead mount-time id.
 * - `awaitBackendRedrive` — backend-driven automatic reconnect: the caller
 *                        awaits `waitForBackendAgentReconnectOutcome`; the
 *                        backend redrive is the sole reconnect authority.
 */
/** How the caller should repaint scrollback when reattaching to a live session. */
export type ScrollbackReplay = "none" | "persistent" | "moved";

export type EstablishmentPlan =
  | { kind: "reattach"; sessionId: string; replay: ScrollbackReplay }
  | { kind: "freshCreate" }
  | { kind: "restartPersistent" }
  | { kind: "awaitBackendRedrive" };

/** Explicit input snapshot for {@link resolveEstablishmentPlan}. */
export interface EstablishmentPlanInput {
  /** This setup run is a reconnect (the tab's retry counter is > 0). */
  isReconnect: boolean;
  /**
   * The one-shot "start new shell" force-fresh flag was set for this tab
   * (#2512). Read + consumed by the caller before this function is called.
   */
  forceFresh: boolean;
  /** The tab has a persistent/agent background connection (the prop is set). */
  hasPersistentConnection: boolean;
  /** The projected `session-lifecycle` region status for this tab, if any. */
  regionStatus?: ProjectedSessionStatus;
  /**
   * The session id captured at mount time (workspace restore / persistent
   * attach), or `null` if the tab mounts without an existing session.
   */
  initialSessionId: string | null;
  /**
   * One-shot: replay the moved session's scrollback on the first attach after a
   * cross-window re-parent (#1900).
   */
  replayScrollbackOnAttach: boolean;
}

/**
 * Decide the establishment path for a terminal (re)connect.
 *
 * Derived verbatim from the former inline decision in `Terminal.tsx`
 * (`setupTerminal`). The corpse guard is structural: `reattach` (to the
 * mount-time `initialSessionId`) is returned *only* on the initial mount —
 * never on a reconnect, where that mount-time session is dead and reattaching
 * would wire the tab to a corpse and spin forever.
 *
 * @param input explicit snapshot of the state the decision reads
 * @returns the chosen {@link EstablishmentPlan}
 */
export function resolveEstablishmentPlan(input: EstablishmentPlanInput): EstablishmentPlan {
  const {
    isReconnect,
    forceFresh,
    hasPersistentConnection,
    regionStatus,
    initialSessionId,
    replayScrollbackOnAttach,
  } = input;

  if (isReconnect) {
    // "Start new shell" (#2512): the one-shot force-fresh flag makes this
    // reconnect create a brand-new session instead of re-attaching an
    // unrecoverable one.
    if (forceFresh) {
      return { kind: "freshCreate" };
    }
    // Persistent/agent tab: restart the background session and reattach to its
    // (possibly new) live id — never to the dead mount-time id.
    if (hasPersistentConnection) {
      return { kind: "restartPersistent" };
    }
    // Backend-driven automatic reconnect (#2205 PR-B): a genuine drop folded the
    // region to `reconnecting` and the backend redrive is the sole reconnect
    // authority. Wait for its terminal outcome; never drive the transport in
    // parallel from the client.
    if (regionStatus === "reconnecting") {
      return { kind: "awaitBackendRedrive" };
    }
    // User-initiated reconnect (the region is not reconnecting — the user
    // clicked Reconnect / Try Again after a disconnect or give-up): start fresh
    // via the client create loop, exactly as an initial connect does.
    return { kind: "freshCreate" };
  }

  // Initial mount. Reattach to the session captured at mount time (workspace
  // restore / persistent attach / cross-window re-parent); with no such session
  // there is nothing to reattach to, so create fresh.
  if (initialSessionId !== null) {
    const replay: ScrollbackReplay = hasPersistentConnection
      ? "persistent"
      : replayScrollbackOnAttach
        ? "moved"
        : "none";
    return { kind: "reattach", sessionId: initialSessionId, replay };
  }
  return { kind: "freshCreate" };
}

/**
 * The next step for an AGENT tab whose `createTerminal` call just failed inside
 * the client fresh-create loop (Phase D). This is the *pure* decision only — the
 * caller runs the concrete side-effectful effect for the chosen kind (park the
 * tab, re-establish the agent transport, surface a give-up error, or wait out
 * the retry backoff and try again).
 *
 * Mirrors {@link resolveEstablishmentPlan}: a pure function over an explicit
 * input snapshot, no store reads, no `await`, no timers.
 *
 * - `waitForAgent`            — the agent transport is still (re)connecting, so
 *                               parking the tab and letting `retryTerminalSpawn`
 *                               wake it once the agent emits "connected" is the
 *                               only sane move; retrying `createTerminal` now
 *                               would just fail again.
 * - `reconnectAgentThenWait`  — the agent transport itself is gone; retrying
 *                               `createTerminal` would fail with "Agent not
 *                               connected" forever, so the caller re-establishes
 *                               the agent connection and parks the tab.
 * - `retryAfterDelay`         — the agent is up (or its state is unknown) and the
 *                               session creation failed transiently; retry after
 *                               the backoff. `attempt` is the (1-based) attempt
 *                               number this retry advances the tab to.
 * - `giveUp`                  — the bounded retries are exhausted; surface a
 *                               disconnect-with-error instead of spinning forever.
 */
export type AgentSpawnAction =
  | { kind: "waitForAgent" }
  | { kind: "reconnectAgentThenWait" }
  | { kind: "giveUp" }
  | { kind: "retryAfterDelay"; attempt: number };

/** Explicit input snapshot for {@link resolveAgentSpawnAction}. */
export interface AgentSpawnActionInput {
  /**
   * The agent's current transport `connectionState`, or `undefined` when the
   * agent is not found in the projected view (treated the same as `connected`:
   * a transient session-creation failure, not a transport problem).
   */
  agentState?: "connecting" | "reconnecting" | "disconnected" | "connected";
  /**
   * Attempts already made for this tab (the loop's pre-increment counter). The
   * give-up boundary is `attempt >= maxAttempts`, matching the former inline
   * `attempt++; if (attempt > MAX_AGENT_SPAWN_ATTEMPTS)` exactly.
   */
  attempt: number;
  /** Maximum number of bounded retries (= `MAX_AGENT_SPAWN_ATTEMPTS`). */
  maxAttempts: number;
}

/**
 * Decide the next step after an agent-session `createTerminal` failure.
 *
 * Derived verbatim from the former inline agent-spawn retry branch in
 * `Terminal.tsx`. The transport-state checks come first (a still-connecting or
 * disconnected agent is handled regardless of the attempt count); only when the
 * agent is up (or unknown) does the bounded retry-vs-give-up decision apply.
 *
 * @param input explicit snapshot of the state the decision reads
 * @returns the chosen {@link AgentSpawnAction}
 */
export function resolveAgentSpawnAction(input: AgentSpawnActionInput): AgentSpawnAction {
  const { agentState, attempt, maxAttempts } = input;

  // The agent transport is still (re)connecting — park and wait for "connected".
  if (agentState === "connecting" || agentState === "reconnecting") {
    return { kind: "waitForAgent" };
  }

  // The agent transport itself is gone — re-establish it, then park and wait.
  if (agentState === "disconnected") {
    return { kind: "reconnectAgentThenWait" };
  }

  // Agent is up ("connected") or its state is unknown (`undefined`): the session
  // creation itself failed transiently. Bound the retries so a session that can
  // never be created surfaces an error instead of spinning forever.
  if (attempt < maxAttempts) {
    return { kind: "retryAfterDelay", attempt: attempt + 1 };
  }
  return { kind: "giveUp" };
}

/**
 * The step the caller must take once a backend-driven agent reconnect wait
 * (`awaitBackendRedrive`) settles. This is the *pure* mapping of the wait's
 * terminal {@link BackendAgentReconnectOutcome} (plus the effect's cancel state)
 * onto the concrete action — the caller runs the store side effect for the
 * chosen kind (abandon the effect, settle gave-up, settle session-lost, or
 * reattach terminal I/O to the fresh backend session id).
 *
 * Mirrors {@link resolveEstablishmentPlan}: a pure function over an explicit
 * input snapshot, no store reads, no `await`.
 *
 * - `abandon`           — the wait resolved `canceled`, or the effect was torn
 *                         down (`isCanceled`): drive nothing, just return.
 * - `settleGaveUp`      — the backend park/retry loop exhausted; settle the tab
 *                         disconnected. `error` carries the backend message, or
 *                         the `"Reconnect failed."` default when the outcome had
 *                         none — baked in here so the caller passes it verbatim.
 * - `settleSessionLost` — the transport came back but the live agent session was
 *                         unrecoverable (#2512): fold to the explicit
 *                         session-lost notice, never a silent replacement.
 * - `reattach`          — the redrive published a fresh backend session id;
 *                         attach terminal I/O to `sessionId`.
 */
export type BackendRedriveAction =
  | { kind: "abandon" }
  | { kind: "settleGaveUp"; error: string }
  | { kind: "settleSessionLost" }
  | { kind: "reattach"; sessionId: string };

/** Explicit input snapshot for {@link resolveBackendRedriveOutcome}. */
export interface BackendRedriveOutcomeInput {
  /** The terminal outcome returned by `waitForBackendAgentReconnectOutcome`. */
  outcome: BackendAgentReconnectOutcome;
  /** Whether the connect effect has been torn down (its `AbortSignal` fired). */
  isCanceled: boolean;
}

/**
 * Decide the step after a backend-driven agent reconnect wait settles.
 *
 * Derived verbatim from the former inline outcome switch in `Terminal.tsx`
 * (`setupTerminal`, the `awaitBackendRedrive` branch). The cancel guard comes
 * first — a torn-down effect (or a `canceled` outcome) drives nothing — matching
 * the original `if (isCanceled() || outcome.kind === "canceled") return;`.
 *
 * @param input explicit snapshot of the state the decision reads
 * @returns the chosen {@link BackendRedriveAction}
 */
export function resolveBackendRedriveOutcome(
  input: BackendRedriveOutcomeInput
): BackendRedriveAction {
  const { outcome, isCanceled } = input;

  // A torn-down effect, or a tab another desktop took over (SM-003 — it rests in
  // the explicit `evicted` state until the user reclaims): drive nothing.
  if (isCanceled || outcome.kind === "canceled" || outcome.kind === "evicted") {
    return { kind: "abandon" };
  }
  if (outcome.kind === "giveup") {
    return { kind: "settleGaveUp", error: outcome.error ?? "Reconnect failed." };
  }
  if (outcome.kind === "sessionLost") {
    return { kind: "settleSessionLost" };
  }
  return { kind: "reattach", sessionId: outcome.sessionId };
}

/**
 * Classify why a live terminal session ended, for the disconnect overlay's
 * wording (#1121). Pure mirror of the former inline expression in the
 * `subscribeExit` handler in `Terminal.tsx`.
 *
 * - `killed`  — the session was tagged user-initiated (e.g. killed from the Open
 *               Connections panel) before the exit fired.
 * - `clean`   — a not-killed exit with code `0`.
 * - `dropped` — any other not-killed exit (non-zero code, or an unknown/`null`
 *               code, which is not `=== 0` and so classifies as dropped exactly
 *               as before).
 *
 * @param input `wasKilled` (consumed kill tag) and the session's `exitCode`
 * @returns the {@link TerminalExitReason}
 */
export function classifyExitReason(input: {
  wasKilled: boolean;
  exitCode: number | null;
}): TerminalExitReason {
  const { wasKilled, exitCode } = input;
  return wasKilled ? "killed" : exitCode === 0 ? "clean" : "dropped";
}
