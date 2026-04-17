import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UpdateInfo } from "@/types/connection";

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: vi.fn(),
  monitoringClose: vi.fn(() => Promise.resolve()),
  monitoringFetchStats: vi.fn(),
  // Update checker mocks — these return controlled values per test
  checkForUpdates: vi.fn(),
  skipUpdateVersion: vi.fn(() => Promise.resolve()),
  clearSkippedVersion: vi.fn(() => Promise.resolve()),
  setUpdateAutoCheck: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";

const MOCK_REGULAR_UPDATE: UpdateInfo = {
  available: true,
  latestVersion: "0.2.0",
  releaseUrl: "https://github.com/armaxri/termiHub/releases/tag/v0.2.0",
  releaseNotes: "New features and bug fixes",
  isSecurity: false,
};

const MOCK_SECURITY_UPDATE: UpdateInfo = {
  available: true,
  latestVersion: "0.1.1",
  releaseUrl: "https://github.com/armaxri/termiHub/releases/tag/v0.1.1",
  releaseNotes: "<!-- security -->\nFixes CVE-2026-0001",
  isSecurity: true,
};

const MOCK_NO_UPDATE: UpdateInfo = {
  available: false,
  latestVersion: "0.1.0",
  releaseUrl: "",
  releaseNotes: "",
  isSecurity: false,
};

describe("appStore — update checker", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("starts in idle state with no updateInfo", () => {
    const state = useAppStore.getState();
    expect(state.updateCheckState).toBe("idle");
    expect(state.updateInfo).toBeNull();
    expect(state.updateNotificationDismissed).toBe(false);
  });

  it("sets state to 'available' when update is found", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_REGULAR_UPDATE);

    await useAppStore.getState().checkForUpdates(false);

    const state = useAppStore.getState();
    expect(state.updateCheckState).toBe("available");
    expect(state.updateInfo?.latestVersion).toBe("0.2.0");
    expect(state.updateInfo?.isSecurity).toBe(false);
    expect(state.updateNotificationDismissed).toBe(false);
  });

  it("sets state to 'up-to-date' when no update is available", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_NO_UPDATE);

    await useAppStore.getState().checkForUpdates(false);

    const state = useAppStore.getState();
    expect(state.updateCheckState).toBe("up-to-date");
    expect(state.updateInfo?.available).toBe(false);
  });

  it("sets state to 'error' on API failure", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockRejectedValueOnce(new Error("Network error"));

    await useAppStore.getState().checkForUpdates(false);

    expect(useAppStore.getState().updateCheckState).toBe("error");
  });

  it("detects security update and does not auto-dismiss notification", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_SECURITY_UPDATE);

    await useAppStore.getState().checkForUpdates(false);

    const state = useAppStore.getState();
    expect(state.updateCheckState).toBe("available");
    expect(state.updateInfo?.isSecurity).toBe(true);
    expect(state.updateNotificationDismissed).toBe(false);
  });

  it("auto-dismisses notification popup for skipped version", async () => {
    // Pre-set a skipped version in settings
    useAppStore.setState({
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
        updates: { autoCheck: true, skippedVersion: "0.2.0" },
      },
    });

    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_REGULAR_UPDATE);

    await useAppStore.getState().checkForUpdates(false);

    const state = useAppStore.getState();
    expect(state.updateCheckState).toBe("available");
    // Dot still shows, but popup is pre-dismissed for the skipped version
    expect(state.updateNotificationDismissed).toBe(true);
  });

  it("does NOT auto-dismiss notification for security updates even if version was skipped", async () => {
    useAppStore.setState({
      settings: {
        version: "1",
        externalConnectionFiles: [],
        powerMonitoringEnabled: true,
        fileBrowserEnabled: true,
        updates: { autoCheck: true, skippedVersion: "0.1.1" },
      },
    });

    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_SECURITY_UPDATE);

    await useAppStore.getState().checkForUpdates(false);

    // Security update must never be suppressed by skip
    expect(useAppStore.getState().updateNotificationDismissed).toBe(false);
  });

  it("dismissUpdateNotification sets dismissed flag", () => {
    useAppStore.setState({ updateCheckState: "available", updateInfo: MOCK_REGULAR_UPDATE });

    useAppStore.getState().dismissUpdateNotification();

    expect(useAppStore.getState().updateNotificationDismissed).toBe(true);
  });

  it("skipUpdate calls API and refreshes settings", async () => {
    useAppStore.setState({ updateCheckState: "available", updateInfo: MOCK_REGULAR_UPDATE });
    const { skipUpdateVersion } = await import("@/services/api");

    await useAppStore.getState().skipUpdate();

    expect(skipUpdateVersion).toHaveBeenCalledWith("0.2.0");
    expect(useAppStore.getState().updateNotificationDismissed).toBe(true);
  });

  it("skipUpdate is a no-op when no updateInfo", async () => {
    useAppStore.setState({ updateInfo: null });
    const { skipUpdateVersion } = await import("@/services/api");

    await useAppStore.getState().skipUpdate();

    expect(skipUpdateVersion).not.toHaveBeenCalled();
  });

  it("clearSkippedUpdateVersion calls API", async () => {
    const { clearSkippedVersion } = await import("@/services/api");

    await useAppStore.getState().clearSkippedUpdateVersion();

    expect(clearSkippedVersion).toHaveBeenCalled();
  });

  it("passes force=true to API when manual check triggered", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");
    vi.mocked(apiCheck).mockResolvedValueOnce(MOCK_NO_UPDATE);

    await useAppStore.getState().checkForUpdates(true);

    expect(apiCheck).toHaveBeenCalledWith(true);
  });

  it("sets checking state while request is in flight", async () => {
    const { checkForUpdates: apiCheck } = await import("@/services/api");

    let resolveCheck!: (v: UpdateInfo) => void;
    vi.mocked(apiCheck).mockReturnValueOnce(
      new Promise<UpdateInfo>((resolve) => {
        resolveCheck = resolve;
      })
    );

    const checkPromise = useAppStore.getState().checkForUpdates(false);
    expect(useAppStore.getState().updateCheckState).toBe("checking");

    resolveCheck(MOCK_NO_UPDATE);
    await checkPromise;
    expect(useAppStore.getState().updateCheckState).toBe("up-to-date");
  });
});
