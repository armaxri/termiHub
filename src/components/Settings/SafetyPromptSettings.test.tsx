/**
 * SafetyPromptSettings (UX-029/UX-030): the confirmation/warning prompts split out
 * of the old "General" category. These tests pin that each guard toggle renders,
 * reflects its (default-on) value, drives the function-updater onChange with the
 * flipped value, groups under the right sub-headers, and honors `visibleFields`.
 * Part of TFE-007 zero-test component coverage (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { SafetyPromptSettings } from "./SafetyPromptSettings";
import type { SettingsUpdate } from "./GeneralSettings";

let container: HTMLDivElement;
let root: Root;

const defaultSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function renderWith(settings: AppSettings, visibleFields?: Set<string>): Mock {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <SafetyPromptSettings settings={settings} onChange={onChange} visibleFields={visibleFields} />
    );
  });
  return onChange;
}

/** Resolve the last onChange arg (a function updater in this panel) against `prev`. */
function applied(onChange: Mock, prev: AppSettings): AppSettings {
  const update = onChange.mock.calls.at(-1)![0] as SettingsUpdate;
  return typeof update === "function" ? update(prev) : update;
}

describe("SafetyPromptSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders both sub-headers and all five guard toggles by default", () => {
    renderWith(defaultSettings);
    expect(container.textContent).toContain("Close confirmations");
    expect(container.textContent).toContain("Network operation warnings");
    for (const id of [
      "settings-confirm-close-tab-on-shortcut",
      "settings-confirm-close-live-session",
      "settings-confirm-close-attached-tab",
      "settings-warn-large-port-scan",
      "settings-warn-large-ping-sweep",
    ]) {
      expect(query(id)).not.toBeNull();
    }
  });

  it("defaults each toggle to on when the setting is unset", () => {
    renderWith(defaultSettings);
    expect(query("settings-confirm-close-live-session")!.getAttribute("aria-checked")).toBe("true");
    expect(query("settings-warn-large-port-scan")!.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects an explicitly-disabled setting", () => {
    renderWith({ ...defaultSettings, confirmCloseLiveSession: false });
    expect(query("settings-confirm-close-live-session")!.getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("emits the flipped value through the function updater when toggled off", () => {
    const onChange = renderWith(defaultSettings);
    act(() => query("settings-confirm-close-live-session")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(applied(onChange, defaultSettings)).toEqual(
      expect.objectContaining({ confirmCloseLiveSession: false })
    );
  });

  it("emits true when a disabled warning is toggled back on", () => {
    const start = { ...defaultSettings, warnLargePortScan: false };
    const onChange = renderWith(start);
    act(() => query("settings-warn-large-port-scan")!.click());
    expect(applied(onChange, start)).toEqual(expect.objectContaining({ warnLargePortScan: true }));
  });

  it("hides the Close-confirmations group when visibleFields excludes all its fields", () => {
    renderWith(defaultSettings, new Set(["warnLargePortScan"]));
    expect(container.textContent).not.toContain("Close confirmations");
    expect(query("settings-confirm-close-tab-on-shortcut")).toBeNull();
    // The network-warnings group survives because one of its fields is visible.
    expect(container.textContent).toContain("Network operation warnings");
    expect(query("settings-warn-large-port-scan")).not.toBeNull();
    expect(query("settings-warn-large-ping-sweep")).toBeNull();
  });
});
