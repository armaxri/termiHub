/**
 * FrontendPluginGateSettings (#2048): the default-off opt-in that gates untrusted
 * frontend-plugin JavaScript. These tests pin that the section + trust warning
 * render, the toggle reflects the projected setting (defaulting off), and flipping
 * it persists the merged settings via `updateSettings`. Part of TFE-007 coverage
 * (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";

let mockSettings: AppSettings;
const updateSettings = vi.fn(() => Promise.resolve());

vi.mock("@/store/useProjectedSettings", () => ({
  useProjectedSettings: (): AppSettings => mockSettings,
}));

interface FakeStoreState {
  updateSettings: (settings: AppSettings) => Promise<void>;
}

vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: FakeStoreState) => T): T => selector({ updateSettings }),
}));

import { FrontendPluginGateSettings } from "./FrontendPluginGateSettings";

let container: HTMLDivElement;
let root: Root;

const baseSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render() {
  act(() => {
    root.render(<FrontendPluginGateSettings />);
  });
}

describe("FrontendPluginGateSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockSettings = { ...baseSettings };
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the experimental section, trust warning, and toggle", () => {
    render();
    expect(query("settings-frontend-plugin-gate")).not.toBeNull();
    expect(query("settings-frontend-plugins-enabled")).not.toBeNull();
    expect(container.textContent).toContain("Frontend Plugins (Experimental)");
    expect(container.textContent).toContain("untrusted JavaScript");
  });

  it("defaults the toggle off when the setting is unset", () => {
    render();
    expect(query("settings-frontend-plugins-enabled")!.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects an enabled setting", () => {
    mockSettings = { ...baseSettings, frontendPluginsEnabled: true };
    render();
    expect(query("settings-frontend-plugins-enabled")!.getAttribute("aria-checked")).toBe("true");
  });

  it("persists the merged settings with the flag on when enabled", () => {
    render();
    act(() => query("settings-frontend-plugins-enabled")!.click());
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ ...baseSettings, frontendPluginsEnabled: true })
    );
  });

  it("persists the flag off when disabled", () => {
    mockSettings = { ...baseSettings, frontendPluginsEnabled: true };
    render();
    act(() => query("settings-frontend-plugins-enabled")!.click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ frontendPluginsEnabled: false })
    );
  });
});
