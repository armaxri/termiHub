/**
 * The `agent-state-change` handler {@link TerminalView} registers, their helpers, and the agent-session connect-failure catch in
 * {@link Terminal}.
 *
 * Extracted so the branch logic can be unit-tested directly against the store
 * without rendering the whole component (avoids simulation drift — the real
 * handler and the tests exercise the exact same code).
 */
import { useAppStore } from "@/store/appStore";
import { currentAgentsView } from "@/store/agentsBridge";
import {
  clearAgentDisconnectIntent,
  consumeAgentDisconnectIntent,
} from "@/store/agentDisconnectIntent";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import { currentSessionView, type ProjectedSessionStatus } from "@/store/sessionBridge";
import { listAgentSessions as apiListAgentSessions } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";
import type { AgentSessionInfo } from "@/types/generated/AgentSessionInfo";
import { TerminalTab } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";
import { errorMessage } from "@/utils/errorMessage";
import { backendErrorMessage, isAuthFailure } from "@/utils/backendErrorCode";
import { frontendLog } from "@/utils/frontendLog";
import { resolveAgentSpawnAction, type AgentSpawnAction } from "./terminalConnectionPlan";

/**
 * Apply the agent `reconnecting` transition to every terminal tab owned by the
 * agent (G8, #1242).
 *
 * Two cases, so every agent tab gets honest feedback during a drop:
 * - **Live-session tabs** (`sessionId` set): the shared `session-lifecycle`
 *   region — the sole reconnecting source for the overlay + tab-strip dot — is
 *   folded to `reconnecting` **server-side** by `agent_io_task` at the source of
 *   the transient break (#2556), so no client fold happens here; the frontend
 *   only tracks the count for the log.
 * - **Spawning tabs** (still mid `connection.create`, no `sessionId` yet): park
 *   them on the waiting-for-agent path so they retry once the agent is back,
 *   instead of being skipped and landing on an ambiguous spawn error.
 *
 * @param agentId The agent whose link is reconnecting.
 * @param agentTerminalTabs Terminal tabs belonging to this agent (pre-filtered).
 * @param error Optional error that triggered the reconnect.
 */
export function applyAgentReconnecting(
  agentId: string,
  agentTerminalTabs: TerminalTab[],
  _error: string | undefined
): void {
  const store = useAppStore.getState();
  let reconnectingCount = 0;
  let waitingCount = 0;
  for (const tab of agentTerminalTabs) {
    if (tab.sessionId) {
      // Live session — the backend `agent_io_task` folds this tab's region entry
      // to `reconnecting` at the source of the transient break (#2556), so the
      // client no longer mirrors it. The overlay + tab-strip dot already source
      // `reconnecting` purely from the region (#2554/#2205 PR-B), so the server
      // fold is all that is needed; the trigger error is folded there too.
      reconnectingCount++;
    } else {
      // Still spawning (no sessionId yet): park on the waiting path so the tab
      // retries once the agent reconnects, rather than surfacing a spawn error.
      store.setTerminalWaitingForAgent(tab.id, agentId);
      waitingCount++;
    }
  }
  frontendLog(
    "disconnect",
    `agent reconnecting: ${reconnectingCount} tabs marked reconnecting, ` +
      `${waitingCount} spawning tabs parked waiting for agent=${agentId}`
  );
}

/**
 * The pre-`connected` store snapshot the `connected` branch reads its gates from.
 *
 * The handler captures `useAppStore.getState()` once, before awaiting the
 * recovered-session list, and both the wake loop and the retry-restart loop read
 * their conditions from that same snapshot. Reading the *original* waiting map in
 * the restart loop is what stops a tab the wake loop just un-parked from being
 * woken a second time (#3686 keeps this exactly as the inline code had it).
 */
export type AgentConnectedSnapshot = Readonly<
  Pick<
    ReturnType<typeof useAppStore.getState>,
    "terminalWaitingForAgent" | "terminalSpawnErrors" | "terminalAutoRetryCount"
  >
>;

