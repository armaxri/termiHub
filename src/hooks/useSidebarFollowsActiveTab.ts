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

/** Find a rendered element by its exact `data-testid`, without CSS escaping. */
function findByTestId(prefix: string, testId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)).find(
    (el) => el.getAttribute("data-testid") === testId
  );
}

/**
 * Scroll the sidebar row of `connectionId` into view. A connection inside a
 * collapsed folder has no row (#5706): then the deepest *rendered* folder of
 * `ancestorFolderIds` (ordered root → parent) is scrolled into view instead —
 * that is the collapsed folder carrying the "contains the active connection"
 * marker. Deferred to the next frame so the row exists after the selection
 * re-render.
 */
export function revealConnectionRow(
  connectionId: string,
  ancestorFolderIds: readonly string[] = []
): void {
  const run = () => {
    let row = findByTestId("connection-item-", `connection-item-${connectionId}`);
    for (let i = ancestorFolderIds.length - 1; !row && i >= 0; i--) {
      row = findByTestId("folder-toggle-", `folder-toggle-${ancestorFolderIds[i]}`);
    }
    row?.scrollIntoView?.({ block: "nearest" });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}

/**
 * The folder ids enclosing `connectionId`, ordered root → direct parent (#5706).
 * Empty for a root-level or unknown connection. Guards against a malformed
 * parent cycle.
 */
export function connectionAncestorFolderIds(
  connectionId: string | null,
  connections: readonly { id: string; folderId: string | null }[],
  folders: readonly { id: string; parentId: string | null }[]
): string[] {
  if (!connectionId) return [];
  const connection = connections.find((c) => c.id === connectionId);
  if (!connection) return [];
  const parentById = new Map(folders.map((f) => [f.id, f.parentId]));
  const chain: string[] = [];
  let current: string | null = connection.folderId;
  while (current && parentById.has(current) && !chain.includes(current)) {
    chain.unshift(current);
    current = parentById.get(current) ?? null;
  }
  return chain;
}
