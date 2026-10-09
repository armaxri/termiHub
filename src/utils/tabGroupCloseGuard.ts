/**
 * The single guard for closing a whole tab group (UX2-001, #4306).
 *
 * Closing a group unmounts every tab in it, so each live terminal session ends
 * and each unsaved editor is discarded. Every user-facing group close path (the
 * chip X, the chip's "Close Group" item, the close-tab-group shortcut) routes
 * through here so none of them can skip the confirmation.
 */
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { currentSettingsView } from "@/store/settingsBridge";
import { currentSessionView, effectiveExitedMap } from "@/store/sessionBridge";
import { getAllLeaves } from "@/utils/panelTree";
import { countLiveSessions } from "@/utils/tabLiveSession";

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
  const state = useAppStore.getState();
  const tabs = getAllLeaves(group.rootPanel).flatMap((leaf) => leaf.tabs);
  const liveCount = countLiveSessions(tabs, {
    // Region-only exited map (#2625), read synchronously in an imperative handler.
    terminalExitedTabs: effectiveExitedMap(currentSessionView()),
    terminalSpawnErrors: state.terminalSpawnErrors,
  });
  const dirtyCount = tabs.filter((t) => state.editorDirtyTabs[t.id]).length;
  const confirmLive = liveCount > 0 && currentSettingsView().confirmCloseLiveSession !== false;
  if (!confirmLive && dirtyCount === 0) return false;
  state.setPendingSessionCloseConfirm({
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
