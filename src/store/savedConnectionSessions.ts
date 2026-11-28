/**
 * Open sessions of a saved connection that a save did not change (#6163).
 *
 * A session keeps the settings it was opened with: saving a connection never
 * reaches into a running session. After a save that changed what a session
 * uses, the user is told which sessions still run on the old settings and can
 * reconnect them, in place, with the saved ones.
 *
 * Reconnect now runs nothing that the user did not just confirm: the editor's
 * save is what confirms a changed connection's commands (#6065,
 * `savedConnectionTrust`), and the reconnect goes through each tab's own
 * reconnect path, whose new stream supersedes the old one's exit (#6032).
 * Persistent sessions are left out: they run on in the background, maybe for
 * other windows, and are not restarted by a save.
 */
import { toast } from "@/components/ui";
import { closeTerminal } from "@/services/api";
import type { SavedConnection } from "@/types/connection";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { useAppStore } from "./appStore";
import { collectLiveTabs } from "./layoutHelpers";
import { currentSessionView, regionExited } from "./sessionBridge";

/** The tabs of `connectionId` whose live session runs on the settings it opened with. */
export function sessionsOnOldSettings(connectionId: string): TerminalTab[] {
  const sessions = currentSessionView();
  return collectLiveTabs(useAppStore.getState()).filter(
    (tab) =>
      tab.contentType === "terminal" &&
      tab.connectionId === connectionId &&
      !!tab.sessionId &&
      !tab.persistentConnectionId &&
      !regionExited(sessions[tab.id])
  );
}

/** Whether a save changed what a session of the connection uses. */
export function sessionSettingsChanged(before: SavedConnection, after: SavedConnection): boolean {
  return (
    JSON.stringify(before.config) !== JSON.stringify(after.config) ||
    JSON.stringify(before.terminalOptions ?? null) !== JSON.stringify(after.terminalOptions ?? null)
  );
}

/**
 * Reconnect `tabIds` with `config`: each tab takes the saved settings, its old
 * session is closed as the user's own, and the tab reconnects in place, keeping
 * its scrollback.
 */
export function reconnectWithSavedSettings(tabIds: readonly string[], config: ConnectionConfig) {
  const state = useAppStore.getState();
  const live = new Map(collectLiveTabs(state).map((tab) => [tab.id, tab]));
  const tabContent = { ...state.tabContent };
  for (const id of tabIds) {
    if (tabContent[id]) tabContent[id] = { ...tabContent[id], config };
  }
  useAppStore.setState({ tabContent });
  for (const id of tabIds) {
    const sessionId = live.get(id)?.sessionId;
    // The reconnect replaces the tab's stream first, so the old session's end
    // never reaches the tab; then the old session is closed.
    useAppStore.getState().reconnectTerminal(id);
    if (!sessionId) continue;
    useAppStore.getState().markSessionKilled(sessionId);
    void Promise.resolve(closeTerminal(sessionId, true)).catch((err: unknown) => {
      useAppStore.getState().consumeSessionKilled(sessionId);
      frontendLog("connections", `closing ${sessionId} to reconnect failed: ${errorMessage(err)}`);
    });
  }
}

/**
 * After `before` was saved as `after`: say how many open sessions keep the old
 * settings, with "Reconnect now". Nothing when none does, or when the save
 * changed nothing they use.
 */
export function announceSessionsOnOldSettings(
  before: SavedConnection,
  after: SavedConnection
): void {
  if (!sessionSettingsChanged(before, after)) return;
  const tabs = sessionsOnOldSettings(before.id);
  if (tabs.length === 0) return;
  const one = tabs.length === 1;
  const ids = tabs.map((tab) => tab.id);
  // toast-policy: off-screen — the sessions run in other tabs, which the editor does not show
  toast.info(
    one
      ? `1 open session of “${after.name}” keeps the old settings until it reconnects`
      : `${tabs.length} open sessions of “${after.name}” keep the old settings until they reconnect`,
    {
      action: {
        label: "Reconnect now",
        onClick: () => reconnectWithSavedSettings(ids, after.config),
      },
    }
  );
}
