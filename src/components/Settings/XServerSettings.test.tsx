/**
 * XServerSettings (UX-029): the managed local X-server section split out of the old
 * "General" category. These tests pin that both toggles render, reflect their
 * values, drive the function-updater onChange, and that `visibleFields` can hide
 * either toggle or the whole section. Part of TFE-007 coverage (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { XServerSettings } from "./XServerSettings";
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
      <XServerSettings settings={settings} onChange={onChange} visibleFields={visibleFields} />
    );
  });
  return onChange;
}

function applied(onChange: Mock, prev: AppSettings): AppSettings {
  const update = onChange.mock.calls.at(-1)![0] as SettingsUpdate;
  return typeof update === "function" ? update(prev) : update;
}

describe("XServerSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the X Server section title and both toggles", () => {
    renderWith(defaultSettings);
    expect(container.textContent).toContain("X Server");
    expect(query("settings-provide-x-server")).not.toBeNull();
    expect(query("settings-stop-x-server-idle")).not.toBeNull();
  });

  it("reflects explicit toggle values", () => {
    renderWith({
      ...defaultSettings,
      provideXServerAutomatically: true,
      stopXServerWhenIdle: false,
    });
    expect(query("settings-provide-x-server")!.getAttribute("aria-checked")).toBe("true");
    expect(query("settings-stop-x-server-idle")!.getAttribute("aria-checked")).toBe("false");
  });

  it("defaults stop-when-idle to on when unset", () => {
    renderWith(defaultSettings);
    expect(query("settings-stop-x-server-idle")!.getAttribute("aria-checked")).toBe("true");
  });

  it("emits the flipped provide-automatically value through the updater", () => {
    const start = { ...defaultSettings, provideXServerAutomatically: true };
    const onChange = renderWith(start);
    act(() => query("settings-provide-x-server")!.click());
    expect(applied(onChange, start)).toEqual(
      expect.objectContaining({ provideXServerAutomatically: false })
    );
  });

  it("hides a single toggle when visibleFields excludes it", () => {
    renderWith(defaultSettings, new Set(["provideXServerAutomatically"]));
    expect(query("settings-provide-x-server")).not.toBeNull();
    expect(query("settings-stop-x-server-idle")).toBeNull();
  });

  it("renders nothing when visibleFields excludes both fields", () => {
    renderWith(defaultSettings, new Set(["unrelated"]));
    expect(container.textContent).toBe("");
    expect(query("settings-provide-x-server")).toBeNull();
    expect(query("settings-stop-x-server-idle")).toBeNull();
  });
});
