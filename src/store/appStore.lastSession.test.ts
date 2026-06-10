import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store
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

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { saveLastSession, loadLastSession, clearLastSession } from "@/services/lastSessionApi";
import type { LastSession } from "@/types/lastSession";
import { getAllLeaves } from "@/utils/panelTree";

const mockSave = vi.mocked(saveLastSession);
const mockLoad = vi.mocked(loadLastSession);
const mockClear = vi.mocked(clearLastSession);

describe("last session persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    // Reset to a clean single empty terminal group.
    useAppStore.setState({
      connections: [],
      remoteAgents: [],
      agentDefinitions: {},
      defaultShell: "bash",
      settings: { ...useAppStore.getState().settings, restoreLastSessionOnStartup: true },
    });
    // Open a fresh local terminal so there is real content to capture.
    useAppStore.getState().addTab("Shell", "local", { type: "local", config: { shell: "bash" } });
  });

  describe("saveLastSession", () => {
    it("captures the current tab groups and persists them", async () => {
      await useAppStore.getState().saveLastSession();

      expect(mockSave).toHaveBeenCalledTimes(1);
      const payload = mockSave.mock.calls[0][0] as LastSession;
      expect(payload.version).toBe("1");
      expect(payload.tabGroups.length).toBeGreaterThan(0);
      expect(payload.activeGroupIndex).toBe(0);
    });

    it("does nothing when restore-on-startup is disabled", async () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, restoreLastSessionOnStartup: false },
      });

      await useAppStore.getState().saveLastSession();

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("persists an empty payload when there are no real tabs", async () => {
      // Replace the live layout with an empty leaf (no tabs).
      const state = useAppStore.getState();
      const group = state.tabGroups[0];
      const emptyRoot = { type: "leaf" as const, id: "leaf-empty", tabs: [], activeTabId: null };
      useAppStore.setState({
        tabGroups: [{ ...group, rootPanel: emptyRoot, activePanelId: emptyRoot.id }],
        rootPanel: emptyRoot,
        activePanelId: emptyRoot.id,
      });

      await useAppStore.getState().saveLastSession();

      const payload = mockSave.mock.calls[0][0] as LastSession;
      expect(payload.tabGroups).toHaveLength(0);
    });
  });

  describe("restoreLastSession", () => {
    it("returns false and changes nothing when no session is stored", async () => {
      mockLoad.mockResolvedValue(null);
      const before = useAppStore.getState().tabGroups;

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(false);
      expect(useAppStore.getState().tabGroups).toBe(before);
    });

    it("rebuilds the live layout from a stored session", async () => {
      mockLoad.mockResolvedValue({
        version: "1",
        activeGroupIndex: 0,
        tabGroups: [
          {
            name: "Restored",
            layout: {
              type: "leaf",
              tabs: [
                { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell A" },
                { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell B" },
              ],
            },
          },
        ],
      });

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(true);
      const state = useAppStore.getState();
      expect(state.tabGroups).toHaveLength(1);
      expect(state.tabGroups[0].name).toBe("Restored");
      const tabs = getAllLeaves(state.rootPanel).flatMap((l) => l.tabs);
      expect(tabs.map((t) => t.title).sort()).toEqual(["Shell A", "Shell B"]);
      // Active group/panel point at the restored group.
      expect(state.activeTabGroupId).toBe(state.tabGroups[0].id);
    });
  });

  describe("clearLastSession", () => {
    it("invokes the clear command", async () => {
      await useAppStore.getState().clearLastSession();
      expect(mockClear).toHaveBeenCalledTimes(1);
    });
  });
});
