/**
 * The single close-tab decision shared by every single-tab close path (#5189):
 * the tab X, middle-click, the tab context menu's Close, and the close-tab
 * shortcut / palette entry.
 *
 * Every path asks the same questions in the same order, so the same tab gets
 * the same dialog (or none) and the same Reopen toast whatever triggered it:
 *
 * 1. Unsaved edits — {@link routeDirtyTabClose} (#4410). Always prompts.
 * 2. Persistent (background) session — closing only detaches, so the
 *    reassuring "keeps running in the background" notice, never "work will be
 *    lost". Gated by `confirmCloseAttachedTab`.
 * 3. Live session — "will end its live session", with "Don't ask again" and a
 *    Reopen toast. Gated by `confirmCloseLiveSession` for pointer closes and by
 *    `confirmCloseTabOnShortcut` for shortcut closes, and the opt-out writes the
 *    setting that gated it — so nobody loses a confirm they had switched on.
 * 4. Anything else (exited / failed terminal, settings, clean editor, …) closes
 *    immediately, with a Reopen toast when the tab has a reconnectable config.
 */
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { currentSessionView, effectiveExitedMap } from "@/store/sessionBridge";
import { tabHasLiveSession } from "@/utils/tabLiveSession";
import { routeDirtyTabClose } from "@/utils/tabCloseGuard";
import { reopenPayloadForTab, showReopenToast } from "@/utils/reopenTab";
import type { TerminalTab } from "@/types/terminal";

/** What started a close: a pointer gesture (X, middle-click, menu) or the shortcut. */
export type TabCloseTrigger = "pointer" | "shortcut";

/** The settings a live-session close confirm can be opted out of from its dialog. */
export type LiveCloseOptOutSetting = "confirmCloseLiveSession" | "confirmCloseTabOnShortcut";

/** The setting that gates (and is cleared by "Don't ask again" for) a live-session close. */
export function liveCloseSettingFor(trigger: TabCloseTrigger): LiveCloseOptOutSetting {
  return trigger === "shortcut" ? "confirmCloseTabOnShortcut" : "confirmCloseLiveSession";
}

type ClosableTab = Pick<
  TerminalTab,
  "id" | "title" | "connectionType" | "config" | "contentType" | "persistentConnectionId"
>;

/**
 * Run the close decision for `tab` (in `panelId`), including the unsaved-edits
 * gate. Returns `"generic-prompt"` when the tab is dirty without a prompt of its
 * own: the caller then shows its unsaved-changes confirm and, on confirm, calls
 * {@link continueTabClose}. Otherwise the request is fully handled (`"handled"`).
 */
export function requestTabClose(
  tab: ClosableTab,
  panelId: string,
  trigger: TabCloseTrigger
): "handled" | "generic-prompt" {
  const route = routeDirtyTabClose(tab, panelId);
  if (route === "self-prompt") return "handled";
  if (route === "generic-prompt") return "generic-prompt";
  continueTabClose(tab, panelId, trigger);
  return "handled";
}

/**
 * Continue a close once any unsaved-changes gate has cleared: show the
 * persistent-session notice or the live-session confirm when one applies,
 * otherwise close now and offer Reopen.
 */
export function continueTabClose(
  tab: ClosableTab,
  panelId: string,
  trigger: TabCloseTrigger
): void {
  const state = useAppStore.getState();
  const settings = currentSettingsView();
  // The shortcut's own switch still turns every shortcut prompt off.
  const triggerAllows = trigger === "pointer" || settings.confirmCloseTabOnShortcut !== false;

  if (tab.persistentConnectionId) {
    if (triggerAllows && settings.confirmCloseAttachedTab !== false) {
      state.setPendingAttachedTabCloseConfirm({ tabId: tab.id, panelId, label: tab.title });
      return;
    }
    state.closeTab(tab.id, panelId);
    return;
  }

  const isLive = tabHasLiveSession(tab, {
    // #2625: region-only exited map, read synchronously in this imperative path.
    terminalExitedTabs: effectiveExitedMap(currentSessionView()),
    terminalSpawnErrors: state.terminalSpawnErrors,
  });
  const optOutSetting = liveCloseSettingFor(trigger);
  if (isLive && settings[optOutSetting] !== false) {
    state.setPendingSessionCloseConfirm({
      kind: "tab",
      tabId: tab.id,
      panelId,
      label: tab.title,
      reopen: reopenPayloadForTab(tab),
      optOutSetting,
    });
    return;
  }

  state.closeTab(tab.id, panelId);
  showReopenToast(reopenPayloadForTab(tab));
}
