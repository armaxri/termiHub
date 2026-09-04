import { useEffect } from "react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getActiveTabGroupId, getLayoutTabGroups } from "@/store/layoutSelectors";
import { currentSettingsView } from "@/store/settingsBridge";
import {
  processKeyEvent,
  onChordStateChange,
  cancelChord,
  isShellReservedKey,
  isEventFromTerminal,
  getActionScope,
} from "@/services/keybindings";
import { CONTEXT_COMMANDS } from "@/services/contextCommands";
import { matchHotkeyWorkflow } from "@/services/workflowTriggers";
import {
  activeContextFromTab,
  isEventFromTextInput,
  isScopeCompatible,
} from "@/utils/activeContext";

/**
 * Global keyboard shortcuts for the application.
 * Uses the KeybindingService's chord-aware processKeyEvent() for matching.
 *
 * Context-bound actions (focus-panel, tab close/next/prev, terminal find/clear)
 * are executed via the shared {@link CONTEXT_COMMANDS} registry so the keyboard
 * handler and the command palette run identical logic against the focused
 * panel/terminal.
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
      // Pass-through: when the terminal pane is focused, let standard shell /
      // tmux / vim / SSH-to-remote keys reach the PTY instead of firing any
      // matching app shortcut. Users can disable this in Settings.
      const passthroughEnabled = currentSettingsView().terminalKeyPassthrough !== false;
      if (passthroughEnabled && isEventFromTerminal(e) && isShellReservedKey(e)) {
        return;
      }

      const action = processKeyEvent(e);
      if (!action) {
        // No app shortcut matched — try workflow `hotkey` triggers (#1855). A
        // workflow bound to this key runs against the focused terminal via the
        // store's single-run-at-a-time `runWorkflow`. Checked after app
        // shortcuts so a user's app binding always wins over a workflow hotkey.
        const wfId = matchHotkeyWorkflow(e, useAppStore.getState().workflows);
        if (wfId) {
          e.preventDefault();
          void useAppStore.getState().runWorkflow(wfId);
        }
        return;
      }

      // chord-pending means the first key of a chord was pressed — just block it
      if (action === "chord-pending") {
        e.preventDefault();
        return;
      }

      // Context-aware routing: when an editor or input surface owns this combo,
      // step aside (no preventDefault) so the focused widget handles it. The
      // setting lets users restore the old global-first behavior. Global-scoped
      // actions short-circuit before any context/DOM lookup since they always fire.
      const scope = getActionScope(action);
      const delegationEnabled = currentSettingsView().editorShortcutDelegation !== false;
      if (delegationEnabled && scope !== "global") {
        const ctx = activeContextFromTab(getActiveTab(useAppStore.getState()) ?? undefined);
        if (!isScopeCompatible(scope, ctx, isEventFromTextInput(e))) {
          return;
        }
      }

      // Context-bound actions (focus-panel, tab close/next/prev, terminal
      // find/clear) run through the shared registry so palette and keyboard
      // behaviour stay identical. Availability is resolved inside run().
      if (action in CONTEXT_COMMANDS) {
        e.preventDefault();
        CONTEXT_COMMANDS[action].run();
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

        case "new-window":
          e.preventDefault();
          void useAppStore.getState().openNewWindow();
          break;

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

        case "new-tab-group":
          e.preventDefault();
          useAppStore.getState().addTabGroup();
          break;

        case "toggle-macro-recording":
          e.preventDefault();
          useAppStore.getState().toggleMacroRecording();
          break;

        case "toggle-broadcast":
          // Consume the keystroke so it never reaches the terminal (and is thus
          // never itself broadcast), then toggle broadcast with the last scope.
          e.preventDefault();
          useAppStore.getState().toggleBroadcast();
          break;

        case "close-tab-group": {
          e.preventDefault();
          const tabGroups = getLayoutTabGroups();
          const activeTabGroupId = getActiveTabGroupId();
          if (tabGroups.length <= 1) break;
          const confirmEnabled = currentSettingsView().confirmCloseTabOnShortcut ?? true;
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
          const groups = getLayoutTabGroups();
          const activeId = getActiveTabGroupId();
          if (groups.length <= 1) break;
          const idx = groups.findIndex((g) => g.id === activeId);
          const nextIdx = (idx + 1) % groups.length;
          useAppStore.getState().setActiveTabGroup(groups[nextIdx].id);
          break;
        }

        case "prev-tab-group": {
          e.preventDefault();
          const groups = getLayoutTabGroups();
          const activeId = getActiveTabGroupId();
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