/**
 * Wake every tab parked waiting for `agentId` once that agent emits `connected`
 * (MT-AGENT-11/30).
 *
 * A parked tab is un-parked and its retry counter bumped (`retryTerminalSpawn`),
 * which re-runs the Terminal's setup effect and spawns a fresh session.
 *
 * @param agentId The agent that just connected.
 * @param agentTerminalTabs Terminal tabs belonging to this agent (pre-filtered).
 * @param snapshot The store snapshot captured at the start of the handler.
 * @returns How many tabs were woken.
 */
export function wakeWaitingAgentTabs(
  agentId: string,
  agentTerminalTabs: TerminalTab[],
  snapshot: AgentConnectedSnapshot
): number {
  const store = useAppStore.getState();
  let wokeCount = 0;
  for (const tab of agentTerminalTabs) {
    if (snapshot.terminalWaitingForAgent[tab.id] === agentId) {
      frontendLog("disconnect", `agent connected: waking waiting tab=${tab.id}`);
      store.setTerminalWaitingForAgent(tab.id, null);
      store.retryTerminalSpawn(tab.id);
      wokeCount++;
    }
  }
  frontendLog("disconnect", `agent connected: woke ${wokeCount} waiting tabs`);
  return wokeCount;
}

/**
 * Restart this agent's tabs that sit in a connection-overlay state (auto-retry
 * delay or "Connection failed") once the agent emits `connected`.
 *
 * These tabs are not reachable via the reconnecting/waiting paths, so
 * `reconnectTerminal` cancels the stale retry loop and kicks off a fresh attempt.
 * Tabs that were waiting (handled by {@link wakeWaitingAgentTabs}, judged on the
 * same snapshot) or are actively connecting are left alone.
 *
 * @param agentTerminalTabs Terminal tabs belonging to this agent (pre-filtered).
 * @param snapshot The store snapshot captured at the start of the handler.
 * @returns How many tabs were restarted.
 */
export function restartAgentRetryTabs(
  agentTerminalTabs: TerminalTab[],
  snapshot: AgentConnectedSnapshot
): number {
  const store = useAppStore.getState();
  let restartedRetryCount = 0;
  for (const tab of agentTerminalTabs) {
    const hasSpawnError = !!snapshot.terminalSpawnErrors[tab.id];
    const isAutoRetrying = (snapshot.terminalAutoRetryCount[tab.id] ?? 0) > 0;
    const wasWaiting = !!snapshot.terminalWaitingForAgent[tab.id];
    const isConnecting = currentSessionView()[tab.id]?.status === "connecting";
    if ((hasSpawnError || isAutoRetrying) && !wasWaiting && !isConnecting) {
      frontendLog("disconnect", `agent connected: restarting retry tab=${tab.id}`);
      store.reconnectTerminal(tab.id);
      restartedRetryCount++;
    }
  }
  frontendLog("disconnect", `agent connected: restarted ${restartedRetryCount} retry tabs`);
  return restartedRetryCount;
}

/** Input for {@link applyAgentSpawnFailure}. */
export interface AgentSpawnFailureInput {
  /** The tab whose `createTerminal` attempt failed. */
  tabId: string;
  /** The agent hosting the tab's session. */
  agentId: string;
  /** The rejection from `createTerminal`. */
  err: unknown;
  /** Attempts already made for this tab (the loop's pre-increment counter). */
  attempt: number;
  /** Maximum bounded retries before giving up. */
  maxAttempts: number;
  /** Records the classified spawn error on the tab (the overlay's failure text). */
  setClassifiedSpawnError: (tabId: string, err: unknown) => void;
}

