import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { getAllLeaves } from "@/utils/panelTree";

/** Bring a terminal tab to the front, in whichever group and panel it is, and focus it. */
export function showTerminal(tabId: string): void {
  for (const group of getLayoutTabGroups()) {
    const leaf = getAllLeaves(group.rootPanel).find((l) => l.tabs.some((t) => t.id === tabId));
    if (!leaf) continue;
    const { setActiveTabGroup, setActiveTab } = useAppStore.getState();
    setActiveTabGroup(group.id);
    setActiveTab(tabId, leaf.id);
    break;
  }
  // After a closing dialog gave the focus back to what opened it.
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent("termihub:focus-terminal", { detail: { tabId } }));
  });
}
