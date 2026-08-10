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
  /**
   * True when a tab is in the terminal `sessionLost` state (#2512): the transport
   * came back but the live agent session could not be recovered. Sourced from the
   * projected `session-lifecycle` region (it has no `appStore` twin), so it is
   * optional — absent on the pre-cut path and for consumers that do not read the
   * region. Without it a lost session falls through to `connected` and shows a
   * stale-green dot (#2524).
   */
  terminalSessionLost?: Record<string, boolean>;
}

/**
 * Derive the connection-status dot for a single tab from the tab-id-keyed
 * lifecycle maps.
 *
 * Priority order (most severe / most terminal first):
 *  1. `disconnected` (session lost) — the live session is unrecoverable (#2512);
 *     this is terminal, so it wins over a lingering in-flight connect flag.
 *  2. `connecting`   — a connect or reconnect attempt is in flight.
 *  3. `failed`       — a spawn or reconnect attempt errored out.
 *  4. `disconnected` — the session exited without a recorded error.
 *  5. `connected`    — no lifecycle flags set (the live, healthy state).
 *
 * @param maps  The tab-lifecycle maps (typically a slice of the app store).
 * @param tabId The tab whose status to derive.
 */
export function deriveTabStatus(maps: TabStatusMaps, tabId: string): TabStatus {
  // Session-lost is a terminal outcome: the transport recovered but the live
  // session is gone (#2512). It takes precedence over the in-flight/error flags
  // so the dot never lingers green (or pulses "connecting") after the loss (#2524).
  if (maps.terminalSessionLost?.[tabId]) {
    return "disconnected";
  }
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
