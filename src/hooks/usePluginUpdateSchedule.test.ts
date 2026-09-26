/**
 * Tests for the opt-in periodic plugin update check (PROD-051): nothing runs
 * while the setting is off (the default) or no plugin publishes updates; when
 * on, a check runs after the startup delay and then daily, and stops again when
 * the setting is turned off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppSettings } from "@/types/connection";
import type { InstalledPlugin } from "@/types/plugin";

let mockSettings: Partial<AppSettings>;
let mockPlugins: InstalledPlugin[];
const checkForUpdates = vi.fn(() => Promise.resolve());

vi.mock("@/store/useProjectedSettings", () => ({
  useProjectedSettings: () => mockSettings,
}));
vi.mock("@/store/appStore", () => ({
  useAppStore: <T>(selector: (s: { plugins: InstalledPlugin[] }) => T): T =>
    selector({ plugins: mockPlugins }),
}));
vi.mock("@/plugins/pluginUpdateStore", () => ({
  hasUpdateSource: (p: InstalledPlugin) => Boolean(p.manifest.updateUrl),
  usePluginUpdateStore: { getState: () => ({ checkForUpdates }) },
}));

import {
  FIRST_PLUGIN_UPDATE_CHECK_DELAY_MS,
  PLUGIN_UPDATE_CHECK_INTERVAL_MS,
  usePluginUpdateSchedule,
} from "./usePluginUpdateSchedule";

let root: Root;

/** Mount a component that runs the hook; `rerender` re-renders it. */
function mountHook(): { rerender: () => void } {
  function Probe() {
    usePluginUpdateSchedule();
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  return { rerender: () => act(() => root.render(createElement(Probe))) };
}

const updatable = { manifest: { updateUrl: "https://e.com/u.json" } } as InstalledPlugin;
const plain = { manifest: {} } as InstalledPlugin;

beforeEach(() => {
  vi.useFakeTimers();
  checkForUpdates.mockClear();
  mockSettings = {};
  mockPlugins = [updatable];
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("usePluginUpdateSchedule", () => {
  it("never checks while the setting is off (the default)", () => {
    mountHook();
    vi.advanceTimersByTime(PLUGIN_UPDATE_CHECK_INTERVAL_MS * 2);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("never checks when no plugin publishes updates", () => {
    mockSettings = { pluginUpdateCheckEnabled: true };
    mockPlugins = [plain];
    mountHook();
    vi.advanceTimersByTime(PLUGIN_UPDATE_CHECK_INTERVAL_MS * 2);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("checks after the startup delay and then daily, until turned off", () => {
    mockSettings = { pluginUpdateCheckEnabled: true };
    const { rerender } = mountHook();

    vi.advanceTimersByTime(FIRST_PLUGIN_UPDATE_CHECK_DELAY_MS - 1);
    expect(checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PLUGIN_UPDATE_CHECK_INTERVAL_MS);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    mockSettings = { pluginUpdateCheckEnabled: false };
    rerender();
    vi.advanceTimersByTime(PLUGIN_UPDATE_CHECK_INTERVAL_MS * 3);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
