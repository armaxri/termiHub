/**
 * The unsaved-changes guard for closing a single tab (#4410).
 *
 * Every single-tab close path — the tab X, middle-click, and the close-tab
 * shortcut / palette entry — routes a dirty tab through
 * {@link routeDirtyTabClose} first, so none of them can discard unsaved edits
 * without a prompt. Bulk closes (group, panel, window) have their own guards in
 * `tabGroupCloseGuard.ts` and `windowClose.ts`.
 */
import { useAppStore } from "@/store/appStore";
import type { TabContentType, TerminalTab } from "@/types/terminal";

/**
 * Tab content types whose editor renders its own `UnsavedChangesDialog` off
 * `pendingCloseRequest` (with Save / Discard / Cancel). This is the single list
 * every close path consults.
 */
export const SELF_PROMPTING_CONTENT_TYPES: ReadonlySet<TabContentType> = new Set<TabContentType>([
  "editor",
  "connection-editor",
  "settings",
  "tunnel-editor",
  "workspace-editor",
]);

/** Whether tabs of `contentType` show their own unsaved-changes prompt. */
export function rendersOwnUnsavedPrompt(contentType: TabContentType | undefined): boolean {
  return contentType !== undefined && SELF_PROMPTING_CONTENT_TYPES.has(contentType);
}

/**
 * How a close request for one tab was routed by {@link routeDirtyTabClose}:
 *
 * - `"clean"` — the tab has no unsaved edits; the caller continues its normal
 *   close flow.
 * - `"self-prompt"` — the tab's own editor now shows its unsaved-changes dialog
 *   (via `pendingCloseRequest`); the caller must not close.
 * - `"generic-prompt"` — the tab is dirty but has no prompt of its own; the
 *   caller must show its generic unsaved-changes confirm and not close yet.
 */
export type DirtyTabCloseRoute = "clean" | "self-prompt" | "generic-prompt";

/**
 * Route a close request for `tab` (in `panelId`) through the unsaved-changes
 * guard. Reads `editorDirtyTabs` fresh from the store, so a dirty flag set
 * since the caller's last render is honoured. A tab whose content type is
 * unknown falls back to the generic prompt when dirty.
 */
export function routeDirtyTabClose(
  tab: Pick<TerminalTab, "id"> & { contentType?: TabContentType },
  panelId: string
): DirtyTabCloseRoute {
  const state = useAppStore.getState();
  if (!state.editorDirtyTabs[tab.id]) return "clean";
  if (rendersOwnUnsavedPrompt(tab.contentType)) {
    state.setPendingCloseRequest({ tabId: tab.id, panelId });
    return "self-prompt";
  }
  return "generic-prompt";
}
