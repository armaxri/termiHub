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
import { currentSettingsView } from "./settingsBridge";
import { setupSettingsRegion, seedSettings, settingsDoc } from "@/test/settingsRegionTestHarness";

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

/**
 * Seed the authoritative `settings` region with a shared base document carrying
 * the given shell-integration value. The persisted settings document is now
 * region-authoritative (#2404): `updateShellIntegration` reads/writes it via the
 * `settings.*` bridge, so tests seed the region and read it back through the
 * projection instead of an `appStore` slice.
 */
function seedBase(shellIntegration: ShellIntegrationSettings): AppSettings {
  const base = settingsDoc({ shellIntegration });
  seedSettings(base);
  return base;
}

describe("appStore — updateShellIntegration", () => {
  // The persisted settings document is region-authoritative (#2404): seed the
  // `settings` region, not an `appStore` slice, and read it back via the projection.
  setupSettingsRegion();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("patches the settings region and returns the refreshed status on success", async () => {
    const prevSi = makeSi();
    seedBase(prevSi);
    const nextSi = makeSi({ openInNewWindow: true });
    const refreshed = makeStatus({ registered: true, registeredExePath: "/opt/th" });
    mockSaveShellIntegration.mockResolvedValueOnce(refreshed);

    const result = await useAppStore.getState().updateShellIntegration(nextSi);

    expect(mockSaveShellIntegration).toHaveBeenCalledWith(nextSi);
    expect(result).toEqual(refreshed);

    // The authoritative region reflects the persisted shell-integration value.
    expect(currentSettingsView().shellIntegration).toEqual(nextSi);
  });

  it("rolls the settings region back and re-throws when the backend rejects", async () => {
    const prevSi = makeSi();
    const base = seedBase(prevSi);
    const nextSi = makeSi({ firstLaunchBannerDismissed: true });
    const failure = new Error("command failed");
    mockSaveShellIntegration.mockRejectedValueOnce(failure);

    await expect(useAppStore.getState().updateShellIntegration(nextSi)).rejects.toThrow(
      "command failed"
    );

    const view = currentSettingsView();
    // Rolled back to the previously-persisted shell-integration value.
    expect(view.shellIntegration).toEqual(prevSi);
    // The rest of the settings document is untouched.
    expect(view.version).toBe(base.version);
    expect(view.powerMonitoringEnabled).toBe(base.powerMonitoringEnabled);
  });

  it("rollback preserves a concurrent general-settings edit made mid-persist", async () => {
    const prevSi = makeSi();
    seedBase(prevSi);
    const nextSi = makeSi({ openInNewWindow: true });

    // Simulate a general-settings edit landing on the region (a `settings.patch`)
    // while the shell-integration persist is in flight, then reject. Because the
    // rollback is a targeted `shellIntegration` patch (not a whole-document
    // replace), the concurrent edit must survive.
    mockSaveShellIntegration.mockImplementationOnce(() => {
      seedSettings({ fontSize: 15 });
      return Promise.reject(new Error("boom"));
    });

    await expect(useAppStore.getState().updateShellIntegration(nextSi)).rejects.toThrow("boom");

    const view = currentSettingsView();
    // Shell integration is rolled back, but the concurrent general edit is preserved.
    expect(view.shellIntegration).toEqual(prevSi);
    expect(view.fontSize).toBe(15);
  });
});
