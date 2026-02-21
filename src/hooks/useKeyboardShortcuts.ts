import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";

/**
 * Global keyboard shortcuts for the application.
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
      const isMod = e.metaKey || e.ctrlKey;
      const allLeaves = getAllLeaves(rootPanel);

      // Ctrl/Cmd+B — Toggle sidebar
      if (isMod && !e.shiftKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl/Cmd+Shift+` — New terminal
      if (isMod && e.shiftKey && e.key === "`") {
        e.preventDefault();
        addTab("Terminal", "local");
        return;
      }

      // Ctrl/Cmd+W — Close active tab
      if (isMod && e.key === "w") {
        e.preventDefault();
        const panel = allLeaves.find((p) => p.id === activePanelId);
        if (panel?.activeTabId) {
          closeTab(panel.activeTabId, panel.id);
        }
        return;
      }

      // Ctrl+Tab — Next tab
      if (e.ctrlKey && e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const panel = allLeaves.find((p) => p.id === activePanelId);
        if (!panel || panel.tabs.length < 2) return;
        const currentIdx = panel.tabs.findIndex((t) => t.id === panel.activeTabId);
        const nextIdx = (currentIdx + 1) % panel.tabs.length;
        setActiveTab(panel.tabs[nextIdx].id, panel.id);
        return;
      }

      // Ctrl+Shift+Tab — Previous tab
      if (e.ctrlKey && e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        const panel = allLeaves.find((p) => p.id === activePanelId);
        if (!panel || panel.tabs.length < 2) return;
        const currentIdx = panel.tabs.findIndex((t) => t.id === panel.activeTabId);
        const prevIdx = (currentIdx - 1 + panel.tabs.length) % panel.tabs.length;
        setActiveTab(panel.tabs[prevIdx].id, panel.id);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addTab, rootPanel, activePanelId, closeTab, setActiveTab, toggleSidebar]);
}