/**
 * Handle a failed agent-session `createTerminal` attempt (MT-AGENT-17/30).
 *
 * Reads the agent's transport state, decides via {@link resolveAgentSpawnAction}
 * and applies the effects of every *terminal* outcome:
 *
 * - `authFailed` — stop with the typed auth error (credential re-entry, #3089);
 * - `waitForAgent` — the transport is still (re)connecting: park the tab; the
 *   `agent-state-change` handler wakes it via {@link wakeWaitingAgentTabs};
 * - `reconnectAgentThenWait` — the transport is gone: park the tab and
 *   re-establish the agent **once**; if that fails while the tab is still parked
 *   on this agent, un-park it and surface "Could not reconnect to agent: …";
 * - `giveUp` — the bounded retries are exhausted: surface the error.
 *
 * `retryAfterDelay` has no effect here — the caller owns the visible failure
 * display and the backoff delays of its retry loop.
 *
 * @returns The chosen action, so the caller can stop or continue its loop.
 */
export function applyAgentSpawnFailure(input: AgentSpawnFailureInput): AgentSpawnAction {
  const { tabId, agentId, err, attempt, maxAttempts, setClassifiedSpawnError } = input;

  // Check whether the agent transport itself is still connecting.
  const agentState = currentAgentsView().remoteAgents.find(
    (a) => a.id === agentId
  )?.connectionState;

  // The *decision* is a pure function of the agent transport state and the
  // bounded attempt counter (FEC-016); the effects for the chosen action run below.
  const action = resolveAgentSpawnAction({
    agentState,
    attempt,
    maxAttempts,
    authFailed: isAuthFailure(err),
  });

  if (action.kind === "authFailed") {
    // The agent-hosted server rejected the credentials (#3089): stop here with the
    // typed auth error, so the overlay offers credential re-entry instead of
    // retrying a doomed login.
    useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
    setClassifiedSpawnError(tabId, err);
  } else if (action.kind === "waitForAgent") {
    // Park tab; TerminalView wakes it via retryTerminalSpawn once the agent emits
    // "connected".
    useAppStore.getState().setTerminalWaitingForAgent(tabId, agentId);
  } else if (action.kind === "reconnectAgentThenWait") {
    // The agent transport itself is gone — retrying createTerminal would fail with
    // "Agent not connected" forever. Re-establish the agent connection and park the
    // tab; TerminalView wakes it (retryTerminalSpawn) once the agent emits
    // "connected", at which point a fresh session is created. This is what makes
    // reconnect actually restart the connection instead of looping.
    useAppStore.getState().setTerminalWaitingForAgent(tabId, agentId);
    void useAppStore
      .getState()
      .connectRemoteAgent(agentId)
      .catch((e) => {
        const s = useAppStore.getState();
        // Only surface the failure if this tab is still parked on this agent
        // (avoid clobbering a state another path set).
        if (s.terminalWaitingForAgent[tabId] === agentId) {
          s.setTerminalWaitingForAgent(tabId, null);
          s.setTerminalDisconnectWithError(
            tabId,
            `Could not reconnect to agent: ${backendErrorMessage(e)}`
          );
        }
      });
  } else if (action.kind === "giveUp") {
    // Agent is up but the session creation kept failing and the bounded retries
    // are exhausted — surface an error instead of spinning forever.
    useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
    useAppStore.getState().setTerminalSpawnError(tabId, null);
    useAppStore.getState().setTerminalDisconnectWithError(tabId, backendErrorMessage(err));
  }
  return action;
}

// ── agent-state-change handler (TFE2-001, #4309) ─────────────────────────────

/**
 * Why the agent ended, carried on every backend "disconnected" event (#4447):
 * `user` / `shutdown` are user ends, `suspend` is a disconnect followed by a
 * reconnect (agent update, Force reconnect), `lost` is anything unexpected.
 */
export type AgentEndReason = "user" | "shutdown" | "suspend" | "lost";

/** Payload of the backend `agent-state-change` event (`session_id` is the agent id). */
export interface AgentStateChangePayload {
  session_id: string;
  state: string;
  error?: string;
  /** Set on "disconnected" only. */
  reason?: AgentEndReason;
  /**
   * The tabs the backend ended for a user Disconnect/Shutdown (#4459): their
   * region entries were live and are already folded `disconnected` / `user`.
   * Absent on older events and on every other end.
   */
  ended_tabs?: string[];
}

