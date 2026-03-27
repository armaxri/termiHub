import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves, findAdjacentLeaf, FocusDirection } from "@/utils/panelTree";
import { processKeyEvent, onChordStateChange, cancelChord } from "@/services/keybindings";

/**
 * Global keyboard shortcuts for the application.
 * Uses the KeybindingService's chord-aware processKeyEvent() for matching.
 */
export function useKeyboardShortcuts() {
  const addTab = useAppStore((s) => s.addTab);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const activePanelId = useAppStore((s) => s.activePanelId);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  useEffect(() => {
    // Wire chord state changes to the store for StatusBar display
    onChordStateChange((pending) => {
      useAppStore.getState().setChordPending(pending);
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      const action = processKeyEvent(e);
      if (!action) return;

      // chord-pending means the first key of a chord was pressed — just block it
      if (action === "chord-pending") {
        e.preventDefault();
        return;
      }

      const allLeaves = getAllLeaves(rootPanel);

      switch (action) {
        case "toggle-sidebar":
          e.preventDefault();
          toggleSidebar();
          break;

        case "new-terminal":
          e.preventDefault();
          addTab("Terminal", "local");
          break;

        case "close-tab": {
          e.preventDefault();
          const panel = allLeaves.find((p) => p.id === activePanelId);
          if (panel?.activeTabId) {
            closeTab(panel.activeTabId, panel.id);
          }
          break;
        }

        case "next-tab": {
          e.preventDefault();
          const panel = allLeaves.find((p) => p.id === activePanelId);
          if (!panel || panel.tabs.length < 2) break;
          const currentIdx = panel.tabs.findIndex((t) => t.id === panel.activeTabId);
          const nextIdx = (currentIdx + 1) % panel.tabs.length;
          setActiveTab(panel.tabs[nextIdx].id, panel.id);
          break;
        }

        case "prev-tab": {
          e.preventDefault();
          const panel = allLeaves.find((p) => p.id === activePanelId);
          if (!panel || panel.tabs.length < 2) break;
          const currentIdx = panel.tabs.findIndex((t) => t.id === panel.activeTabId);
          const prevIdx = (currentIdx - 1 + panel.tabs.length) % panel.tabs.length;
          setActiveTab(panel.tabs[prevIdx].id, panel.id);
          break;
        }

        case "show-shortcuts":
          e.preventDefault();
          useAppStore.getState().setShortcutsOverlayOpen(true);
          break;

        case "open-settings":
          e.preventDefault();
          useAppStore.getState().openSettingsTab();
          break;

        case "clear-terminal": {
          e.preventDefault();
          const panel = allLeaves.find((p) => p.id === activePanelId);
          const tabId = panel?.activeTabId;
          if (tabId) {
            window.dispatchEvent(new CustomEvent("termihub:clear-terminal", { detail: { tabId } }));
          }
          break;
        }

        case "split-right":
          e.preventDefault();
          useAppStore.getState().splitPanel("horizontal");
          break;

        case "split-down":
          e.preventDefault();
          useAppStore.getState().splitPanel("vertical");
          break;

        case "zoom-in":
          e.preventDefault();
          useAppStore.getState().zoomIn();
          break;

        case "zoom-out":
          e.preventDefault();
          useAppStore.getState().zoomOut();
          break;

        case "zoom-reset":
          e.preventDefault();
          useAppStore.getState().zoomReset();
          break;

        case "focus-up":
        case "focus-down":
        case "focus-left":
        case "focus-right": {
          e.preventDefault();
          const dir = action.replace("focus-", "") as FocusDirection;
          const currentPanel = allLeaves.find((p) => p.id === activePanelId);
          if (!currentPanel) break;
          const target = findAdjacentLeaf(rootPanel, currentPanel.id, dir);
          if (target) {
            useAppStore.getState().setActivePanel(target.id);
            if (target.activeTabId) {
              window.dispatchEvent(
                new CustomEvent("termihub:focus-terminal", {
                  detail: { tabId: target.activeTabId },
                })
              );
            }
          }
          break;
        }

        case "find-in-terminal": {
          e.preventDefault();
          const panel = allLeaves.find((p) => p.id === activePanelId);
          const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);
          if (activeTab?.contentType === "terminal") {
            useAppStore.getState().toggleTerminalSearch(activeTab.id);
          }
          break;
        }

        case "new-tab-group":
          e.preventDefault();
          useAppStore.getState().addTabGroup();
          break;

        case "close-tab-group": {
          e.preventDefault();
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          if (tabGroups.length > 1) {
            useAppStore.getState().closeTabGroup(activeTabGroupId);
          }
          break;
        }

        case "next-tab-group": {
          e.preventDefault();
          const { tabGroups: groups, activeTabGroupId: activeId } = useAppStore.getState();
          if (groups.length <= 1) break;
          const idx = groups.findIndex((g) => g.id === activeId);
          const nextIdx = (idx + 1) % groups.length;
          useAppStore.getState().setActiveTabGroup(groups[nextIdx].id);
          break;
        }

        case "prev-tab-group": {
          e.preventDefault();
          const { tabGroups: groups, activeTabGroupId: activeId } = useAppStore.getState();
          if (groups.length <= 1) break;
          const idx = groups.findIndex((g) => g.id === activeId);
          const prevIdx = (idx - 1 + groups.length) % groups.length;
          useAppStore.getState().setActiveTabGroup(groups[prevIdx].id);
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      cancelChord();
    };
  }, [addTab, rootPanel, activePanelId, closeTab, setActiveTab, toggleSidebar]);
}
