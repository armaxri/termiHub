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

// Keep every real frontendLog export intact and spy only on `frontendLog`, so the
// slice's error branches can be asserted (they log rather than throw) without
// breaking the many other appStore consumers of this module.
vi.mock("@/utils/frontendLog", async (orig) => ({
  ...(await orig<typeof import("@/utils/frontendLog")>()),
  frontendLog: vi.fn(),
}));

import { useAppStore } from "./appStore";
import {
  recordSession as apiRecordSession,
  getSessionHistory,
  setHistoryEntryPinned as apiSetHistoryEntryPinned,
  markHistoryEntryPromoted as apiMarkHistoryEntryPromoted,
  removeHistoryEntry as apiRemoveHistoryEntry,
  clearSessionHistory as apiClearSessionHistory,
} from "@/services/sessionHistoryApi";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { frontendLog } from "@/utils/frontendLog";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import type { ConnectionConfig } from "@/types/terminal";

setupSettingsRegion();

const mockRecord = vi.mocked(apiRecordSession);
const mockLog = vi.mocked(frontendLog);

function makeEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    dedupKey: "ssh:admin@prod:22",
    title: "admin@prod",
    connectionType: "ssh",
    config: { type: "ssh", config: { host: "prod", username: "admin" } },
    firstUsed: 1,
    lastUsed: 2,
    useCount: 1,
    pinned: false,
    promoted: false,
    ...overrides,
  };
}

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

describe("appStore session history — load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessionHistory: [] });
  });

  it("loadSessionHistory stores the entries returned by the backend", async () => {
    const entries = [makeEntry({ dedupKey: "a" }), makeEntry({ dedupKey: "b" })];
    vi.mocked(getSessionHistory).mockResolvedValueOnce(entries);

    await useAppStore.getState().loadSessionHistory();

    expect(useAppStore.getState().sessionHistory).toEqual(entries);
  });

  it("loadSessionHistory logs and leaves state intact when the backend rejects (Error)", async () => {
    useAppStore.setState({ sessionHistory: [makeEntry({ dedupKey: "keep" })] });
    vi.mocked(getSessionHistory).mockRejectedValueOnce(new Error("db locked"));

    await useAppStore.getState().loadSessionHistory();

    expect(useAppStore.getState().sessionHistory.map((e) => e.dedupKey)).toEqual(["keep"]);
    expect(mockLog).toHaveBeenCalledWith(
      "session_history",
      expect.stringContaining("Failed to load session history: db locked")
    );
  });

  it("loadSessionHistory stringifies a non-Error rejection (String(err) branch)", async () => {
    // Reject with a plain string so the `err instanceof Error` guard takes its
    // `String(err)` alternate rather than reading `.message`.
    vi.mocked(getSessionHistory).mockRejectedValueOnce("boom");

    await useAppStore.getState().loadSessionHistory();

    expect(mockLog).toHaveBeenCalledWith(
      "session_history",
      expect.stringContaining("Failed to load session history: boom")
    );
  });
});

describe("appStore session history — record error branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessionHistory: [makeEntry({ dedupKey: "prior" })] });
    seedSettings({ sessionHistoryEnabled: true });
  });

  it("recordSession logs and keeps prior state when the backend rejects (Error)", async () => {
    vi.mocked(apiRecordSession).mockRejectedValueOnce(new Error("write failed"));

    await useAppStore
      .getState()
      .recordSession("ssh", { type: "ssh", config: { host: "h", username: "u" } });

    expect(useAppStore.getState().sessionHistory.map((e) => e.dedupKey)).toEqual(["prior"]);
    expect(mockLog).toHaveBeenCalledWith(
      "session_history",
      expect.stringContaining("Failed to record session: write failed")
    );
  });

  it("recordSession stringifies a non-Error rejection (String(err) branch)", async () => {
    vi.mocked(apiRecordSession).mockRejectedValueOnce("nope");

    await useAppStore
      .getState()
      .recordSession("ssh", { type: "ssh", config: { host: "h", username: "u" } });

    expect(mockLog).toHaveBeenCalledWith(
      "session_history",
      expect.stringContaining("Failed to record session: nope")
    );
  });

  it("recordSession falls back to the default limit of 50 when unset", async () => {
    seedSettings({ sessionHistoryEnabled: true, sessionHistoryLimit: undefined });
    vi.mocked(apiRecordSession).mockResolvedValueOnce([]);

    await useAppStore
      .getState()
      .recordSession("ssh", { type: "ssh", config: { host: "h", username: "u" } });

    expect(mockRecord.mock.calls[0][3]).toBe(50);
  });
});

describe("appStore session history — pin/promote/remove/clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessionHistory: [] });
  });

  it("pinHistoryEntry stores the backend's returned entries", async () => {
    const pinned = [makeEntry({ dedupKey: "a", pinned: true })];
    vi.mocked(apiSetHistoryEntryPinned).mockResolvedValueOnce(pinned);

    await useAppStore.getState().pinHistoryEntry("a", true);

    expect(vi.mocked(apiSetHistoryEntryPinned)).toHaveBeenCalledWith("a", true);
    expect(useAppStore.getState().sessionHistory).toEqual(pinned);
  });

  it("markHistoryPromoted stores the backend's returned entries", async () => {
    const promoted = [makeEntry({ dedupKey: "a", promoted: true })];
    vi.mocked(apiMarkHistoryEntryPromoted).mockResolvedValueOnce(promoted);

    await useAppStore.getState().markHistoryPromoted("a");

    expect(vi.mocked(apiMarkHistoryEntryPromoted)).toHaveBeenCalledWith("a");
    expect(useAppStore.getState().sessionHistory).toEqual(promoted);
  });

  it("removeHistoryEntry stores the backend's returned entries", async () => {
    useAppStore.setState({ sessionHistory: [makeEntry({ dedupKey: "a" })] });
    vi.mocked(apiRemoveHistoryEntry).mockResolvedValueOnce([]);

    await useAppStore.getState().removeHistoryEntry("a");

    expect(vi.mocked(apiRemoveHistoryEntry)).toHaveBeenCalledWith("a");
    expect(useAppStore.getState().sessionHistory).toEqual([]);
  });

  it("clearSessionHistory stores the empty list the backend returns", async () => {
    useAppStore.setState({ sessionHistory: [makeEntry({ dedupKey: "a" })] });
    vi.mocked(apiClearSessionHistory).mockResolvedValueOnce([]);

    await useAppStore.getState().clearSessionHistory();

    expect(vi.mocked(apiClearSessionHistory)).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sessionHistory).toEqual([]);
  });
});