/** Injectable collaborators of the state-change handlers (defaults: the real ones). */
export interface StateChangeDeps {
  /** Lists the sessions an agent recovered after reconnecting. */
  listAgentSessions: (agentId: string) => Promise<Pick<AgentSessionInfo, "sessionId">[]>;
  /** Every tab across all tab groups. */
  getAllTabs: () => TerminalTab[];
}

// Resolved on call, not at import: many component tests mock these modules
// partially, and reading a missing export at module load would throw.
const DEFAULT_DEPS: StateChangeDeps = {
  listAgentSessions: (agentId) => apiListAgentSessions(agentId),
  getAllTabs: () => getAllTabsAcrossGroupTrees(),
};

/** Region statuses in which a tab has already ended and must be left alone. */
const ENDED_STATUSES: ReadonlySet<ProjectedSessionStatus> = new Set([
  "disconnected",
  "failed",
  "authFailed",
  "sessionLost",
  "evicted",
]);

/**
 * Whether a lost connection may still act on `tab`: it holds a session, the user
 * has not just stopped it (a kill still in flight), and the region does not
 * show it already ended — a user Stop, a give-up, a lost session or an
 * eviction. autoReconnect is on by default but must never override the user's
 * Stop (maintainer decision 2026-09-26).
 */
function tabStillLive(tab: TerminalTab): boolean {
  if (!tab.sessionId) return false;
  if (useAppStore.getState().intentionallyKilledSessions[tab.sessionId]) return false;
  const status = currentSessionView()[tab.id]?.status;
  return status === undefined || !ENDED_STATUSES.has(status);
}

/**
 * Whether a user end may present itself on `tab`: the backend just ended it
 * (#4459 — its region already reads `disconnected`, so {@link tabStillLive}
 * would skip it), or the event predates that list and the tab is still live.
 * A tab the user is killing, and one that ended before this event, are left
 * alone, so the presentation and the on-disconnect triggers run exactly once.
 */
function userEndApplies(tab: TerminalTab, endedTabs: readonly string[] | undefined): boolean {
  if (!endedTabs?.includes(tab.id)) return tabStillLive(tab);
  if (!tab.sessionId) return false;
  return !useAppStore.getState().intentionallyKilledSessions[tab.sessionId];
}

/** Terminal tabs whose connection config names `agentId`. */
function agentTerminalTabsOf(agentId: string, allTabs: TerminalTab[]): TerminalTab[] {
  // Matched via the connection config rather than `agentSessions`, which is
  // only filled on the first connect and so misses sessions opened later.
  return allTabs.filter(
    (tab) => tab.contentType === "terminal" && readConfigString(tab.config, "agentId") === agentId
  );
}

/**
 * The agent reconnected: resume tabs whose sessions it recovered, settle the
 * rest as session-lost, then wake parked tabs and restart failed ones.
 */
async function applyAgentConnected(
  agentId: string,
  agentTerminalTabs: TerminalTab[],
  snapshot: AgentConnectedSnapshot,
  listAgentSessions: StateChangeDeps["listAgentSessions"]
): Promise<void> {
  let recovered: Set<string>;
  try {
    recovered = new Set((await listAgentSessions(agentId)).map((s) => s.sessionId));
  } catch (err) {
    // Can't reach the agent — assume all sessions are gone (safe fallback).
    recovered = new Set();
    frontendLog("disconnect", `agent connected: failed to list sessions (${errorMessage(err)})`);
  }
  const view = currentSessionView();
  for (const tab of agentTerminalTabs) {
    // The region is authoritative for the break (#2555/#2556/#2564). The backend
    // folds a recovered session to `connected` and a gone one to `sessionLost`;
    // that fold races this handler, so accept either break status here.
    const status = view[tab.id]?.status;
    if (status !== "reconnecting" && status !== "sessionLost") continue;
    if (tab.sessionId && recovered.has(tab.sessionId)) continue;
    // Gone: only clear the per-client in-flight flags — the backend already
    // folded `sessionLost`; re-driving the region would double-fold.
    useAppStore.getState().settleSessionLost(tab.id);
  }
  // Both gate on the pre-connect snapshot so a woken tab is not restarted too.
  wakeWaitingAgentTabs(agentId, agentTerminalTabs, snapshot);
  restartAgentRetryTabs(agentTerminalTabs, snapshot);
}

