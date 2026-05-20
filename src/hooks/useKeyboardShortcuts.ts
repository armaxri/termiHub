import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { processKeyEvent, onChordStateChange, cancelChord } from "@/services/keybindings";

/**
 * Global keyboard shortcuts for the application.
 * Uses the KeybindingService's chord-aware processKeyEvent() for matching.
 */
export function useKeyboardShortcuts() {
  // Capture-phase interception for zoom-panel: must fire before Monaco (and other
  // editors) so they don't process the key themselves (e.g. Monaco's "Insert Line
  // Above" on Cmd/Ctrl+Shift+Enter).  We match the key directly here to avoid
  // calling processKeyEvent() in two phases for the same event.
  useEffect(() => {
    const handleZoomCapture = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || (!e.metaKey && !e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      cancelChord();
      useAppStore.getState().toggleZoomActiveTab();
    };
    window.addEventListener("keydown", handleZoomCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleZoomCapture, { capture: true });
  }, []);

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

      switch (action) {
        case "toggle-sidebar":
          e.preventDefault();
          useAppStore.getState().toggleSidebar();
          break;

        case "new-terminal":
          e.preventDefault();
          useAppStore.getState().addTab("Terminal", "local");
          break;

        case "close-tab": {
          e.preventDefault();
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
          if (activeGroup?.activeTabId) {
            useAppStore.getState().closeTab(activeGroup.activeTabId, activeGroup.activeTabId);
          }
          break;
        }

        case "next-tab": {
          e.preventDefault();
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
          if (!activeGroup || activeGroup.tabs.length < 2) break;
          const currentIdx = activeGroup.tabs.findIndex((t) => t.id === activeGroup.activeTabId);
          const nextIdx = (currentIdx + 1) % activeGroup.tabs.length;
          useAppStore.getState().setActiveTab(activeGroup.tabs[nextIdx].id, activeGroup.id);
          break;
        }

        case "prev-tab": {
          e.preventDefault();
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
          if (!activeGroup || activeGroup.tabs.length < 2) break;
          const currentIdx = activeGroup.tabs.findIndex((t) => t.id === activeGroup.activeTabId);
          const prevIdx = (currentIdx - 1 + activeGroup.tabs.length) % activeGroup.tabs.length;
          useAppStore.getState().setActiveTab(activeGroup.tabs[prevIdx].id, activeGroup.id);
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
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
          const tabId = activeGroup?.activeTabId;
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

        case "zoom-panel":
          e.preventDefault();
          useAppStore.getState().toggleZoomActiveTab();
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
        case "focus-right":
          // directional focus not available in flexlayout; use mouse
          e.preventDefault();
          break;

        case "find-in-terminal": {
          e.preventDefault();
          const { tabGroups, activeTabGroupId } = useAppStore.getState();
          const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
          const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId);
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
  }, []);
}
