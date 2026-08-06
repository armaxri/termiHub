import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store (mirrors other store tests).
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

import { useAppStore } from "./appStore";
import { currentSettingsView } from "./settingsBridge";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import * as storage from "@/services/storage";
import type { SyntaxHighlightingConfig } from "@/types/syntaxHighlighting";

setupSettingsRegion();

describe("appStore — sessionHighlighting (per-session toggle)", () => {
  beforeEach(() => {
    useAppStore.setState({ sessionHighlighting: {} });
  });

  it("starts empty", () => {
    expect(useAppStore.getState().sessionHighlighting).toEqual({});
  });

  it("records an explicit per-session override", () => {
    useAppStore.getState().setSessionHighlighting("sess-1", false);
    expect(useAppStore.getState().sessionHighlighting).toEqual({ "sess-1": false });

    useAppStore.getState().setSessionHighlighting("sess-2", true);
    expect(useAppStore.getState().sessionHighlighting).toEqual({ "sess-1": false, "sess-2": true });
  });

  it("clears an override when set to undefined", () => {
    useAppStore.getState().setSessionHighlighting("sess-1", true);
    expect(useAppStore.getState().sessionHighlighting).toHaveProperty("sess-1");

    useAppStore.getState().setSessionHighlighting("sess-1", undefined);
    expect(useAppStore.getState().sessionHighlighting).not.toHaveProperty("sess-1");
  });

  it("clearing a missing override is a no-op", () => {
    useAppStore.getState().setSessionHighlighting("never-set", undefined);
    expect(useAppStore.getState().sessionHighlighting).toEqual({});
  });
});

describe("appStore — global syntaxHighlighting config persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips the global config through updateSettings", async () => {
    const config: SyntaxHighlightingConfig = {
      enabled: true,
      builtinRules: { "error-keywords": true, "quoted-strings": true },
      customRules: [
        {
          id: "c1",
          name: "Custom",
          pattern: "foo",
          style: { color: "#123456" },
          enabled: true,
          priority: 5,
          builtin: false,
        },
      ],
    };

    const base = currentSettingsView();
    await useAppStore.getState().updateSettings({ ...base, syntaxHighlighting: config });

    // Persisted to the backend and reflected in the authoritative settings region.
    expect(storage.saveSettings).toHaveBeenCalledTimes(1);
    const persisted = (storage.saveSettings as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(persisted.syntaxHighlighting).toEqual(config);
    expect(currentSettingsView().syntaxHighlighting).toEqual(config);
  });
});
