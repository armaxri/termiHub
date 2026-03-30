import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(),
  onChordStateChange: vi.fn(),
  cancelChord: vi.fn(),
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

import { processKeyEvent, cancelChord } from "@/services/keybindings";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

const mockProcessKeyEvent = vi.mocked(processKeyEvent);
const mockCancelChord = vi.mocked(cancelChord);

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
    useAppStore.setState(useAppStore.getInitialState());
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

  describe("new-terminal", () => {
    it("adds a new local terminal tab", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("new-terminal");

      const before = getAllLeaves(useAppStore.getState().rootPanel)[0].tabs.length;
      fireKey("t");
      const after = getAllLeaves(useAppStore.getState().rootPanel)[0].tabs.length;

      expect(after).toBe(before + 1);
    });
  });

  describe("close-tab", () => {
    it("closes the active tab in the active panel", () => {
      useAppStore.getState().addTab("Tab A", "local");
      const panelId = getAllLeaves(useAppStore.getState().rootPanel)[0].id;
      useAppStore.getState().setActivePanel(panelId);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("close-tab");

      fireKey("w");

      expect(getAllLeaves(useAppStore.getState().rootPanel)[0].tabs).toHaveLength(0);
    });
  });

  describe("next-tab / prev-tab", () => {
    it("cycles to the next tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabA.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab");

      fireKey("ArrowRight");

      const activeId = getAllLeaves(useAppStore.getState().rootPanel)[0].activeTabId;
      expect(activeId).toBe(tabB.id);
    });

    it("cycles to the previous tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabB.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("prev-tab");

      fireKey("ArrowLeft");

      const activeId = getAllLeaves(useAppStore.getState().rootPanel)[0].activeTabId;
      expect(activeId).toBe(tabA.id);
    });

    it("wraps around from last tab to first on next-tab", () => {
      useAppStore.getState().addTab("Tab A", "local");
      useAppStore.getState().addTab("Tab B", "local");
      const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
      const tabA = panel.tabs[0];
      const tabB = panel.tabs[1];
      useAppStore.getState().setActiveTab(tabB.id, panel.id);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab");

      fireKey("ArrowRight");

      const activeId = getAllLeaves(useAppStore.getState().rootPanel)[0].activeTabId;
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

      const leaves = getAllLeaves(useAppStore.getState().rootPanel);
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

      const before = getAllLeaves(useAppStore.getState().rootPanel).length;
      fireKey("\\");
      const after = getAllLeaves(useAppStore.getState().rootPanel).length;

      expect(after).toBe(before + 1);
    });
  });

  describe("clear-terminal", () => {
    it("dispatches termihub:clear-terminal custom event for the active tab", () => {
      useAppStore.getState().addTab("Shell", "local");
      const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
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

  describe("tab groups", () => {
    it("adds a new tab group on new-tab-group", () => {
      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("new-tab-group");

      const before = useAppStore.getState().tabGroups.length;
      fireKey("n");
      const after = useAppStore.getState().tabGroups.length;

      expect(after).toBe(before + 1);
    });

    it("cycles to next tab group on next-tab-group", () => {
      useAppStore.getState().addTabGroup();
      const groups = useAppStore.getState().tabGroups;
      const firstId = groups[0].id;
      useAppStore.getState().setActiveTabGroup(firstId);

      act(() => {
        root.render(createElement(KeyboardHarness));
      });
      mockProcessKeyEvent.mockReturnValue("next-tab-group");

      fireKey("Tab");

      expect(useAppStore.getState().activeTabGroupId).not.toBe(firstId);
    });
  });
});
