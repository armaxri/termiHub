import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppSettings } from "@/types/connection";
import type { ThemeDefinition } from "@/themes/types";

const mockUpdateSettings = vi.fn((_s: AppSettings) => Promise.resolve());
let view: AppSettings;

vi.mock("@/store/appStore", () => ({
  useAppStore: { getState: () => ({ updateSettings: mockUpdateSettings }) },
}));
vi.mock("@/store/settingsBridge", () => ({ currentSettingsView: () => view }));

import { restoreTheme } from "./restoreTheme";

function theme(id: string): ThemeDefinition {
  return {
    id,
    name: id,
    colorScheme: "dark",
    baseTheme: "dark",
    colors: {} as ThemeDefinition["colors"],
  };
}

const base: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

describe("restoreTheme (#5158)", () => {
  beforeEach(() => mockUpdateSettings.mockClear());

  it("puts the theme back at its index and re-selects it", () => {
    view = { ...base, theme: "dark", customThemes: [theme("a"), theme("c")], fontSize: 15 };
    restoreTheme(theme("b"), 1, "custom:b", "dark");
    const saved = mockUpdateSettings.mock.calls[0][0];
    expect(saved.customThemes!.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(saved.theme).toBe("custom:b");
    // An unrelated edit made inside the undo window is kept.
    expect(saved.fontSize).toBe(15);
  });

  it("keeps a theme the user picked after the delete", () => {
    view = { ...base, theme: "light", customThemes: [] };
    restoreTheme(theme("b"), 0, "custom:b", "dark");
    expect(mockUpdateSettings.mock.calls[0][0].theme).toBe("light");
  });

  it("appends when the index is out of range and never duplicates", () => {
    view = { ...base, theme: "dark", customThemes: [theme("b"), theme("a")] };
    restoreTheme(theme("b"), 9, "custom:b", "dark");
    expect(mockUpdateSettings.mock.calls[0][0].customThemes!.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
