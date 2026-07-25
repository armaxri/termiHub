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

// Spy on the shared toast hub so restore-failure feedback (G3, #1146) is observable.
vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "./appStore";
import { saveLastSession, loadLastSession, clearLastSession } from "@/services/lastSessionApi";
import { toast } from "@/components/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LastSession } from "@/types/lastSession";
import { getAllLeaves } from "@/utils/panelTree";

const mockSave = vi.mocked(saveLastSession);
const mockLoad = vi.mocked(loadLastSession);
const mockClear = vi.mocked(clearLastSession);
const mockToast = vi.mocked(toast);
const mockCurrentWindow = vi.mocked(getCurrentWindow);

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

  // Window dimension (#1905): the save path stamps the capturing window and the
  // restore path is non-lossy for a multi-window session.
  describe("window dimension", () => {
    it("omits windowId and windows for the main window (legacy shape)", async () => {
      await useAppStore.getState().saveLastSession();

      const payload = mockSave.mock.calls[0][0] as LastSession;
      expect(payload.windows).toBeUndefined();
      expect(payload.tabGroups.every((g) => g.windowId === undefined)).toBe(true);
    });

    it("stamps the capturing window and records windows[] for a secondary window", async () => {
      mockCurrentWindow.mockReturnValueOnce({
        label: "win-2",
      } as unknown as ReturnType<typeof getCurrentWindow>);

      await useAppStore.getState().saveLastSession();

      const payload = mockSave.mock.calls[0][0] as LastSession;
      expect(payload.tabGroups.every((g) => g.windowId === "win-2")).toBe(true);
      expect(payload.windows).toEqual([{ id: "win-2" }]);
    });

    it("restores a multi-window session non-lossily (all groups, main first)", async () => {
      // A saved session spanning main (group A) + win-1 (group B).
      const leaf = (title: string) => ({
        type: "leaf" as const,
        tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title }],
      });
      mockLoad.mockResolvedValue({
        version: "1",
        activeGroupIndex: 0,
        tabGroups: [
          { name: "A", layout: leaf("a") },
          { name: "B", layout: leaf("b"), windowId: "win-1" },
        ],
        windows: [{ id: "main" }, { id: "win-1" }],
      });

      const ok = await useAppStore.getState().restoreLastSession();

      expect(ok).toBe(true);
      const groups = useAppStore.getState().tabGroups;
      expect(groups.map((g) => g.name)).toEqual(["A", "B"]);
    });
  });

  describe("restoreLastSession", () => {
    it("returns false and changes nothing when no session is stored", async () => {
      mockLoad.mockResolvedValue(null);
      const before = useAppStore.getState().tabGroups;

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(false);
      expect(useAppStore.getState().tabGroups).toBe(before);
      // A genuinely empty/absent session is not a failure — stay silent (G3, #1146).
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.info).not.toHaveBeenCalled();
    });

    // G3 (#1146): a corrupt/failed load must not leave the user at a blank
    // window with no explanation — surface an error toast.
    it("surfaces an error toast when the load fails", async () => {
      mockLoad.mockRejectedValue(new Error("corrupt last-session.json"));

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(false);
      expect(mockToast.error).toHaveBeenCalledTimes(1);
      expect(mockToast.error.mock.calls[0][0]).toMatch(/restore/i);
    });

    // G3 (#1146): a stored session whose tabs all fail to build (e.g. every
    // referenced connection was deleted) must be surfaced, not silently dropped.
    it("surfaces a notice when a stored session builds no launchable tabs", async () => {
      mockLoad.mockResolvedValue({
        version: "1",
        activeGroupIndex: 0,
        tabGroups: [{ name: "Gone", layout: { type: "leaf", tabs: [] } }],
      });

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(false);
      expect(mockToast.info).toHaveBeenCalledTimes(1);
      expect(mockToast.info.mock.calls[0][0]).toMatch(/no launchable tabs/i);
      // Not an error — this is a soft notice.
      expect(mockToast.error).not.toHaveBeenCalled();
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
      // A successful restore must stay silent — no failure/notice toast (G3, #1146).
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.info).not.toHaveBeenCalled();
    });
  });

  describe("clearLastSession", () => {
    it("invokes the clear command", async () => {
      await useAppStore.getState().clearLastSession();
      expect(mockClear).toHaveBeenCalledTimes(1);
    });
  });
});
