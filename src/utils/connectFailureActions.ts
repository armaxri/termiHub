/**
 * Store actions behind the shared connect-failure buttons (#5377) for tabs
 * that are not handed their panel id (remote-desktop and file-browser tabs).
 */
import { useAppStore } from "@/store/appStore";
import { getLayoutRenderTree } from "@/store/layoutSelectors";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";
import { findLeafByTab } from "@/utils/panelTree";

/** Close `tabId` in whichever panel of the active group holds it. */
export function closeTabById(tabId: string): void {
  const leaf = findLeafByTab(getLayoutRenderTree(), tabId);
  if (leaf) useAppStore.getState().closeTab(tabId, leaf.id);
}

/**
 * Open the saved connection's editor on the field that most likely needs
 * fixing — the port for a refused connect, else the host (#5183).
 */
export function editConnectionForFailure(connectionId: string, kind: ConnectionErrorKind): void {
  useAppStore.getState().openConnectionEditorTab(connectionId, undefined, {
    field: kind === "refused" ? "port" : "host",
    nonce: Date.now(),
  });
}
