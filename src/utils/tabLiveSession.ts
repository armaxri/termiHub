import { TerminalTab } from "@/types/terminal";

/**
 * The subset of the app store's tab-lifecycle maps needed to decide whether a
 * tab still holds a *live* backend session. Each is a `Record<tabId, …>`;
 * presence of the key is what matters.
 */
export interface LiveSessionMaps {
  /** True when a tab's terminal session has exited. */
  terminalExitedTabs: Record<string, boolean>;
  /** Spawn error message for a tab whose terminal failed to start. */
  terminalSpawnErrors: Record<string, string>;
}

/**
 * Whether closing this tab would tear down a *live* session (SSH/serial/local
 * shell/telnet) — the destructive case that warrants a close confirmation.
 *
 * A tab is considered live when it is a terminal tab that has not exited and did
 * not fail to spawn. Non-terminal tabs (editors, settings, log viewer, …) never
 * hold a session. Tabs attached to a *persistent* background session are also
 * excluded: closing them merely detaches the tab, leaving the backend process
 * running, so nothing is destroyed.
 *
 * @param tab  The tab to test.
 * @param maps The lifecycle maps (typically a slice of the app store).
 */
export function tabHasLiveSession(
  tab: Pick<TerminalTab, "id" | "contentType" | "persistentConnectionId">,
  maps: LiveSessionMaps
): boolean {
  if (tab.contentType !== "terminal") return false;
  if (tab.persistentConnectionId) return false;
  if (maps.terminalExitedTabs[tab.id]) return false;
  if (maps.terminalSpawnErrors[tab.id]) return false;
  return true;
}

/**
 * Count how many tabs in a list hold a live session — used to make panel/tab
 * close confirmations count-aware.
 */
export function countLiveSessions(
  tabs: ReadonlyArray<Pick<TerminalTab, "id" | "contentType" | "persistentConnectionId">>,
  maps: LiveSessionMaps
): number {
  return tabs.reduce((n, tab) => (tabHasLiveSession(tab, maps) ? n + 1 : n), 0);
}
