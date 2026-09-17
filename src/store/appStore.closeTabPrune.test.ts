import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";

/**
 * Regression for FES-003: `closeTab` prunes ~15 parallel per-tab `Record<tabId,…>`
 * maps, but `terminalForceFreshReconnect` was absent from the prune list, so its
 * entry was stranded when the tab closed. This asserts the entry is removed.
 */
describe("closeTab prunes per-tab maps (FES-003)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  function addTabAndGetIds(): { tabId: string; panelId: string } {
    const panelId = layoutState().activePanelId!;
    useAppStore.getState().addTab("Test", "local");
    const rootPanel = layoutState().rootPanel;
    const leafTabs = rootPanel.type === "leaf" ? rootPanel.tabs : [];
    const tab = leafTabs[leafTabs.length - 1];
    expect(tab).toBeDefined();
    return { tabId: tab.id, panelId };
  }

  it("removes the closed tab's terminalForceFreshReconnect entry", () => {
    const { tabId, panelId } = addTabAndGetIds();

    // Seed the one-shot force-fresh flag for this tab (as startFreshShellForTab does).
    useAppStore.setState((state) => ({
      terminalForceFreshReconnect: { ...state.terminalForceFreshReconnect, [tabId]: true },
    }));
    expect(useAppStore.getState().terminalForceFreshReconnect[tabId]).toBe(true);

    useAppStore.getState().closeTab(tabId, panelId);

    expect(useAppStore.getState().terminalForceFreshReconnect[tabId]).toBeUndefined();
  });

  it("leaves another tab's terminalForceFreshReconnect entry intact", () => {
    const first = addTabAndGetIds();
    const second = addTabAndGetIds();

    useAppStore.setState((state) => ({
      terminalForceFreshReconnect: {
        ...state.terminalForceFreshReconnect,
        [first.tabId]: true,
        [second.tabId]: true,
      },
    }));

    useAppStore.getState().closeTab(first.tabId, first.panelId);

    expect(useAppStore.getState().terminalForceFreshReconnect[first.tabId]).toBeUndefined();
    expect(useAppStore.getState().terminalForceFreshReconnect[second.tabId]).toBe(true);
  });
});
