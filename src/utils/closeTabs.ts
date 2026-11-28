/**
 * Close others / Close tabs to the right (#6161): several tabs of one panel at
 * once, through the same bulk-close guard as a panel or tab group close
 * (#5189): unsaved editors always ask, live sessions ask as the user chose.
 * Each closed tab joins the Reopen toast and can be reopened later.
 */
import { useAppStore } from "@/store/appStore";
import { assessBulkClose } from "@/utils/tabGroupCloseGuard";
import { reopenPayloadForTab, showReopenToast } from "@/utils/reopenTab";
import type { LeafPanel, TerminalTab } from "@/types/terminal";

/** Which tabs of `panel` a close of the others / the ones right of `tabId` takes. */
export function tabsToClose(
  panel: Pick<LeafPanel, "tabs">,
  tabId: string,
  which: "others" | "right"
): TerminalTab[] {
  const index = panel.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return [];
  return which === "others"
    ? panel.tabs.filter((t) => t.id !== tabId)
    : panel.tabs.slice(index + 1);
}

/** Close `tabs` of `panelId` now, each with its Reopen. */
export function closeTabsNow(panelId: string, tabs: readonly TerminalTab[]): void {
  const { closeTab } = useAppStore.getState();
  for (const tab of tabs) {
    closeTab(tab.id, panelId);
    showReopenToast(reopenPayloadForTab(tab));
  }
}

/** Close `tabs` of `panelId`, first confirming when a session would end or edits be lost. */
export function closeTabsGuarded(panelId: string, tabs: readonly TerminalTab[]): void {
  if (tabs.length === 0) return;
  const { liveCount, dirtyCount, prompt } = assessBulkClose([...tabs], "pointer");
  if (!prompt) {
    closeTabsNow(panelId, tabs);
    return;
  }
  useAppStore.getState().setPendingSessionCloseConfirm({
    kind: "tabs",
    panelId,
    tabIds: tabs.map((t) => t.id),
    liveCount,
    dirtyCount,
    tabCount: tabs.length,
  });
}
