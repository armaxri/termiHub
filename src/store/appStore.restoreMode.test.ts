import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store (mirrors appStore.lastSession.test.ts).
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
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

// The restore-mode decision logic now lives in `core::restore_mode` and is
// reached over IPC (#2200), so it is unavailable in this JS test environment.
// These are store-orchestration tests; mock the (async) decision boundary with
// deterministic outputs — the logic's correctness is proven by the Rust golden
// vectors (`core/tests/restore_mode_golden.rs`). The `resolveRestoreMode` mock
// mirrors the core guard so mode-driven branches stay input-driven.
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
import { currentSettingsView } from "./settingsBridge";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { saveLastSession, loadLastSession, clearLastSession } from "@/services/lastSessionApi";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();
import { saveSettings } from "@/services/storage";
import { summarizeLastSession } from "@/utils/restoreMode";
import type { LastSession } from "@/types/lastSession";

const mockSummarize = vi.mocked(summarizeLastSession);

const mockSave = vi.mocked(saveLastSession);
const mockLoad = vi.mocked(loadLastSession);
const mockClear = vi.mocked(clearLastSession);
const mockPersistSettings = vi.mocked(saveSettings);

const storedSession: LastSession = {
  version: "1",
  activeGroupIndex: 0,
  tabGroups: [
    {
      name: "Restored",
      layout: {
        type: "leaf",
        tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell A" }],
      },
    },
  ],
};

describe("startup restore mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(null);
    useAppStore.setState({
      defaultShell: "bash",
      restorePrompt: null,
    });
    seedSettings({
      restoreLastSessionOnStartup: undefined,
      restoreLastSessionMode: "ask",
    });
    seedConnectionsRegion({ connections: [] });
    useAppStore.getState().addTab("Shell", "local", { type: "local", config: { shell: "bash" } });
  });

  describe("saveLastSession honours the mode", () => {
    it("skips persisting when the mode is never", async () => {
      seedSettings({ restoreLastSessionMode: "never" });

      await useAppStore.getState().saveLastSession();

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("persists when the mode is ask", async () => {
      await useAppStore.getState().saveLastSession();
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it("persists when the mode is always", async () => {
      seedSettings({ restoreLastSessionMode: "always" });
      await useAppStore.getState().saveLastSession();
      expect(mockSave).toHaveBeenCalledTimes(1);
    });
  });

  describe("promptRestore", () => {
    it("raises the prompt when a session with tabs is stored", async () => {
      mockLoad.mockResolvedValue(storedSession);
      mockSummarize.mockResolvedValueOnce({
        tabCount: 1,
        tabs: [{ title: "Shell A", typeLabel: "Local", target: { kind: "local" } }],
      });

      await useAppStore.getState().promptRestore();

      const prompt = useAppStore.getState().restorePrompt;
      expect(prompt).not.toBeNull();
      expect(prompt?.tabCount).toBe(1);
      expect(prompt?.tabs[0].title).toBe("Shell A");
    });

    it("does not raise the prompt when nothing is stored", async () => {
      mockLoad.mockResolvedValue(null);

      await useAppStore.getState().promptRestore();

      expect(useAppStore.getState().restorePrompt).toBeNull();
    });

    it("does not raise the prompt when the stored session has no tabs", async () => {
      mockLoad.mockResolvedValue({
        version: "1",
        activeGroupIndex: 0,
        tabGroups: [{ name: "Empty", layout: { type: "leaf", tabs: [] } }],
      });

      await useAppStore.getState().promptRestore();

      expect(useAppStore.getState().restorePrompt).toBeNull();
    });
  });

  describe("confirmRestorePrompt (Restore)", () => {
    beforeEach(() => {
      useAppStore.setState({
        restorePrompt: { tabCount: 1, tabs: [{ title: "x", typeLabel: "Local" }] },
      });
      mockLoad.mockResolvedValue(storedSession);
    });

    it("restores the session and clears the prompt", async () => {
      await useAppStore.getState().confirmRestorePrompt(false);

      expect(useAppStore.getState().restorePrompt).toBeNull();
      expect(useAppStore.getState().tabGroups[0].name).toBe("Restored");
    });

    it("persists mode=always when remember is set", async () => {
      await useAppStore.getState().confirmRestorePrompt(true);

      expect(currentSettingsView().restoreLastSessionMode).toBe("always");
      expect(mockPersistSettings).toHaveBeenCalled();
      expect(
        (mockPersistSettings.mock.calls[0][0] as { restoreLastSessionMode?: string })
          .restoreLastSessionMode
      ).toBe("always");
    });

    it("does not change the mode when remember is not set", async () => {
      await useAppStore.getState().confirmRestorePrompt(false);

      expect(currentSettingsView().restoreLastSessionMode).toBe("ask");
      expect(mockPersistSettings).not.toHaveBeenCalled();
    });
  });

  describe("dismissRestorePrompt (Start Fresh)", () => {
    beforeEach(() => {
      useAppStore.setState({
        restorePrompt: { tabCount: 1, tabs: [{ title: "x", typeLabel: "Local" }] },
      });
    });

    it("clears the stored session and the prompt", async () => {
      await useAppStore.getState().dismissRestorePrompt(false);

      expect(useAppStore.getState().restorePrompt).toBeNull();
      expect(mockClear).toHaveBeenCalledTimes(1);
    });

    it("persists mode=never when remember is set", async () => {
      await useAppStore.getState().dismissRestorePrompt(true);

      expect(currentSettingsView().restoreLastSessionMode).toBe("never");
      expect(
        (mockPersistSettings.mock.calls[0][0] as { restoreLastSessionMode?: string })
          .restoreLastSessionMode
      ).toBe("never");
    });

    it("does not change the mode when remember is not set", async () => {
      await useAppStore.getState().dismissRestorePrompt(false);

      expect(currentSettingsView().restoreLastSessionMode).toBe("ask");
      expect(mockPersistSettings).not.toHaveBeenCalled();
    });
  });
});
