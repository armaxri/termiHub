import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { collectLiveTabs, omitKey } from "../layoutHelpers";
import {
  isResilientReconnectTab,
  isResilientReconnectTabId,
  ABORTED_CONNECT_MESSAGE,
} from "../reconnectHelpers";
import { monitorKeyForTab } from "../tabQueries";
import type { TerminalExitInfo } from "@/types/terminal";
import {
  closeTerminal as apiCloseTerminal,
  detachPersistentTab as apiDetachPersistentTab,
} from "@/services/api";
import { notifyWorkflowSessionExited } from "../workflowSessionTriggers";
import {
  connectTimeoutMessage,
  connectTimeoutMs,
  type ConnectTimeoutKind,
} from "@/utils/connectTimeout";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import {
  currentSessionView,
  mirrorSessionExited,
  mirrorSessionIntent,
} from "@/store/sessionBridge";
import { currentMonitorsView } from "@/store/systemMonitorBridge";

/**
 * A per-tab wall-clock deadline for a timed pre-connect state. Stored so the
 * connect/waiting timeout survives an overlay remount (tab drag, split re-key):
 * the deadline is set once on entry and the overlay only reads it, so
 * unmounting/remounting the overlay can never restart the countdown (#1263).
 */
export type ConnectDeadline = { kind: ConnectTimeoutKind; at: number };

/**
 * Arm the connect deadline for `tabId`, idempotently: if a deadline for the
 * same kind already exists it is kept (so re-entering the state — or the
 * overlay remounting and the effect re-running — does not push the deadline
 * out). A different kind (connecting -> waiting-for-agent) arms a fresh one.
 */
function armConnectDeadline(
  deadlines: Record<string, ConnectDeadline>,
  tabId: string,
  kind: ConnectTimeoutKind
): Record<string, ConnectDeadline> {
  const current = deadlines[tabId];
  if (current && current.kind === kind) return deadlines;
  return { ...deadlines, [tabId]: { kind, at: Date.now() + connectTimeoutMs(kind) } };
}

/**
 * Per-tab terminal session-state slice (ARCH-001/FES-011, appStore god-module
 * split via #2881): the runtime-only per-tab connect state — spawn errors and
 * their typed kinds (I18N-009 / #3752), retry counters, connect deadlines (#1263),
 * auto-retry counts and waiting-for-agent parking — plus the session-disconnect /
 * reconnect actions (exit folding, intentional kills, view mode, reattach,
 * reconnect prompt, give-up / session-lost settling, fresh shell). The
 * exited / exit-info / disconnect-error view-state itself lives in the shared
 * `session-lifecycle` region (#2625); these actions mirror `session.*` intents.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. The tab-open seeding and close-tab cleanup of these maps stay in the
 * root store (tabs/layout domain), as do the restore-cohort actions
 * (`beginRestoreCohort` / `settleRestoreTab` / `reconnectFailedRestoreTabs`), which
 * these actions call through `get()`. `reclaimSession` also stays in the root store:
 * the takeover audit (#3395) pins the only takeover-attach call site to
 * `appStore.ts`.
 */
export interface TerminalSessionStateSlice {
  // Per-tab terminal spawn errors (runtime-only, cleared on retry or tab close)
  terminalSpawnErrors: Record<string, string>;
  /**
   * Per-tab typed failure kind of the spawn error, from the backend's
   * locale-independent error code (I18N-009). The overlay selects its hint from
   * this and the backend family — never from the message text. Absent = `other`.
   */
  terminalSpawnErrorKinds: Record<string, ConnectionErrorKind>;
  terminalRetryCounters: Record<string, number>;
  /**
   * Per-tab wall-clock deadline (epoch ms + kind) for the active timed
   * pre-connect state. Set on entry to `Connecting` / `WaitingForAgent` and
   * cleared on every exit; the overlay reads it so the timeout survives a
   * remount instead of restarting the countdown (#1263).
   */
  terminalConnectDeadline: Record<string, ConnectDeadline>;
  setTerminalSpawnError: (tabId: string, error: string | null, kind?: ConnectionErrorKind) => void;
  retryTerminalSpawn: (tabId: string) => void;
  setTerminalConnecting: (tabId: string, connecting: boolean) => void;
  /** Auto-retry attempt count for agent sessions (> 0 = actively auto-retrying). */
  terminalAutoRetryCount: Record<string, number>;
  /** Tab is parked waiting for its parent agent to connect; value = agentId. */
  terminalWaitingForAgent: Record<string, string>;
  setTerminalAutoRetrying: (tabId: string, count: number) => void;
  setTerminalWaitingForAgent: (tabId: string, agentId: string | null) => void;
  /**
   * Client-side timeout for a pre-connect state. Transitions the tab to Failed
   * with a contextual hint, but only if it is still in the given state — a
   * stale timer that fires after the tab connected or was woken is a no-op.
   */
  failTerminalConnectTimeout: (tabId: string, kind: ConnectTimeoutKind) => void;
  /**
   * User-initiated abort of an in-flight connect (from the connecting, waiting,
   * or auto-retry overlay). Transitions the tab to a retryable Failed state and
   * keeps the tab open — distinct from Cancel, which closes the tab (#1128).
   */
  abortTerminalConnect: (tabId: string) => void;

