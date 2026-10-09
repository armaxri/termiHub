/**
 * The guards for bulk-closing tabs: a whole tab group (UX2-001, #4306) and a
 * split panel (UX2-003, #4314).
 *
 * Closing a group or panel unmounts every tab in it, so each live terminal
 * session ends and each unsaved editor is discarded. Every user-facing group
 * close path (the chip X, the chip's "Close Group" item, the close-tab-group
 * shortcut) and the panel close button route through here so none of them can
 * skip the confirmation.
 */
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { currentSettingsView } from "@/store/settingsBridge";
import { currentSessionView, effectiveExitedMap } from "@/store/sessionBridge";
import { getAllLeaves } from "@/utils/panelTree";
import { countLiveSessions, dirtyEditorTabs } from "@/utils/tabLiveSession";
import type { TerminalTab } from "@/types/terminal";

/**
 * What closing `tabs` at once would lose, and whether that warrants a prompt.
 *
 * Live sessions honour the "Don't ask again" opt-out
 * (`settings.confirmCloseLiveSession`); unsaved editors always prompt, matching
 * the single-tab dirty guard, which has no opt-out.
 */
function assessBulkClose(tabs: TerminalTab[]): {
  liveCount: number;
  dirtyCount: number;
  prompt: boolean;
} {
  const state = useAppStore.getState();
  const liveCount = countLiveSessions(tabs, {
    // Region-only exited map (#2625), read synchronously in an imperative handler.
    terminalExitedTabs: effectiveExitedMap(currentSessionView()),
    terminalSpawnErrors: state.terminalSpawnErrors,
  });
  const dirtyCount = dirtyEditorTabs(tabs, state.editorDirtyTabs).length;
  const confirmLive = liveCount > 0 && currentSettingsView().confirmCloseLiveSession !== false;
  return { liveCount, dirtyCount, prompt: confirmLive || dirtyCount > 0 };
}

/**
 * Raise the group-close confirmation when closing `groupId` would end live
 * sessions or discard unsaved editors. Returns `true` when the confirmation was
 * raised (the caller must not close), `false` when nothing would be lost.
 *
 * Live sessions honour the "Don't ask again" opt-out
 * (`settings.confirmCloseLiveSession`); unsaved editors always prompt, matching
 * the single-tab dirty guard, which has no opt-out.
 */
export function requestTabGroupCloseConfirm(groupId: string): boolean {
  const group = getLayoutTabGroups().find((g) => g.id === groupId);
  if (!group) return false;
  const tabs = getAllLeaves(group.rootPanel).flatMap((leaf) => leaf.tabs);
  const { liveCount, dirtyCount, prompt } = assessBulkClose(tabs);
  if (!prompt) return false;
  useAppStore.getState().setPendingSessionCloseConfirm({
    kind: "group",
    tabGroupId: groupId,
    label: group.name,
    liveCount,
    dirtyCount,
  });
  return true;
}

/** Close `groupId`, first confirming when it would end live sessions or lose edits. */
export function closeTabGroupGuarded(groupId: string): void {
  if (requestTabGroupCloseConfirm(groupId)) return;
  useAppStore.getState().closeTabGroup(groupId);
}

/**
 * Raise the panel-close confirmation when removing split panel `panelId` would
 * end live sessions or discard unsaved editors (UX2-003). Returns `true` when
 * the confirmation was raised (the caller must not close), `false` when nothing
 * would be lost.
 */
export function requestPanelCloseConfirm(panelId: string): boolean {
  const panel = getLayoutTabGroups()
    .flatMap((g) => getAllLeaves(g.rootPanel))
    .find((leaf) => leaf.id === panelId);
  if (!panel) return false;
  const { liveCount, dirtyCount, prompt } = assessBulkClose(panel.tabs);
  if (!prompt) return false;
  useAppStore.getState().setPendingSessionCloseConfirm({
    kind: "panel",
    panelId,
    liveCount,
    dirtyCount,
    tabCount: panel.tabs.length,
  });
  return true;
}

/** Remove split panel `panelId`, first confirming when it would end sessions or lose edits. */
export function closePanelGuarded(panelId: string): void {
  if (requestPanelCloseConfirm(panelId)) return;
  useAppStore.getState().removePanel(panelId);
}
