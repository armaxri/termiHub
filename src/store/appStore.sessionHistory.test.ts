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

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/sessionHistoryApi", () => ({
  getSessionHistory: vi.fn(() => Promise.resolve([])),
  recordSession: vi.fn(() => Promise.resolve([])),
  setHistoryEntryPinned: vi.fn(() => Promise.resolve([])),
  markHistoryEntryPromoted: vi.fn(() => Promise.resolve([])),
  removeHistoryEntry: vi.fn(() => Promise.resolve([])),
  clearSessionHistory: vi.fn(() => Promise.resolve([])),
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
import { recordSession as apiRecordSession } from "@/services/sessionHistoryApi";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import type { ConnectionConfig } from "@/types/terminal";

setupSettingsRegion();

const mockRecord = vi.mocked(apiRecordSession);

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("appStore session history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessionHistory: [] });
  });

  it("does not record when session history is disabled", async () => {
    seedSettings({ sessionHistoryEnabled: false });
    await useAppStore
      .getState()
      .recordSession("ssh", { type: "ssh", config: { host: "h", username: "u" } });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("records with the password stripped and a computed title", async () => {
    seedSettings({ sessionHistoryEnabled: true, sessionHistoryLimit: 25 });
    const config: ConnectionConfig = {
      type: "ssh",
      config: { host: "prod", username: "admin", port: 22, password: "s3cret" },
    };
    await useAppStore.getState().recordSession("ssh", config);

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [type, sentConfig, title, limit] = mockRecord.mock.calls[0];
    expect(type).toBe("ssh");
    expect(title).toBe("admin@prod");
    expect(limit).toBe(25);
    expect((sentConfig.config as Record<string, unknown>).password).toBeUndefined();
    expect((sentConfig.config as Record<string, unknown>).host).toBe("prod");
  });

  it("records a terminal tab opened via addTab", async () => {
    seedSettings({ sessionHistoryEnabled: true });
    useAppStore
      .getState()
      .addTab("admin@prod", "ssh", { type: "ssh", config: { host: "prod", username: "admin" } });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toBe("ssh");
  });

  it("does not record a non-terminal tab (settings/editor)", async () => {
    seedSettings({ sessionHistoryEnabled: true });
    useAppStore
      .getState()
      .addTab("Settings", "local", { type: "local", config: {} }, { contentType: "settings" });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