  // Per-tab terminal session disconnects (runtime-only, cleared on reconnect, dismiss, or tab close).
  // The exited / exit-info / disconnect-error view-state now lives purely in the shared
  // `session-lifecycle` region (#2625) — read via `useProjectedSessionLifecycle` / the
  // `effective*` helpers in `sessionBridge`; no per-client `appStore` twin.
  /**
   * Tabs whose next reconnect must start a **fresh** session rather than
   * re-attach to a retained one (#2512). Set by {@link startFreshShellForTab} when
   * the user picks "start new shell" on the session-lost notice: the reconnect
   * effect consumes the flag and skips the backend re-attach / persistent-restart
   * branches, going straight to a fresh `create_connection`. Runtime-only,
   * one-shot (consumed by the effect).
   */
  terminalForceFreshReconnect: Record<string, boolean>;
  /**
   * Session IDs the user explicitly killed (e.g. from the Open Connections panel).
   * Consumed by the exit handler so a user kill is classified as `killed` rather
   * than an unexpected disconnect (#1121).
   */
  intentionallyKilledSessions: Record<string, boolean>;
  /** True when the disconnect overlay was dismissed — session is dead but user is browsing scrollback. */
  terminalViewMode: Record<string, boolean>;
  /** True while cached scrollback is being fetched and written after a persistent session reattach. */
  terminalReattaching: Record<string, boolean>;
  /** True when the "reconnect?" prompt should appear (triggered by Enter in view mode). */
  terminalReconnectPrompt: Record<string, boolean>;
  /**
   * Mark a tab's session as exited. Pass `info` to record the exit code and
   * cause so the overlay can branch its wording; a `killed` reason additionally
   * drops the tab straight into view mode so no disconnect overlay appears (#1121).
   */
  setTerminalExited: (tabId: string, info?: TerminalExitInfo) => void;
  /**
   * Tabs that ended because the user disconnected or shut down their agent
   * (#4309). Runtime-only presentation state: the view-mode banner reads it to
   * say the *agent* was disconnected. Cleared on reconnect and tab close.
   */
  terminalAgentDisconnected: Record<string, boolean>;
  /**
   * End a tab because the user disconnected or shut down its agent (#4309): a
   * user end (`killed` → region `disconnected`, reason `user`), never a drop, so
   * no reconnect loop is armed. The tab stays on the view-mode banner with a
   * manual Reconnect, which re-establishes the agent and starts a new session.
   */
  setTerminalAgentDisconnected: (tabId: string) => void;
  /** Tag a session as intentionally killed by the user (e.g. Open Connections) (#1121). */
  markSessionKilled: (sessionId: string) => void;
  /** Return whether a session was intentionally killed, clearing the flag (#1121). */
  consumeSessionKilled: (sessionId: string) => boolean;
  setTerminalDisconnectWithError: (tabId: string, error: string) => void;
  /**
   * Settle a backend-driven agent reconnect (#2476) that the **backend** gave up
   * on. The backend redrive owns the reconnect outcome, so when its park/retry
   * loop exhausts (folds
   * `reconnectFailed` → `Failed`/`gaveup` in the region), the frontend must
   * reflect that terminal state directly rather than routing through the client
   * reconnect reducer (whose local attempt counter is not the authority here).
   * Clears the loop record + every in-flight connect flag and shows the disconnect
   * overlay with the give-up error, WITHOUT re-mirroring any `session.*` intent
   * (the backend already folded the give-up — mirroring would be a redundant,
   * possibly divergent, second signal).
   */
  settleBackendReconnectGaveUp: (tabId: string, error: string) => void;

