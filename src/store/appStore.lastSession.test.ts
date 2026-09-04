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

// Multi-window aggregation/restore commands (#1925). Untyped wrappers so the
// resolved values can be set per-test.
const openWindow = vi.fn();
const reportWindowLayout = vi.fn();
const collectWindowLayouts = vi.fn();
const takePendingWindowRestore = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  reportWindowLayout: (...args: unknown[]) => reportWindowLayout(...args),
  collectWindowLayouts: (...args: unknown[]) => collectWindowLayouts(...args),
  takePendingWindowRestore: (...args: unknown[]) => takePendingWindowRestore(...args),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

// The restore-mode decision logic now lives in `core::restore_mode`, reached
// over IPC (#2200) and thus unavailable in this JS test. Mock the async decision
// boundary; `resolveRestoreMode` mirrors the core guard so the mode-driven
// save/skip branches stay input-driven. Parity with the retired TS logic is
// proven by the Rust golden vectors (`core/tests/restore_mode_golden.rs`).
vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: vi.fn(
    async (s: { restoreLastSessionMode?: string; restoreLastSessionOnStartup?: boolean }) => {
      const m = s.restoreLastSessionMode;
      if (m === "never" || m === "ask" || m === "always") return m;
      if (s.restoreLastSessionOnStartup === false) return "never";
      return "ask";
    }
  ),
  summarizeLastSession: vi.fn(async () => ({ tabCount: 0, tabs: [] })),
  filterSessionBySelection: vi.fn(async (session: unknown) => session),
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
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { saveLastSession, loadLastSession, clearLastSession } from "@/services/lastSessionApi";
import { toast } from "@/components/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LastSession } from "@/types/lastSession";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState, seedLayoutState } from "@/test/layoutState";

const mockSave = vi.mocked(saveLastSession);
const mockLoad = vi.mocked(loadLastSession);
const mockClear = vi.mocked(clearLastSession);
const mockToast = vi.mocked(toast);
const mockCurrentWindow = vi.mocked(getCurrentWindow);

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

describe("last session persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    // Default: aggregation unavailable → each save/restore falls back to this
    // window only (byte-identical legacy shape); overridden per multi-window test.
    reportWindowLayout.mockResolvedValue(undefined);
    collectWindowLayouts.mockResolvedValue([]);
    takePendingWindowRestore.mockResolvedValue(null);
    openWindow.mockResolvedValue("win-1");
    // Reset to a clean single empty terminal group.
    useAppStore.setState({
      defaultShell: "bash",
    });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
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
      seedSettings({ restoreLastSessionOnStartup: false });

      await useAppStore.getState().saveLastSession();

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("persists an empty payload when there are no real tabs", async () => {
      // Replace the live layout with an empty leaf (no tabs).
      const state = useAppStore.getState();
      const group = state.tabGroups[0];
      const emptyRoot = { type: "leaf" as const, id: "leaf-empty", tabs: [], activeTabId: null };
      seedLayoutState({
        tabGroups: [{ ...group, rootPanel: emptyRoot, activePanelId: emptyRoot.id }],
        rootPanel: emptyRoot,
        activePanelId: emptyRoot.id,
      });

      await useAppStore.getState().saveLastSession();

      const payload = mockSave.mock.calls[0][0] as LastSession;
      expect(payload.tabGroups).toHaveLength(0);
    });
  });

  // Window dimension (#1905/#1925): the save path stamps the capturing window and
  // the restore path spawns + hydrates the saved secondary windows.
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

    it("spawns the saved secondary windows and restores only the main groups here (#1925)", async () => {
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
      // This (main) window holds only its own group; the secondary window is
      // spawned to hold group B rather than collapsed into main.
      const groups = layoutState().tabGroups;
      expect(groups.map((g) => g.name)).toEqual(["A"]);
      // One secondary window is spawned, seeded with win-1's group B.
      expect(openWindow).toHaveBeenCalledTimes(1);
      const [handoffArg, restoreArg] = openWindow.mock.calls[0];
      expect(handoffArg).toBeUndefined();
      // The seeded group keeps its saved windowId (hydration ignores it).
      expect(restoreArg).toEqual({
        tabGroups: [{ name: "B", layout: leaf("b"), windowId: "win-1" }],
      });
    });

    it("spawns an empty window for a saved empty secondary window (#1902/#1925)", async () => {
      mockLoad.mockResolvedValue({
        version: "1",
        activeGroupIndex: 0,
        tabGroups: [
          {
            name: "A",
            layout: {
              type: "leaf",
              tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "a" }],
            },
          },
        ],
        windows: [{ id: "main" }, { id: "win-1" }],
      });

      const ok = await useAppStore.getState().restoreLastSession();

      expect(ok).toBe(true);
      // win-1 owns no groups → spawn a plain empty window (no restore payload).
      expect(openWindow).toHaveBeenCalledTimes(1);
      expect(openWindow.mock.calls[0]).toEqual([]);
    });
  });

  // Multi-window aggregation on save (#1925): the main window persists a document
  // spanning every open window from the backend-reported slices it cannot see.
  describe("multi-window aggregation (#1925)", () => {
    it("assembles every window's reported slice into one saved document", async () => {
      // The backend authority reports main (its live group) + win-1 (group B).
      const leafB = {
        type: "leaf" as const,
        tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "b" }],
      };
      collectWindowLayouts.mockResolvedValue([
        {
          label: "main",
          tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [] } }],
          activeGroupIndex: 0,
        },
        { label: "win-1", tabGroups: [{ name: "B", layout: leafB }], activeGroupIndex: 0 },
      ]);

      await useAppStore.getState().saveLastSession();

      expect(reportWindowLayout).toHaveBeenCalledTimes(1);
      const payload = mockSave.mock.calls[0][0] as LastSession;
      // Both windows recorded; win-1's group carries its windowId, main's does not.
      expect(payload.windows).toEqual([{ id: "main" }, { id: "win-1" }]);
      const winIds = payload.tabGroups.map((g) => g.windowId);
      expect(winIds).toEqual([undefined, "win-1"]);
    });

    it("hydrates a restore-spawned window from its seeded groups (#1925)", async () => {
      takePendingWindowRestore.mockResolvedValue({
        tabGroups: [
          {
            name: "Seeded",
            layout: {
              type: "leaf",
              tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "S" }],
            },
          },
        ],
      });

      await useAppStore.getState().receivePendingWindowRestore();

      const state = useAppStore.getState();
      expect(state.tabGroups.map((g) => g.name)).toEqual(["Seeded"]);
      const tabs = getAllLeaves(state.rootPanel).flatMap((l) => l.tabs);
      expect(tabs.map((t) => t.title)).toEqual(["S"]);
    });

    it("is a no-op when there is no seeded restore payload", async () => {
      takePendingWindowRestore.mockResolvedValue(null);
      const before = layoutState().tabGroups;

      await useAppStore.getState().receivePendingWindowRestore();

      expect(layoutState().tabGroups).toBe(before);
    });
  });

  describe("restoreLastSession", () => {
    it("returns false and changes nothing when no session is stored", async () => {
      mockLoad.mockResolvedValue(null);
      const before = layoutState().tabGroups;

      const restored = await useAppStore.getState().restoreLastSession();

      expect(restored).toBe(false);
      expect(layoutState().tabGroups).toBe(before);
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
