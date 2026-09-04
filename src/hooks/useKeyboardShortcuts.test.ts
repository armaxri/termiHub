import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(),
  onChordStateChange: vi.fn(),
  cancelChord: vi.fn(),
  isShellReservedKey: vi.fn(() => false),
  isEventFromTerminal: vi.fn(() => false),
  getActionScope: vi.fn((action: string) => {
    if (action === "find-in-terminal" || action === "clear-terminal") return "terminal";
    if (action === "copy" || action === "paste" || action === "select-all") {
      return "editor-delegated";
    }
    return "global";
  }),
}));

vi.mock("@/services/workflowTriggers", () => ({
  matchHotkeyWorkflow: vi.fn(() => null),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import {
  processKeyEvent,
  cancelChord,
  isShellReservedKey,
  isEventFromTerminal,
} from "@/services/keybindings";
import { matchHotkeyWorkflow } from "@/services/workflowTriggers";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { layoutState } from "@/test/layoutState";

setupSettingsRegion();

const mockProcessKeyEvent = vi.mocked(processKeyEvent);
const mockCancelChord = vi.mocked(cancelChord);
const mockIsShellReservedKey = vi.mocked(isShellReservedKey);
const mockIsEventFromTerminal = vi.mocked(isEventFromTerminal);
const mockMatchHotkeyWorkflow = vi.mocked(matchHotkeyWorkflow);

function KeyboardHarness() {
  useKeyboardShortcuts();
  return null;
}

/** Fire a synthetic keydown and return whether default was prevented. */
function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("useKeyboardShortcuts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset implementations: pass-through mocks default to "do nothing" so
    // each test starts with shortcuts dispatched normally.
    mockIsEventFromTerminal.mockReturnValue(false);
    mockIsShellReservedKey.mockReturnValue(false);
    mockMatchHotkeyWorkflow.mockReturnValue(null);
    useAppStore.setState(useAppStore.getInitialState());
    // split-right/-down assert the split synchronously; pin to the local reducer
    // (the retained resilience fallback) since the mutation cut (#2184) makes the
    // intent path async by default. Intent path covered in appStore.layoutBridge.test.ts.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("lifecycle", () => {
    it("registers keydown listener on mount", () => {
      const addSpy = vi.spyOn(window, "addEventListener");

      act(() => {
        root.render(createElement(KeyboardHarness));
      });

      expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      addSpy.mockRestore();
    });

    it("removes keydown listener and cancels chord on unmount", () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");
      act(() => {
        root.render(createElement(KeyboardHarness));
      });

      act(() => root.unmount());
      root = createRoot(container);

      expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      expect(mockCancelChord).toHaveBeenCalled();
      removeSpy.mockRestore();
    });
  });

  describe("no action when processKeyEvent returns null/undefined", () => {
    it("does not prevent default when no action returned", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue(null);

      const prevented = fireKey("a");

      expect(prevented).toBe(false);
    });
  });

  describe("workflow hotkey triggers", () => {
    it("runs the matched workflow and prevents default when no app action matched", () => {
      const runWorkflow = vi.fn(() => Promise.resolve());
      useAppStore.setState({ runWorkflow });
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue(null);
      mockMatchHotkeyWorkflow.mockReturnValue("wf-1");

      const prevented = fireKey("h", { ctrlKey: true, altKey: true });

      expect(runWorkflow).toHaveBeenCalledWith("wf-1");
      expect(prevented).toBe(true);
    });

    it("does not run a workflow when an app action matched the key", () => {
      const runWorkflow = vi.fn(() => Promise.resolve());
      useAppStore.setState({ runWorkflow });
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      // An app action matched — the workflow-hotkey fallback must not be consulted.
      mockProcessKeyEvent.mockReturnValue("toggle-sidebar");
      mockMatchHotkeyWorkflow.mockReturnValue("wf-1");

      fireKey("b", { metaKey: true });

      expect(runWorkflow).not.toHaveBeenCalled();
      expect(mockMatchHotkeyWorkflow).not.toHaveBeenCalled();
    });
  });

  describe("chord-pending", () => {
    it("prevents default when chord-pending is returned", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("chord-pending");

      const prevented = fireKey("ctrl");

      expect(prevented).toBe(true);
    });
  });

  describe("terminal-focus pass-through", () => {
    it("skips dispatch when terminal focused, key is shell-reserved, and passthrough enabled (default)", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockIsEventFromTerminal.mockReturnValue(true);
      mockIsShellReservedKey.mockReturnValue(true);

      fireKey("w", { ctrlKey: true });

      // processKeyEvent must NOT be called when we pass the key through.
      expect(mockProcessKeyEvent).not.toHaveBeenCalled();
    });

    it("dispatches normally when terminal is not focused", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockIsEventFromTerminal.mockReturnValue(false);
      mockIsShellReservedKey.mockReturnValue(true);
      mockProcessKeyEvent.mockReturnValue(null);

      fireKey("w", { ctrlKey: true });

      expect(mockProcessKeyEvent).toHaveBeenCalled();
    });

    it("dispatches normally when key is not shell-reserved", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockIsEventFromTerminal.mockReturnValue(true);
      mockIsShellReservedKey.mockReturnValue(false);
      mockProcessKeyEvent.mockReturnValue(null);

      fireKey("W", { ctrlKey: true, shiftKey: true });

      expect(mockProcessKeyEvent).toHaveBeenCalled();
    });

    it("dispatches normally when passthrough is explicitly disabled in settings", () => {
      seedSettings({ terminalKeyPassthrough: false });
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockIsEventFromTerminal.mockReturnValue(true);
      mockIsShellReservedKey.mockReturnValue(true);
      mockProcessKeyEvent.mockReturnValue(null);

      fireKey("w", { ctrlKey: true });

      expect(mockProcessKeyEvent).toHaveBeenCalled();
    });
  });

  describe("toggle-sidebar", () => {
    it("toggles the sidebar", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("toggle-sidebar");

      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      fireKey("b");
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    });
  });

  describe("toggle-broadcast", () => {
    it("dispatches the store toggle and consumes the keystroke", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      const spy = vi.spyOn(useAppStore.getState(), "toggleBroadcast");
      mockProcessKeyEvent.mockReturnValue("toggle-broadcast");

      const prevented = fireKey("B", { altKey: true, shiftKey: true });

      expect(spy).toHaveBeenCalledTimes(1);
      // The shortcut keystroke is consumed so it never reaches the terminal and
      // is therefore never itself broadcast (chord-safety, #1958).
      expect(prevented).toBe(true);
      spy.mockRestore();
    });
  });

  describe("new-terminal", () => {
    it("adds a new local terminal tab", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("new-terminal");

      const before = getAllLeaves(layoutState().rootPanel)[0].tabs.length;
      fireKey("t");
      const after = getAllLeaves(layoutState().rootPanel)[0].tabs.length;

      expect(after).toBe(before + 1);
    });
  });

  describe("close-tab", () => {
    it("opens the confirmation dialog instead of closing immediately when the setting is enabled (default)", () => {
      useAppStore.getState().addTab("Tab A", "local");
      const panel = getAllLeaves(layoutState().rootPanel)[0];
      useAppStore.getState().setActivePanel(panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("close-tab");

      fireKey("w");

      // The tab must NOT be closed yet — the dialog should be open instead.
      expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(1);
      const confirm = useAppStore.getState().pendingShortcutCloseConfirm;
      expect(confirm).not.toBeNull();
      expect(confirm?.kind).toBe("tab");
      if (confirm?.kind === "tab") {
        expect(confirm.tabId).toBe(panel.activeTabId);
        expect(confirm.panelId).toBe(panel.id);
        expect(confirm.label).toBe("Tab A");
      }
    });

    it("closes the active tab immediately when the confirm setting is disabled", () => {
      useAppStore.getState().addTab("Tab A", "local");
      const panelId = getAllLeaves(layoutState().rootPanel)[0].id;
      useAppStore.getState().setActivePanel(panelId);
      seedSettings({ confirmCloseTabOnShortcut: false });

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("close-tab");

      fireKey("w");

      expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(0);
      expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    });
  });

  describe("close-tab-group", () => {
    it("opens the confirmation dialog instead of closing immediately when the setting is enabled (default)", () => {
      useAppStore.getState().addTabGroup();
      const groups = layoutState().tabGroups;
      const activeId = layoutState().activeTabGroupId;
      const activeGroup = groups.find((g) => g.id === activeId)!;

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("close-tab-group");

      const groupsBefore = layoutState().tabGroups.length;
      fireKey("F4");

      expect(layoutState().tabGroups).toHaveLength(groupsBefore);
      const confirm = useAppStore.getState().pendingShortcutCloseConfirm;
      expect(confirm).not.toBeNull();
      expect(confirm?.kind).toBe("tab-group");
      if (confirm?.kind === "tab-group") {
        expect(confirm.tabGroupId).toBe(activeGroup.id);
      }
    });

    it("closes the tab group immediately when the confirm setting is disabled", () => {
      useAppStore.getState().addTabGroup();
      const groupsBefore = layoutState().tabGroups.length;
      seedSettings({ confirmCloseTabOnShortcut: false });

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("close-tab-group");

      fireKey("F4");

      expect(layoutState().tabGroups).toHaveLength(groupsBefore - 1);
      expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    });
  });

  describe("next-tab / prev-tab", () => {
    it("cycles to the next tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(layoutState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabA.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab");

      fireKey("ArrowRight");

      const activeId = getAllLeaves(layoutState().rootPanel)[0].activeTabId;
      expect(activeId).toBe(tabB.id);
    });

    it("cycles to the previous tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(layoutState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabB.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("prev-tab");

      fireKey("ArrowLeft");

      const activeId = getAllLeaves(layoutState().rootPanel)[0].activeTabId;
      expect(activeId).toBe(tabA.id);
    });

    it("wraps around from last tab to first on next-tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(layoutState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabB.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab");

      fireKey("ArrowRight");

      const activeId = getAllLeaves(layoutState().rootPanel)[0].activeTabId;
      expect(activeId).toBe(tabA.id);
    });
  });

  describe("show-shortcuts", () => {
    it("opens the shortcuts overlay", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("show-shortcuts");

      expect(useAppStore.getState().shortcutsOverlayOpen).toBe(false);
      fireKey("?");
      expect(useAppStore.getState().shortcutsOverlayOpen).toBe(true);
    });
  });

  describe("open-settings", () => {
    it("opens the settings tab", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("open-settings");

      fireKey(",");

      const leaves = getAllLeaves(layoutState().rootPanel);
      const settingsTab = leaves.flatMap((p) => p.tabs).find((t) => t.contentType === "settings");
      expect(settingsTab).toBeDefined();
    });
  });

  describe("split-right / split-down", () => {
    it("splits the panel horizontally on split-right", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("split-right");

      const before = getAllLeaves(layoutState().rootPanel).length;
      fireKey("\\");
      const after = getAllLeaves(layoutState().rootPanel).length;

      expect(after).toBe(before + 1);
    });
  });

  describe("clear-terminal", () => {
    it("dispatches termihub:clear-terminal custom event for the active tab", () => {
      useAppStore.getState().addTab("Shell", "local");
      const panel = getAllLeaves(layoutState().rootPanel)[0];
      useAppStore.getState().setActivePanel(panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("clear-terminal");

      const events: CustomEvent[] = [];
      window.addEventListener("termihub:clear-terminal", (e) => events.push(e as CustomEvent));

      fireKey("k");

      expect(events).toHaveLength(1);
      expect(events[0].detail.tabId).toBeDefined();
    });
  });

  describe("context-aware routing (scope gate)", () => {
    /** Add a tab of the given content type and make it the active tab/panel. */
    function addActiveTab(contentType: "terminal" | "editor"): void {
      const id = useAppStore.getState().addTab("Tab", "local", undefined, { contentType });
      const panel = getAllLeaves(layoutState().rootPanel).find((p) =>
        p.tabs.some((t) => t.id === id)
      )!;
      useAppStore.getState().setActivePanel(panel.id);
      useAppStore.getState().setActiveTab(id, panel.id);
    }

    it("does NOT swallow find-in-terminal on an editor tab (regression for #787)", () => {
      addActiveTab("editor");
      const toggleSpy = vi.spyOn(useAppStore.getState(), "toggleTerminalSearch");

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("find-in-terminal");

      const prevented = fireKey("f", { metaKey: true });

      // The global handler must step aside so Monaco receives Cmd+F natively.
      expect(prevented).toBe(false);
      expect(toggleSpy).not.toHaveBeenCalled();
    });

    it("opens the terminal search bar for find-in-terminal on a terminal tab", () => {
      addActiveTab("terminal");
      const toggleSpy = vi.spyOn(useAppStore.getState(), "toggleTerminalSearch");

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("find-in-terminal");

      const prevented = fireKey("f", { metaKey: true });

      expect(prevented).toBe(true);
      expect(toggleSpy).toHaveBeenCalledTimes(1);
    });

    it("still fires a global action (split-right) while an editor tab is active", () => {
      addActiveTab("editor");

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("split-right");

      const before = getAllLeaves(layoutState().rootPanel).length;
      const prevented = fireKey("\\", { metaKey: true });
      const after = getAllLeaves(layoutState().rootPanel).length;

      expect(prevented).toBe(true);
      expect(after).toBe(before + 1);
    });

    it("reverts to global-first behavior when editor delegation is disabled", () => {
      seedSettings({ editorShortcutDelegation: false });
      addActiveTab("editor");

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("find-in-terminal");

      // With delegation off the handler claims the key (old behavior); the
      // internal content-type guard still prevents opening a terminal search.
      const prevented = fireKey("f", { metaKey: true });

      expect(prevented).toBe(true);
    });
  });

  describe("tab groups", () => {
    it("adds a new tab group on new-tab-group", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("new-tab-group");

      const before = layoutState().tabGroups.length;
      fireKey("n");
      const after = layoutState().tabGroups.length;

      expect(after).toBe(before + 1);
    });

    it("cycles to next tab group on next-tab-group", () => {
      useAppStore.getState().addTabGroup();
      const groups = layoutState().tabGroups;
      const firstId = groups[0].id;
      useAppStore.getState().setActiveTabGroup(firstId);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab-group");

      fireKey("Tab");

      expect(layoutState().activeTabGroupId).not.toBe(firstId);
    });
  });
});