  /**
   * Settle a resilient agent tab into the terminal **session-lost** state (#2512):
   * the backend re-established the transport on reconnect but the live agent
   * session could not be recovered, so it folded `session.sessionLost` into the
   * region. This reflects that locally — clearing the loop record + every in-flight
   * connect flag and marking the tab exited so the disconnect overlay mounts and
   * renders the projected session-lost notice (its "start new shell" action). Does
   * NOT set a disconnect error (the notice sources its message from the region) and
   * does NOT re-mirror any `session.*` intent (the backend already folded it).
   */
  settleSessionLost: (tabId: string) => void;

  /**
   * Start a fresh shell for a tab from the session-lost notice (#2512): arm the
   * one-shot {@link terminalForceFreshReconnect} flag and drive a reconnect, so the
   * effect creates a brand-new session (an explicit `create_connection`) instead of
   * attempting to re-attach the unrecoverable one.
   */
  startFreshShellForTab: (tabId: string) => void;
  setTerminalReattaching: (tabId: string, reattaching: boolean) => void;
  /** Dismiss the disconnect overlay into "view mode": scrollback is preserved, a thin banner shows. */
  dismissTerminalDisconnect: (tabId: string) => void;
  /**
   * Explicit user "Disconnect" (UX-015): drop a tab's live backend connection but
   * leave the tab open in a reconnectable state — distinct from {@link closeTab},
   * which tears the tab down and discards its scrollback. Reuses the intentional-
   * kill path ({@link markSessionKilled} + close), so the terminal-exit handler
   * folds it as a user disconnect (view mode + Reconnect banner) rather than an
   * unexpected drop. No-op when the tab has no live session.
   */
  disconnectTerminal: (tabId: string) => void;
  reconnectTerminal: (tabId: string) => void;
  showTerminalReconnectPrompt: (tabId: string) => void;
  dismissTerminalReconnectPrompt: (tabId: string) => void;

  /**
   * Stop (give up) the resilient-reconnect loop for a tab (#1962 / #2205 PR-B) —
   * the Cancel affordance and the exhausted-attempts path. Folds the region out of
   * reconnecting (`session.cancelReconnect`) — the backend is the sole reconnect
   * authority — and leaves the tab in the standard "disconnected" overlay so the
   * user can manually reconnect or browse scrollback. `error`, when given, shows
   * the "Reconnect failed" overlay variant with that message. No-op when the region
   * shows no active reconnect for the tab.
   */
  cancelAutoReconnect: (tabId: string, error?: string) => void;
}

export const createTerminalSessionStateSlice: StateCreator<
  AppState,
  [],
  [],
  TerminalSessionStateSlice
