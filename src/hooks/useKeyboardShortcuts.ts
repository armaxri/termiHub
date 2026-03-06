import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { findMatchingAction } from "@/services/keybindings";

/**
 * Global keyboard shortcuts for the application.
 * Uses the KeybindingService to match events against configured bindings.
 */
export function useKeyboardShortcuts() {
  const addTab = useAppStore((s) => s.addTab);
  const rootPanel = useAppStore((s) => s.rootPanel);
  const activePanelId = useAppStore((s) => s.activePanelId);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = findMatchingAction(e);
      if (!action) return;

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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTab, rootPanel, activePanelId, closeTab, setActiveTab, toggleSidebar]);
}
