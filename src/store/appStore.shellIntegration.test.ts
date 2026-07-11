import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AppSettings,
  ShellIntegrationSettings,
  ShellIntegrationStatus,
} from "@/types/connection";

// Mock service modules before importing the store.
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

const mockSaveShellIntegration =
  vi.fn<(si: ShellIntegrationSettings) => Promise<ShellIntegrationStatus>>();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  saveShellIntegrationSettings: (si: ShellIntegrationSettings) => mockSaveShellIntegration(si),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { useAppStore } from "./appStore";

/** Build a minimal shell-integration settings value for tests. */
function makeSi(overrides: Partial<ShellIntegrationSettings> = {}): ShellIntegrationSettings {
  return {
    entries: [],
    fallback: "picker",
    openInNewWindow: false,
    registered: false,
    linuxFileManagers: { nautilus: false, kde: false, thunar: false },
    firstLaunchBannerDismissed: false,
    ...overrides,
  };
}

/** Build a status result for the mocked backend command. */
function makeStatus(overrides: Partial<ShellIntegrationStatus> = {}): ShellIntegrationStatus {
  return {
    registered: false,
    exePathMatches: true,
    stale: false,
    portable: false,
    detectedFileManagers: [],
    ...overrides,
  };
}

/** Seed the store's `settings`/`savedSettings` with a shared base + shell integration. */
function seedSettings(shellIntegration: ShellIntegrationSettings): AppSettings {
  const base: AppSettings = {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    shellIntegration,
  };
  useAppStore.setState({ settings: base, savedSettings: base });
  return base;
}

describe("appStore — updateShellIntegration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("updates settings and savedSettings and returns the refreshed status on success", async () => {
    const prevSi = makeSi();
    seedSettings(prevSi);
    const nextSi = makeSi({ openInNewWindow: true });
    const refreshed = makeStatus({ registered: true, registeredExePath: "/opt/th" });
    mockSaveShellIntegration.mockResolvedValueOnce(refreshed);

    const result = await useAppStore.getState().updateShellIntegration(nextSi);

    expect(mockSaveShellIntegration).toHaveBeenCalledWith(nextSi);
    expect(result).toEqual(refreshed);

    const state = useAppStore.getState();
    expect(state.settings.shellIntegration).toEqual(nextSi);
    expect(state.savedSettings.shellIntegration).toEqual(nextSi);
    // settings and savedSettings stay in lockstep after a successful persist.
    expect(state.settings).toBe(state.savedSettings);
  });

  it("rolls back settings and savedSettings and re-throws when the backend rejects", async () => {
    const prevSi = makeSi();
    const base = seedSettings(prevSi);
    const nextSi = makeSi({ firstLaunchBannerDismissed: true });
    const failure = new Error("command failed");
    mockSaveShellIntegration.mockRejectedValueOnce(failure);

    await expect(useAppStore.getState().updateShellIntegration(nextSi)).rejects.toThrow(
      "command failed"
    );

    const state = useAppStore.getState();
    // Both are rolled back to the previously-persisted shell-integration value.
    expect(state.settings.shellIntegration).toEqual(prevSi);
    expect(state.savedSettings.shellIntegration).toEqual(prevSi);
    // The rest of the settings object is untouched.
    expect(state.settings.version).toBe(base.version);
    expect(state.settings.powerMonitoringEnabled).toBe(base.powerMonitoringEnabled);
  });

  it("rollback preserves a concurrent general-settings edit made mid-persist", async () => {
    const prevSi = makeSi();
    seedSettings(prevSi);
    const nextSi = makeSi({ openInNewWindow: true });

    // Simulate a general-settings edit landing on `settings` (not yet `savedSettings`)
    // while the shell-integration persist is in flight, then reject.
    mockSaveShellIntegration.mockImplementationOnce(() => {
      useAppStore.setState((s) => ({ settings: { ...s.settings, fontSize: 15 } }));
      return Promise.reject(new Error("boom"));
    });

    await expect(useAppStore.getState().updateShellIntegration(nextSi)).rejects.toThrow("boom");

    const state = useAppStore.getState();
    // Shell integration is rolled back, but the concurrent general edit is preserved.
    expect(state.settings.shellIntegration).toEqual(prevSi);
    expect(state.settings.fontSize).toBe(15);
  });
});
