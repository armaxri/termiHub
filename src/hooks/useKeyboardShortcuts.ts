import { useEffect } from "react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getAllLeaves, findAdjacentLeaf, FocusDirection } from "@/utils/panelTree";
import {
  processKeyEvent,
  onChordStateChange,
  cancelChord,
  isShellReservedKey,
  isEventFromTerminal,
  getActionScope,
} from "@/services/keybindings";
import {
  activeContextFromTab,
  isEventFromTextInput,
  isScopeCompatible,
} from "@/utils/activeContext";

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
      // Pass-through: when the terminal pane is focused, let standard shell /
      // tmux / vim / SSH-to-remote keys reach the PTY instead of firing any
      // matching app shortcut. Users can disable this in Settings.
      const passthroughEnabled = useAppStore.getState().settings.terminalKeyPassthrough !== false;
      if (passthroughEnabled && isEventFromTerminal(e) && isShellReservedKey(e)) {
        return;
      }

      const action = processKeyEvent(e);
      if (!action) return;

      // chord-pending means the first key of a chord was pressed — just block it
      if (action === "chord-pending") {
        e.preventDefault();
        return;
      }

      const allLeaves = getAllLeaves(rootPanel);

      // Context-aware routing: when an editor or input surface owns this combo,
      // step aside (no preventDefault) so the focused widget handles it. The
      // setting lets users restore the old global-first behavior. Global-scoped
      // actions short-circuit before any context/DOM lookup since they always fire.
      const scope = getActionScope(action);
      const delegationEnabled = useAppStore.getState().settings.editorShortcutDelegation !== false;
      if (delegationEnabled && scope !== "global") {
        const ctx = activeContextFromTab(getActiveTab(useAppStore.getState()) ?? undefined);
        if (!isScopeCompatible(scope, ctx, isEventFromTextInput(e))) {
          return;
        }
      }

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
          if (!panel?.activeTabId) break;
          const tabId = panel.activeTabId;
          const confirmEnabled = useAppStore.getState().settings.confirmCloseTabOnShortcut ?? true;
          if (confirmEnabled) {
            const activeTab = panel.tabs.find((t) => t.id === tabId);
            useAppStore.getState().setPendingShortcutCloseConfirm({
              kind: "tab",
              tabId,
              panelId: panel.id,
              label: activeTab?.title ?? "this tab",
            });
          } else {
            closeTab(tabId, panel.id);
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

        case "command-palette":
          e.preventDefault();
          useAppStore.getState().setCommandPaletteOpen(true);
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
          const { tabGroups, activeTabGroupId, settings } = useAppStore.getState();
          if (tabGroups.length <= 1) break;
          const confirmEnabled = settings.confirmCloseTabOnShortcut ?? true;
          if (confirmEnabled) {
            const activeGroup = tabGroups.find((g) => g.id === activeTabGroupId);
            useAppStore.getState().setPendingShortcutCloseConfirm({
              kind: "tab-group",
              tabGroupId: activeTabGroupId,
              label: activeGroup?.name ?? "this tab group",
            });
          } else {
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
