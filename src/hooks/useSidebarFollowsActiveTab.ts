import { useEffect, useRef } from "react";
import { useAppStore, getActiveTab } from "@/store/appStore";

/**
 * Make the connection sidebar's selection follow tab focus (#5642).
 *
 * Whenever the focused tab changes to one opened from a saved connection the
 * sidebar knows (`isKnownConnection`), that connection becomes the single
 * selected row and `revealConnection` is asked to scroll it into view. Only a
 * *change* of the active tab drives this, so a selection the user makes in the
 * sidebar afterwards is left alone until focus moves to another tab. Tabs
 * without a saved connection (local shells, editors, settings) leave the
 * selection untouched.
 */
export function useSidebarFollowsActiveTab(
  isKnownConnection: (connectionId: string) => boolean,
  selectSingle: (connectionId: string) => void,
  revealConnection: (connectionId: string) => void
): void {
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id ?? null);
  const activeConnectionId = useAppStore((s) => getActiveTab(s)?.connectionId ?? null);
  // The tab last followed, so a sidebar re-render (new connection list, new
  // callbacks) never re-applies a selection the user has since changed.
  const followedTabId = useRef<string | null>(null);

  useEffect(() => {
    if (activeTabId === followedTabId.current) return;
    if (!activeTabId || !activeConnectionId) {
      followedTabId.current = activeTabId;
      return;
    }
    // Not (yet) in the sidebar — e.g. connections still loading. Don't record
    // the tab as followed, so it is picked up once the connection appears.
    if (!isKnownConnection(activeConnectionId)) return;
    followedTabId.current = activeTabId;
    selectSingle(activeConnectionId);
    revealConnection(activeConnectionId);
  }, [activeTabId, activeConnectionId, isKnownConnection, selectSingle, revealConnection]);
}

/**
 * Scroll the sidebar row of `connectionId` into view, if it is rendered (a
 * connection inside a collapsed folder has no row and is left alone). Deferred
 * to the next frame so the row exists after the selection re-render.
 */
export function revealConnectionRow(connectionId: string): void {
  const run = () => {
    const testId = `connection-item-${connectionId}`;
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="connection-item-"]')
    ).find((el) => el.getAttribute("data-testid") === testId);
    row?.scrollIntoView?.({ block: "nearest" });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}
