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
 *    lost". Gated by `confirmCloseAttachedTab` alone, whatever the trigger.
 * 3. Live session — "will end its live session", with "Don't ask again" and a
 *    Reopen toast. Gated by the one `closeLiveSessionConfirm` choice for the
 *    trigger (#5844); the opt-out stops asking for that trigger only — so
 *    nobody loses the confirm they kept for the other kind of close.
 * 4. Anything else (exited / failed terminal, settings, clean editor, …) closes
 *    immediately, with a Reopen toast when the tab has a reconnectable config.
 */
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { currentSessionView, effectiveExitedMap } from "@/store/sessionBridge";
import { tabHasLiveSession } from "@/utils/tabLiveSession";
import { routeDirtyTabClose } from "@/utils/tabCloseGuard";
import { reopenPayloadForTab, showReopenToast } from "@/utils/reopenTab";
import { settingsAskBeforeClose, type TabCloseTrigger } from "@/utils/closeConfirm";
import type { TerminalTab } from "@/types/terminal";

export type { TabCloseTrigger };

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

  if (tab.persistentConnectionId) {
    if (settings.confirmCloseAttachedTab !== false) {
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
  if (isLive && settingsAskBeforeClose(settings, trigger)) {
    state.setPendingSessionCloseConfirm({
      kind: "tab",
      tabId: tab.id,
      panelId,
      label: tab.title,
      reopen: reopenPayloadForTab(tab),
      trigger,
    });
    return;
  }

  state.closeTab(tab.id, panelId);
  showReopenToast(reopenPayloadForTab(tab));
}
