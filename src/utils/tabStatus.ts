/**
 * Per-tab connection status derived from the real terminal-lifecycle maps.
 *
 * All of these maps are keyed by `tab.id` (unlike the legacy `remoteStates`
 * map, which is keyed by `session_id` and fed by a never-firing event), so the
 * derived status stays correct for every tab — including background/inactive
 * ones — without needing the tab to be focused.
 */
export type TabStatus = "connecting" | "connected" | "failed" | "disconnected";

/**
 * The subset of the app store's tab-lifecycle maps needed to derive a tab's
 * connection status. Each is a `Record<tabId, …>`; presence of a key is what
 * matters (error maps also carry a message, but the status only needs the key).
 */
export interface TabStatusMaps {
  /** True while a createTerminal call is in-flight. */
  terminalConnecting: Record<string, boolean>;
  /** True while the agent is actively trying to reconnect. */
  terminalReconnectingTabs: Record<string, boolean>;
  /** Spawn error message for a tab whose terminal failed to start. */
  terminalSpawnErrors: Record<string, string>;
  /** Error message from a failed reconnect (agent auto-reconnect exhausted). */
  terminalDisconnectErrors: Record<string, string>;
  /** True when a tab's terminal session has exited. */
  terminalExitedTabs: Record<string, boolean>;
}

/**
 * Derive the connection-status dot for a single tab from the tab-id-keyed
 * lifecycle maps.
 *
 * Priority order (most transient / most severe first):
 *  1. `connecting`   — a connect or reconnect attempt is in flight.
 *  2. `failed`       — a spawn or reconnect attempt errored out.
 *  3. `disconnected` — the session exited without a recorded error.
 *  4. `connected`    — no lifecycle flags set (the live, healthy state).
 *
 * @param maps  The tab-lifecycle maps (typically a slice of the app store).
 * @param tabId The tab whose status to derive.
 */
export function deriveTabStatus(maps: TabStatusMaps, tabId: string): TabStatus {
  if (maps.terminalConnecting[tabId] || maps.terminalReconnectingTabs[tabId]) {
    return "connecting";
  }
  if (maps.terminalSpawnErrors[tabId] || maps.terminalDisconnectErrors[tabId]) {
    return "failed";
  }
  if (maps.terminalExitedTabs[tabId]) {
    return "disconnected";
  }
  return "connected";
}
