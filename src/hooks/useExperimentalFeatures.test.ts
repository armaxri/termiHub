import { describe, it, expect, vi } from "vitest";
import { currentSettingsView } from "@/store/settingsBridge";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

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

vi.mock("@/themes", () => ({ applyTheme: vi.fn() }));

setupSettingsRegion();

describe("experimentalFeaturesEnabled setting", () => {
  it("defaults to false when not set", () => {
    const val = currentSettingsView().experimentalFeaturesEnabled ?? false;
    expect(val).toBe(false);
  });

  it("is false when explicitly set to false", () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    const val = currentSettingsView().experimentalFeaturesEnabled ?? false;
    expect(val).toBe(false);
  });

  it("is true when set to true", () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    const val = currentSettingsView().experimentalFeaturesEnabled ?? false;
    expect(val).toBe(true);
  });
});
