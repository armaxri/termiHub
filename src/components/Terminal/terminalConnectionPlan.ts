import type { ProjectedSessionStatus } from "@/store/sessionBridge";

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