/**
 * Whether a "disconnected" event is a user end. The backend reason is the
 * authority and reaches every window (#4447); the window that clicked also
 * recorded a local intent (#4309), kept as a fallback and always consumed so it
 * never outlives this event.
 */
function isUserEnd(agentId: string, reason: AgentEndReason | undefined): boolean {
  const localIntent = consumeAgentDisconnectIntent(agentId);
  return reason === "user" || reason === "shutdown" || localIntent;
}

/**
 * The agent's transport ended. A user Disconnect/Shutdown ends each live tab
 * cleanly (#4309, in every window since #4447; the backend folds the region
 * itself since #4459, and this applies the presentation); an unexpected loss or a suspend
 * arms the backend reconnect; a backend give-up (`error`) reflects the
 * server-folded `failed` state.
 */
function applyAgentDisconnected(
  agentId: string,
  agentTerminalTabs: TerminalTab[],
  error: string | undefined,
  reason: AgentEndReason | undefined,
  endedTabs: readonly string[] | undefined
): void {
  const store = useAppStore.getState();
  const intentional = isUserEnd(agentId, reason);
  let ended = 0;
  for (const tab of agentTerminalTabs) {
    if (intentional) {
      // The disconnect deleted the agent's retained config, so a reconnect loop
      // could never succeed: end the tab with a manual Reconnect instead. The
      // backend already folded the region for the tabs it lists (#4459); the
      // `session.disconnect` this mirrors again is idempotent, and the view mode
      // and banner are this window's own presentation.
      if (!userEndApplies(tab, endedTabs)) continue;
      store.setTerminalAgentDisconnected(tab.id);
    } else if (error) {
      // Backend gave up (#2612/#2564): it folded `failed` at the source; only
      // clear the per-client in-flight flags here.
      if (!tab.sessionId) continue;
      store.settleBackendReconnectGaveUp(tab.id, error);
    } else {
      if (!tabStillLive(tab)) continue;
      store.setTerminalExited(tab.id, { code: null, reason: "dropped" });
    }
    ended++;
  }
  frontendLog(
    "disconnect",
    `agent disconnected (${intentional ? "by user" : error ? "gave up" : "lost"}): ${ended} tabs updated`
  );
  // Live sessions are gone; saved definitions/folders stay (they live on disk).
  store.clearAgentSessions(agentId);
}

/**
 * Handle one backend `agent-state-change` event — the function `TerminalView`
 * registers with `listen`, extracted so tests exercise the real code.
 */
export async function handleAgentStateChange(
  payload: AgentStateChangePayload,
  deps: Partial<StateChangeDeps> = {}
): Promise<void> {
  const { listAgentSessions, getAllTabs } = { ...DEFAULT_DEPS, ...deps };
  const { session_id: agentId, state, error, reason, ended_tabs: endedTabs } = payload;
  frontendLog("disconnect", `agent-state-change agent=${agentId} state=${state}`);
  const store = useAppStore.getState();
  store.setAgentConnectionState(agentId, state as RemoteAgentDefinition["connectionState"], error);
  const agentTerminalTabs = agentTerminalTabsOf(agentId, getAllTabs());

  if (state === "connecting" || state === "connected") {
    // A new connection makes any leftover disconnect intent stale.
    clearAgentDisconnectIntent(agentId);
  }
  if (state === "connected") {
    await applyAgentConnected(agentId, agentTerminalTabs, store, listAgentSessions);
  } else if (state === "reconnecting") {
    applyAgentReconnecting(agentId, agentTerminalTabs, error);
  } else if (state === "disconnected") {
    applyAgentDisconnected(agentId, agentTerminalTabs, error, reason, endedTabs);
  }
}
