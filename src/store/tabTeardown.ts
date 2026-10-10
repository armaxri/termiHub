import type { AppState } from "./appStore";
import { collectWindowTabs, omitKey, type LayoutViewState } from "./layoutHelpers";
import { mirrorSessionIntent } from "./sessionBridge";
import { currentBroadcastView } from "./broadcastBridge";

/**
 * Shared per-tab / per-session teardown (#4313, audit-2026-10 FES2-002 /
 * FES2-007).
 *
 * A tab leaves a window in three ways — it is closed (`closeTab`), closed with
 * its whole tab group (`closeTabGroup`, #4453), or handed off to another window
 * (`moveTabToWindow`, where the destination mints a fresh tab id). All must drop every piece of state keyed by the departing tab id, or it leaks
 * for the life of the window and of the shared regions, and a later tab that
 * reuses the id would inherit it. Before this helper each seam hand-pruned its
 * own list and the move seam pruned nothing.
 *
 * Kept out of here on purpose: backend ownership release and on-disconnect
 * workflow triggers. Those belong to a *close* only — a moved session keeps
 * running and the destination window owns it.
 */

/** Every per-tab `Record<tabId, …>` map pruned when a tab leaves the window. */
export const PER_TAB_STATE_KEYS = [
  "tabContent",
  "tabCwds",
  "tabHorizontalScrolling",
  "editorDirtyTabs",
  "tabColors",
  "tabTerminalOptions",
  "terminalSearchVisible",
  "terminalSpawnErrors",
  "terminalSpawnErrorKinds",
  "terminalRetryCounters",
  "terminalConnectDeadline",
  "terminalViewMode",
  "terminalAgentDisconnected",
  "terminalReattaching",
  "terminalReconnectPrompt",
  "terminalAutoRetryCount",
  "terminalWaitingForAgent",
  "terminalForceFreshReconnect",
] as const satisfies readonly (keyof AppState)[];

type PerTabStateKey = (typeof PER_TAB_STATE_KEYS)[number];

/** Session-keyed maps pruned when no tab in the window shows the session any more. */
type PerSessionStateKey = "sessionCapabilities" | "sessionHighlighting";

export type TabTeardownPatch = Pick<AppState, PerTabStateKey | "persistentSessions"> &
  Partial<Pick<AppState, PerSessionStateKey>>;

/** The source fields {@link prunedTabState} reads. */
type TabTeardownSource = LayoutViewState &
  Pick<AppState, PerTabStateKey | "persistentSessions" | PerSessionStateKey>;

/**
 * Pure state patch that removes everything keyed by `tabId`: its entry in every
 * per-tab map, its id in any persistent session's `attachedTabIds`, and — when
 * no other tab in the window still shows it — the session-keyed entries of the
 * tab's session.
 */
export function prunedTabState(state: TabTeardownSource, tabId: string): TabTeardownPatch {
  return prunedTabsState(state, [tabId]);
}

/**
 * {@link prunedTabState} for several tabs leaving the window at once — a whole
 * tab group closing (#4453). A session shown only by departing tabs has its
 * session-keyed entries dropped even when several of them show it; one still
 * shown by a tab that stays is kept.
 */
export function prunedTabsState(
  state: TabTeardownSource,
  tabIds: readonly string[]
): TabTeardownPatch {
  const departing = new Set(tabIds);

  const perTab = {} as Pick<AppState, PerTabStateKey>;
  for (const key of PER_TAB_STATE_KEYS) {
    let map = state[key] as Record<string, unknown>;
    for (const tabId of tabIds) map = omitKey(map, tabId);
    (perTab as Record<string, unknown>)[key] = map;
  }

  let persistentSessions = state.persistentSessions;
  for (const [connId, entry] of Object.entries(state.persistentSessions)) {
    if (entry.attachedTabIds.some((id) => departing.has(id))) {
      if (persistentSessions === state.persistentSessions) {
        persistentSessions = { ...state.persistentSessions };
      }
      persistentSessions[connId] = {
        ...entry,
        attachedTabIds: entry.attachedTabIds.filter((id) => !departing.has(id)),
      };
    }
  }

  const windowTabs = collectWindowTabs(state);
  const departingSessions = new Set(
    windowTabs.filter((t) => departing.has(t.id) && t.sessionId).map((t) => t.sessionId as string)
  );
  let sessionPatch: Partial<Pick<AppState, PerSessionStateKey>> = {};
  for (const sessionId of departingSessions) {
    const patch = prunedSessionState(
      { ...state, ...sessionPatch },
      sessionId,
      departing,
      windowTabs
    );
    sessionPatch = { ...sessionPatch, ...patch };
  }

  return { ...perTab, persistentSessions, ...sessionPatch };
}

/**
 * Pure state patch that drops `sessionId`'s session-keyed entries unless a tab
 * in this window other than the departing one(s) still shows that session.
 * Returns an empty patch when the session is still in use.
 */
export function prunedSessionState(
  state: LayoutViewState & Pick<AppState, PerSessionStateKey>,
  sessionId: string,
  departingTabIds: string | ReadonlySet<string>,
  windowTabs = collectWindowTabs(state)
): Partial<Pick<AppState, PerSessionStateKey>> {
  const isDeparting =
    typeof departingTabIds === "string"
      ? (id: string) => id === departingTabIds
      : (id: string) => departingTabIds.has(id);
  const stillShown = windowTabs.some((t) => !isDeparting(t.id) && t.sessionId === sessionId);
  if (stillShown) return {};
  return {
    sessionCapabilities: omitKey(state.sessionCapabilities, sessionId),
    sessionHighlighting: omitKey(state.sessionHighlighting, sessionId),
  };
}

/**
 * Release a departing tab from the shared, cross-window regions: drop its
 * session-lifecycle record (#2203) and its broadcast membership (#1955) —
 * departing as the source ends broadcast, departing as a target leaves the set.
 */
export function releaseTabFromSharedRegions(
  get: () => Pick<AppState, "stopBroadcast" | "removeBroadcastTarget">,
  tabId: string
): void {
  mirrorSessionIntent("session.remove", tabId);

  const bcView = currentBroadcastView();
  if (!bcView.active) return;
  if (bcView.sourceTabId === tabId) {
    get().stopBroadcast();
  } else if (bcView.targetTabIds.includes(tabId)) {
    get().removeBroadcastTarget(tabId);
  }
}
