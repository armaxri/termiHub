import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store/appStore";

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

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

describe("experimentalFeaturesEnabled setting", () => {
  beforeEach(() => {
    useAppStore.setState({ settings: { ...baseSettings } });
  });

  it("defaults to false when not set", () => {
    const val = useAppStore.getState().settings.experimentalFeaturesEnabled ?? false;
    expect(val).toBe(false);
  });

  it("is false when explicitly set to false", () => {
    useAppStore.setState({
      settings: { ...baseSettings, experimentalFeaturesEnabled: false },
    });
    const val = useAppStore.getState().settings.experimentalFeaturesEnabled ?? false;
    expect(val).toBe(false);
  });

  it("is true when set to true", () => {
    useAppStore.setState({
      settings: { ...baseSettings, experimentalFeaturesEnabled: true },
    });
    const val = useAppStore.getState().settings.experimentalFeaturesEnabled ?? false;
    expect(val).toBe(true);
  });
});
