/**
 * PluginUpdateCheckSettings (PROD-051): the default-off periodic plugin update
 * check. Pins that the section explains the install-only / confirm-always model,
 * the toggle defaults off, and flipping it persists the merged settings.
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

import { PluginUpdateCheckSettings } from "./PluginUpdateCheckSettings";

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
    root.render(<PluginUpdateCheckSettings />);
  });
}

describe("PluginUpdateCheckSettings", () => {
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

  it("renders the section explaining updates are never installed automatically", () => {
    render();
    expect(query("settings-plugin-update-check")).not.toBeNull();
    expect(container.textContent).toContain("never installed automatically");
  });

  it("defaults the toggle off when the setting is unset", () => {
    render();
    expect(query("settings-plugin-update-check-enabled")!.getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("persists the merged settings with the flag on when enabled", () => {
    render();
    act(() => query("settings-plugin-update-check-enabled")!.click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ ...baseSettings, pluginUpdateCheckEnabled: true })
    );
  });

  it("persists the flag off when disabled", () => {
    mockSettings = { ...baseSettings, pluginUpdateCheckEnabled: true };
    render();
    expect(query("settings-plugin-update-check-enabled")!.getAttribute("aria-checked")).toBe(
      "true"
    );
    act(() => query("settings-plugin-update-check-enabled")!.click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pluginUpdateCheckEnabled: false })
    );
  });
});