> = (set, get) => ({
  // Per-tab terminal spawn errors (runtime-only)
  terminalSpawnErrors: {},
  terminalSpawnErrorKinds: {},
  terminalRetryCounters: {},
  terminalConnectDeadline: {},
  terminalAutoRetryCount: {},
  terminalWaitingForAgent: {},
  setTerminalSpawnError: (tabId, error, kind) => {
    // #2205 PR-B: the resilient-reconnect loop is owned by the backend redrive,
    // so a spawn error here is a plain error write — the client no longer feeds a
    // failed attempt into a local `driveAutoReconnect` engine. A genuine drop that
    // should reconnect is folded into the region by `setTerminalExited`.
    set((state) => ({
      terminalSpawnErrors:
        error === null
          ? omitKey(state.terminalSpawnErrors, tabId)
          : { ...state.terminalSpawnErrors, [tabId]: error },
      // The kind always travels with the error it classifies, so a stale kind
      // can never label a later, unclassified error.
      terminalSpawnErrorKinds:
        error === null || kind === undefined || kind === "other"
          ? omitKey(state.terminalSpawnErrorKinds, tabId)
          : { ...state.terminalSpawnErrorKinds, [tabId]: kind },
    }));
  },
  retryTerminalSpawn: (tabId) =>
    set((state) => ({
      terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
      terminalSpawnErrorKinds: omitKey(state.terminalSpawnErrorKinds, tabId),
      terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
      terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
      terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
      terminalRetryCounters: {
        ...state.terminalRetryCounters,
        [tabId]: (state.terminalRetryCounters[tabId] ?? 0) + 1,
      },
    })),
  setTerminalConnecting: (tabId, connecting) => {
    // Session-intents cut (#2203): an initial connect entering "Connecting…" is
    // `session.connect` (a fresh connect resets any stale record). Skipped while
    // the region shows the tab reconnecting — that loop's `connecting` phase is
    // driven by the backend redrive (`session.reconnectAttempt`), and a fresh
    // `session.connect` would reset it (#2205 PR-B). The projected `connecting`
    // status now drives the overlay directly, so there is no local field to write
    // — only the wall-clock connect deadline is armed here.
    if (connecting && currentSessionView()[tabId]?.status !== "reconnecting") {
      mirrorSessionIntent("session.connect", tabId);
    }
    set((state) => ({
      terminalConnectDeadline: connecting
        ? armConnectDeadline(state.terminalConnectDeadline, tabId, "connecting")
        : omitKey(state.terminalConnectDeadline, tabId),
    }));
  },
  setTerminalAutoRetrying: (tabId, count) =>
    set((state) => ({
      terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
      terminalAutoRetryCount:
        count === 0
          ? omitKey(state.terminalAutoRetryCount, tabId)
          : { ...state.terminalAutoRetryCount, [tabId]: count },
    })),
  setTerminalWaitingForAgent: (tabId, agentId) =>
    set((state) => ({
      terminalWaitingForAgent:
        agentId === null
          ? omitKey(state.terminalWaitingForAgent, tabId)
          : { ...state.terminalWaitingForAgent, [tabId]: agentId },
      terminalConnectDeadline:
        agentId === null
          ? omitKey(state.terminalConnectDeadline, tabId)
          : armConnectDeadline(state.terminalConnectDeadline, tabId, "waiting-for-agent"),
    })),
  failTerminalConnectTimeout: (tabId, kind) =>
    set((state) => {
      // Guard against stale timers: only fail the tab if it is still in the
      // state the timeout was armed for. A connect that succeeded, an agent
      // that came online, or a cancelled tab all clear the relevant flag
      // first, making this a no-op.
      const stillArmed =
        kind === "waiting-for-agent"
          ? state.terminalWaitingForAgent[tabId] !== undefined
          : state.terminalConnectDeadline[tabId]?.kind === "connecting";
      if (!stillArmed) {
        return {};
      }
      frontendLog(
        "disconnect",
        `connect timeout (${kind}) for tab=${tabId} — transitioning to Failed`
      );
      return {
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalSpawnErrors: {
          ...state.terminalSpawnErrors,
          [tabId]: connectTimeoutMessage(kind),
        },
        // A connect that outlived its deadline is a timeout of the tab's own
        // backend; waiting on the parent agent is not, so it stays unhinted.
        terminalSpawnErrorKinds:
          kind === "connecting"
            ? { ...state.terminalSpawnErrorKinds, [tabId]: "timeout" as const }
            : omitKey(state.terminalSpawnErrorKinds, tabId),
      };
    }),
  abortTerminalConnect: (tabId) =>
    set((state) => {
      frontendLog(
        "disconnect",
        `connect aborted by user for tab=${tabId} — transitioning to Failed`
      );
      // Clear every in-flight pre-connect flag and land on a retryable Failed
      // state (spawn error set) so the overlay shows Retry and the tab stays
      // open. Distinct from closeTab, which tears the tab down entirely.
      return {
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalSpawnErrors: {
          ...state.terminalSpawnErrors,
          [tabId]: ABORTED_CONNECT_MESSAGE,
        },
        terminalSpawnErrorKinds: omitKey(state.terminalSpawnErrorKinds, tabId),
      };
    }),

  // Per-tab terminal session disconnects (runtime-only). The exited / exit-info
  // / disconnect-error view-state now lives purely in the shared
  // `session-lifecycle` region (#2625); no per-client `appStore` twin.
  terminalForceFreshReconnect: {},
  intentionallyKilledSessions: {},
  terminalViewMode: {},
  terminalReattaching: {},
  terminalReconnectPrompt: {},
  setTerminalExited: (tabId, info) => {
    // A user-initiated kill goes straight to view mode: the session is dead
    // and scrollback is preserved, but no "unexpected disconnect" overlay is
    // shown for something the user asked for (#1121).
    if (info?.reason === "killed") {
      set((state) => ({
        terminalViewMode: { ...state.terminalViewMode, [tabId]: true },
      }));
    }
    // Stop monitoring the dying tab's host — its stats are no longer updated
    // and the overlay hides the terminal anyway. Other hosts keep monitoring.
    const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
    if (deadKey && currentMonitorsView().monitors[deadKey]) {
      get().disconnectMonitoring(deadKey);
    }
    // Fold the exit **cause** onto the shared `session-lifecycle` region so the
    // disconnect overlay can derive its heading/subheading wording from the
    // region — the sole authority now the `terminalExitInfo` slice is deleted
    // (#2625). A pure-metadata `session.exited` write — it does not touch the
    // coarse lifecycle status the status intents below drive. Also makes
    // `regionExited` true (exit != null), which mounts the overlay for a clean
    // exit (which dispatches no status intent). Only fires when the exit was
    // classified (a bare `setTerminalExited(tabId)` with no info records nothing).
    if (info) {
      mirrorSessionExited(tabId, info);
      // On-disconnect workflow triggers (#3791): a drop or a user close.
      notifyWorkflowSessionExited({ get, set }, tabId, info.reason);
    }
    // Fold the exit into the shared `session-lifecycle` region — the sole
    // reconnect authority (#2205 PR-B):
    //  - a user kill is a graceful `session.disconnect`;
    //  - an unexpected drop on a resilient tab that opted in arms the backend
    //    redrive via `session.reconnect` (region → reconnecting; the backend
    //    drives the backoff loop and re-establishes the transport). Only an
    //    unexpected drop qualifies — a clean exit or a user kill never reconnects;
    //  - any other unexpected drop is a terminal `session.dropped`.
    if (info?.reason === "killed") {
      mirrorSessionIntent("session.disconnect", tabId);
    } else if (info?.reason === "dropped") {
      const tab = collectLiveTabs(get()).find((t) => t.id === tabId);
      if (isResilientReconnectTab(tab)) {
        mirrorSessionIntent("session.reconnect", tabId);
      } else {
        mirrorSessionIntent("session.dropped", tabId);
      }
    }
  },
  terminalAgentDisconnected: {},
  setTerminalAgentDisconnected: (tabId) => {
    get().setTerminalExited(tabId, { code: null, reason: "killed" });
    set((state) => ({
      terminalAgentDisconnected: { ...state.terminalAgentDisconnected, [tabId]: true },
    }));
  },
  markSessionKilled: (sessionId) =>
    set((state) => ({
      intentionallyKilledSessions: {
        ...state.intentionallyKilledSessions,
        [sessionId]: true,
      },
    })),
  consumeSessionKilled: (sessionId) => {
    const wasKilled = !!get().intentionallyKilledSessions[sessionId];
    if (wasKilled) {
      set((state) => ({
        intentionallyKilledSessions: omitKey(state.intentionallyKilledSessions, sessionId),
      }));
    }
    return wasKilled;
  },
  setTerminalDisconnectWithError: (tabId, error) => {
    // Session-intents cut (#2203): a failed (re)connect is a terminal
    // `session.connectFailed` — the sole record of the exit + error now the
    // per-client `terminalExitedTabs` / `terminalDisconnectErrors` slices are
    // deleted (#2625). The fold lands the region on `failed` + `error`, so
    // `regionExited` mounts the overlay and `effectiveDisconnectError` renders the
    // message. Skipped while the region shows the tab reconnecting — the backend
    // redrive owns that loop's outcome and folds the give-up (`reconnectFailed` →
    // `failed`) itself (#2205 PR-B), so a client `connectFailed` would be a
    // divergent second signal.
    if (currentSessionView()[tabId]?.status !== "reconnecting") {
      mirrorSessionIntent("session.connectFailed", tabId, error);
    }
    // A failed (re)connect settles this tab as failed in any in-flight
    // restore/launch cohort so the aggregate summary reflects it (#1146).
    get().settleRestoreTab(tabId, "failed");
    const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
    if (deadKey && currentMonitorsView().monitors[deadKey]) {
      get().disconnectMonitoring(deadKey);
    }
  },
  settleBackendReconnectGaveUp: (tabId, _error) => {
    // The backend already folded the give-up (region → Failed/gaveup with the
    // error) — that fold is now the sole record: `regionExited` mounts the
    // overlay and `effectiveDisconnectError` renders the message, so no
    // `terminalExitedTabs` / `terminalDisconnectErrors` write (and no use of the
    // `error` arg) is needed here (#2625).
    // Still clear every in-flight connect flag (deadline / waiting / auto-retry /
    // spawn-error) — those stay per-client (not region-covered) — so no competing
    // overlay lingers over the give-up state.
    set((state) => ({
      terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
      terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
      terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
      terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
    }));
    get().settleRestoreTab(tabId, "failed");
    const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
    if (deadKey && currentMonitorsView().monitors[deadKey]) {
      get().disconnectMonitoring(deadKey);
    }
  },

  settleSessionLost: (tabId) => {
    // The backend folded `session.sessionLost` into the region (the live agent
    // session was unrecoverable), landing status `SessionLost` — `regionExited`
    // is true for it, so the disconnect overlay mounts and renders the projected
    // session-lost notice with no client write needed (#2625). Still clear the
    // per-client in-flight connect flags (not region-covered) so no competing
    // overlay lingers. Deliberately no disconnect-error signal — the session-lost
    // variant sources its message from the region, and a `failed` error would
    // otherwise drive the generic "Reconnect failed" variant.
    set((state) => ({
      terminalConnectDeadline: omitKey(state.terminalConnectDeadline, tabId),
      terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
      terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
      terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
    }));
    get().settleRestoreTab(tabId, "failed");
    const deadKey = monitorKeyForTab(collectLiveTabs(get()).find((t) => t.id === tabId));
    if (deadKey && currentMonitorsView().monitors[deadKey]) {
      get().disconnectMonitoring(deadKey);
    }
  },

  startFreshShellForTab: (tabId) => {
    // Arm the one-shot force-fresh flag first so the reconnect effect (re-run by
    // reconnectTerminal bumping the retry counter) reads it and skips the
    // re-attach branch, creating a brand-new session instead.
    set((state) => ({
      terminalForceFreshReconnect: { ...state.terminalForceFreshReconnect, [tabId]: true },
    }));
    get().reconnectTerminal(tabId);
  },
  setTerminalReattaching: (tabId, reattaching) =>
    set((state) => ({
      terminalReattaching: reattaching
        ? { ...state.terminalReattaching, [tabId]: true }
        : omitKey(state.terminalReattaching, tabId),
    })),
  dismissTerminalDisconnect: (tabId) =>
    set((state) => ({
      // The region keeps the terminal status / `exit` so the banner can detect the
      // dead session (`regionExited`, #2625); only flip the overlay off here by
      // entering view mode.
      terminalViewMode: { ...state.terminalViewMode, [tabId]: true },
    })),
  disconnectTerminal: (tabId) => {
    // Explicit user Disconnect (UX-015): drop the live backend connection but
    // keep the tab open in a reconnectable state — distinct from closeTab, which
    // tears the tab down and loses its scrollback. Reuses the same intentional-
    // kill path the Open Connections panel uses: tag the kill so the terminal-
    // exit handler folds it as a user disconnect (view mode + Reconnect banner),
    // not an unexpected drop, then drop the session. A persistent daemon-backed
    // tab detaches (leaving the remote session running to re-attach on reconnect)
    // rather than killing it; every other type closes. No live session → no-op.
    const tab = collectLiveTabs(get()).find((t) => t.id === tabId);
    const sessionId = tab?.sessionId;
    if (!tab || !sessionId) return;
    get().markSessionKilled(sessionId);
    const drop = tab.persistentConnectionId
      ? apiDetachPersistentTab(sessionId, tabId)
      : apiCloseTerminal(sessionId, true);
    fireAndForget(drop, `disconnect session ${sessionId} for tab ${tabId}`, "error");
  },
  reconnectTerminal: (tabId) =>
    set((state) => {
      // Backend-driven resilient reconnect (#2476 agent, SM-004 direct SSH): the
      // backend redrive is the sole reconnect authority for EVERY resilient tab
      // since #2205 PR-B — its park/retry loop legitimately outlasts the fixed
      // 90 s "connecting" deadline on a prolonged drop, and Terminal.tsx's
      // region-`reconnecting` branch waits for the backend outcome for direct SSH
      // just as it does for agent tabs. Arming a client wall-clock deadline here
      // would let it force-fail a tab the backend is still legitimately
      // recovering (agent AND direct SSH alike), so a resilient reconnect leaves
      // the deadline cleared — the backend give-up fold, not a client timer, is
      // what settles the tab (the give-up-aware wait in Terminal.tsx resolves
      // it). A non-resilient tab has no backend retry loop, so it keeps the
      // safety-net deadline (and a manual reconnect re-arms it via
      // `setTerminalConnecting(true)` on the client `createTerminal` path).
      const deferToBackendLoop = isResilientReconnectTabId(tabId);
      // The exited / exit-info / disconnect-error view-state now lives purely in
      // the region (#2625): a manual reconnect's `setTerminalConnecting(true)`
      // dispatches `session.connect` (region → connecting, clears `exit`); a
      // backend-driven reconnect keeps the region `reconnecting` — either way
      // `regionExited` goes false, so no client clear is needed here.
      return {
        terminalViewMode: omitKey(state.terminalViewMode, tabId),
        terminalAgentDisconnected: omitKey(state.terminalAgentDisconnected, tabId),
        terminalReconnectPrompt: omitKey(state.terminalReconnectPrompt, tabId),
        terminalAutoRetryCount: omitKey(state.terminalAutoRetryCount, tabId),
        terminalWaitingForAgent: omitKey(state.terminalWaitingForAgent, tabId),
        terminalSpawnErrors: omitKey(state.terminalSpawnErrors, tabId),
        // The projected `connecting` status now drives the "Connecting…" overlay
        // (#2205 PR-B). A manual reconnect starts a fresh client connect whose
        // `setTerminalConnecting(true)` dispatches `session.connect` (region →
        // connecting); a backend-driven reconnect keeps the region `reconnecting`.
        // Fresh reconnect attempt: arm a new connecting deadline (any prior one
        // was cleared on disconnect) so the wall-clock timeout starts now —
        // except for a backend-driven agent reconnect, which owns its own timing.
        terminalConnectDeadline: deferToBackendLoop
          ? omitKey(state.terminalConnectDeadline, tabId)
          : {
              ...state.terminalConnectDeadline,
              [tabId]: {
                kind: "connecting" as const,
                at: Date.now() + connectTimeoutMs("connecting"),
              },
            },
        terminalRetryCounters: {
          ...state.terminalRetryCounters,
          [tabId]: (state.terminalRetryCounters[tabId] ?? 0) + 1,
        },
      };
    }),
  showTerminalReconnectPrompt: (tabId) =>
    set((state) => ({
      terminalReconnectPrompt: { ...state.terminalReconnectPrompt, [tabId]: true },
    })),
  dismissTerminalReconnectPrompt: (tabId) =>
    set((state) => ({ terminalReconnectPrompt: omitKey(state.terminalReconnectPrompt, tabId) })),

  cancelAutoReconnect: (tabId, error) => {
    // The reconnect loop lives entirely in the region now (#2205 PR-B). No active
    // loop → nothing to cancel (avoid spuriously forcing the overlay).
    if (currentSessionView()[tabId]?.status !== "reconnecting") return;
    // The user stopped the loop: fold the region out of reconnecting
    // (`session.cancelReconnect` → disconnected, `endReason: user`) — the backend
    // is the sole reconnect authority.
    mirrorSessionIntent("session.cancelReconnect", tabId, error ?? undefined);
    // The `session.cancelReconnect` fold lands the region on `disconnected`
    // (`endReason: user`), which is enough for `regionExited` to mount the
    // standard disconnect overlay (Reconnect / View Scrollback) once the region
    // leaves reconnecting — no client exited write is needed (#2625).
    if (error) {
      // Stopped with a reason (attempts exhausted): show the "Reconnect failed"
      // overlay with that message. `setTerminalDisconnectWithError` folds
      // `session.connectFailed` → `failed` + `error` (the region carries both).
      get().setTerminalDisconnectWithError(tabId, error);
    }
  },
});
