import { useEffect } from "react";
import { toast } from "@/components/ui";
import type { ConnectionType } from "@/types/terminal";
import { deriveTabStatus, type TabStatusMaps } from "@/utils/tabStatus";

/**
 * The per-tab "Connected" confirmation (#1127, #5618).
 *
 * Each tab's toast has a stable id, so a reconnect replaces it instead of
 * stacking a second one, and the toast is dismissed as soon as the tab leaves
 * the connected state: a "Session disconnected" overlay or a "Connection lost —
 * reconnecting…" strip must never sit beside a green "Connected".
 */

/** Tabs whose "Connected" toast may still be on screen. */
const shownFor = new Set<string>();

/** The stable toast id of `tabId`'s "Connected" confirmation. */
export function connectedToastId(tabId: string): string {
  return `connected:${tabId}`;
}

/**
 * Local shells get no "Connected" toast: the shell starts on this machine and
 * cannot fail the way a network connect can, so the tab dot is enough (#5618).
 */
export function wantsConnectedToast(connectionType: ConnectionType | undefined): boolean {
  return connectionType !== "local";
}

/** Confirm that `tabId` connected, replacing any earlier toast for that tab. */
export function showConnectedToast(
  tabId: string,
  title: string,
  connectionType: ConnectionType | undefined
): void {
  if (!wantsConnectedToast(connectionType)) return;
  shownFor.add(tabId);
  toast.success("Connected", {
    id: connectedToastId(tabId),
    description: title,
    testId: `toast-connected-${tabId}`,
  });
}

/** Dismiss `tabId`'s "Connected" toast if one may still be showing. */
export function dismissConnectedToast(tabId: string): void {
  if (!shownFor.delete(tabId)) return;
  toast.dismiss(connectedToastId(tabId));
}

/**
 * Whether `tabId` has left the connected state: disconnected, failed, taken
 * over by another window, or reconnecting. A first connect still in flight
 * does not count — the toast is only raised once that connect resolved.
 */
export function hasLeftConnected(maps: TabStatusMaps, tabId: string): boolean {
  if (maps.terminalReconnectingTabs[tabId]) return true;
  const status = deriveTabStatus(maps, tabId);
  return status === "disconnected" || status === "failed" || status === "evicted";
}

/** Dismiss the "Connected" toast of every tab in `tabIds` that left connected. */
export function dismissStaleConnectedToasts(tabIds: Iterable<string>, maps: TabStatusMaps): void {
  for (const tabId of tabIds) {
    if (shownFor.has(tabId) && hasLeftConnected(maps, tabId)) dismissConnectedToast(tabId);
  }
}

/**
 * Keep the "Connected" toasts of `tabIds` honest: re-checked whenever the
 * lifecycle maps change, so a drop or reconnect clears its tab's toast.
 */
export function useDismissStaleConnectedToasts(tabIds: readonly string[], maps: TabStatusMaps) {
  const {
    terminalConnecting,
    terminalReconnectingTabs,
    terminalSpawnErrors,
    terminalDisconnectErrors,
    terminalExitedTabs,
    terminalSessionLost,
    terminalEvicted,
  } = maps;
  useEffect(() => {
    dismissStaleConnectedToasts(tabIds, {
      terminalConnecting,
      terminalReconnectingTabs,
      terminalSpawnErrors,
      terminalDisconnectErrors,
      terminalExitedTabs,
      terminalSessionLost,
      terminalEvicted,
    });
  }, [
    tabIds,
    terminalConnecting,
    terminalReconnectingTabs,
    terminalSpawnErrors,
    terminalDisconnectErrors,
    terminalExitedTabs,
    terminalSessionLost,
    terminalEvicted,
  ]);
}
