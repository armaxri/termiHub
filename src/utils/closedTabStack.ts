/**
 * The tabs that can be reopened (#6161): each closed terminal tab — by its X,
 * a shortcut, Close others, a panel or a tab group close — newest last, up to
 * {@link CLOSED_TAB_LIMIT}. "Reopen closed tab" takes the newest; the undo
 * toast's Reopen takes its own tabs out, so neither reopens a tab twice.
 */
import type { ReopenTabPayload, TerminalTab } from "@/types/terminal";

/** How many closed tabs are remembered. */
export const CLOSED_TAB_LIMIT = 20;

let stack: ReopenTabPayload[] = [];

/** Remember a closed tab; the oldest falls off past the limit. */
export function recordClosedTab(payload: ReopenTabPayload | null): void {
  if (!payload) return;
  stack = [...stack, payload].slice(-CLOSED_TAB_LIMIT);
}

/** Whether a closed tab can be reopened. */
export function hasClosedTab(): boolean {
  return stack.length > 0;
}

/** Take the newest closed tab, or `null`. */
export function takeLastClosedTab(): ReopenTabPayload | null {
  const last = stack[stack.length - 1] ?? null;
  stack = stack.slice(0, -1);
  return last;
}

/** Forget the closed tabs with these ids (reopened another way). */
export function forgetClosedTabs(tabIds: readonly (string | undefined)[]): void {
  const ids = new Set(tabIds.filter((id): id is string => !!id));
  if (ids.size === 0) return;
  stack = stack.filter((p) => !p.closedTabId || !ids.has(p.closedTabId));
}

/** Forget every closed tab (tests). */
export function resetClosedTabs(): void {
  stack = [];
}

/**
 * Build the {@link ReopenTabPayload} for a tab, or `null` when the tab cannot be
 * meaningfully reopened (non-terminal tabs, or tabs attached to a persistent
 * session — closing those only detaches, so there is nothing to undo).
 */
export function reopenPayloadForTab(
  tab: Pick<
    TerminalTab,
    "title" | "connectionType" | "config" | "contentType" | "persistentConnectionId"
  > &
    Partial<Pick<TerminalTab, "id" | "pendingImportedConnection">>
): ReopenTabPayload | null {
  if (tab.contentType !== "terminal") return null;
  if (tab.persistentConnectionId) return null;
  // A tab that waited for its connection to be confirmed never ran it here:
  // reopening must not connect it unasked (#6065).
  if (tab.pendingImportedConnection) return null;
  return {
    title: tab.title,
    connectionType: tab.connectionType,
    config: tab.config,
    ...(tab.id ? { closedTabId: tab.id } : {}),
  };
}
