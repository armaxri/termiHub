import { useAppStore } from "@/store/appStore";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";

/**
 * The tab id of a keyboard-interactive prompt's owning connect (#3437). A
 * terminal tab connects with `connect_id = ${tabId}:${retryCount}`, so the tab
 * id is everything before the last `:`. `null` for an unowned prompt.
 */
export function promptOwnerTabId(owner: string | null): string | null {
  if (!owner) return null;
  const sep = owner.lastIndexOf(":");
  const tabId = sep > 0 ? owner.slice(0, sep) : owner;
  return tabId || null;
}

/** Whether a tab with this id is open in this window's layout. */
export function isTabOpen(tabId: string): boolean {
  return getAllTabsAcrossGroupTrees().some((t) => t.id === tabId);
}

/** Run `callback` on every app-store change; returns the unsubscribe. */
export function subscribeToTabs(callback: () => void): () => void {
  return useAppStore.subscribe(() => callback());
}
