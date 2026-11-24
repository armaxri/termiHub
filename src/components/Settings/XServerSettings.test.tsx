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
import type { Platform } from "@/utils/platform";
import {
  PROVIDE_X_SERVER_HINTS,
  STOP_X_SERVER_INACTIVE_HINT,
  XServerSettings,
} from "./XServerSettings";
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

function renderWith(
  settings: AppSettings,
  visibleFields?: Set<string>,
  platform: Platform = "windows"
): Mock {
  const onChange = vi.fn();
  act(() => {
    root.render(
      <XServerSettings
        settings={settings}
        onChange={onChange}
        visibleFields={visibleFields}
        platform={platform}
      />
    );
  });
  return onChange;
}

function applied(onChange: Mock, prev: AppSettings): AppSettings {
  const calls = onChange.mock.calls;
  const update = calls[calls.length - 1][0] as SettingsUpdate;
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
    expect(container.textContent).toContain("X server");
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

  describe("dependency on 'Provide X server automatically' (#5844)", () => {
    const PLATFORMS: Platform[] = ["windows", "macos", "linux"];

    it.each(PLATFORMS)("shows only the %s line in the provide hint", (platform) => {
      renderWith(defaultSettings, undefined, platform);
      const hint = query("settings-provide-x-server-hint")!.textContent;
      expect(hint).toBe(PROVIDE_X_SERVER_HINTS[platform]);
      for (const other of PLATFORMS.filter((p) => p !== platform)) {
        expect(container.textContent).not.toContain(PROVIDE_X_SERVER_HINTS[other]);
      }
      expect(container.textContent).not.toContain("macOS/Linux");
    });

    it("nests 'Stop X server when idle' under its parent", () => {
      renderWith(defaultSettings);
      const stop = query("settings-stop-x-server-idle")!;
      expect(stop.closest(".settings-panel__nested")).not.toBeNull();
      expect(query("settings-provide-x-server")!.closest(".settings-panel__nested")).toBeNull();
    });

    it.each([
      // [platform, stored provide value, effective provide]
      ["windows", undefined, true],
      ["macos", undefined, false],
      ["linux", undefined, false],
      ["macos", true, true],
      ["windows", false, false],
    ] as const)(
      "on %s with provide=%s the child is enabled only when provide is effectively %s",
      (platform, stored, effective) => {
        renderWith(
          { ...defaultSettings, provideXServerAutomatically: stored, stopXServerWhenIdle: true },
          undefined,
          platform
        );
        const provide = query("settings-provide-x-server")!;
        const stop = query("settings-stop-x-server-idle")! as HTMLButtonElement;
        expect(provide.getAttribute("aria-checked")).toBe(String(effective));
        expect(stop.disabled).toBe(!effective);
        // Never "on while the parent is off": the child shows its effective state.
        expect(stop.getAttribute("aria-checked")).toBe(String(effective));
        const hint = query("settings-stop-x-server-idle-hint")!.textContent;
        if (effective) expect(hint).not.toBe(STOP_X_SERVER_INACTIVE_HINT);
        else expect(hint).toBe(STOP_X_SERVER_INACTIVE_HINT);
      }
    );

    it("keeps the stored idle value while the parent is off", () => {
      const start = {
        ...defaultSettings,
        provideXServerAutomatically: false,
        stopXServerWhenIdle: true,
      };
      const onChange = renderWith(start, undefined, "macos");
      act(() => query("settings-stop-x-server-idle")!.click());
      expect(onChange).not.toHaveBeenCalled();
      // Turning the parent on brings the stored "on" back.
      act(() => root.unmount());
      root = createRoot(container);
      renderWith({ ...start, provideXServerAutomatically: true }, undefined, "macos");
      expect(query("settings-stop-x-server-idle")!.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("renders nothing when visibleFields excludes both fields", () => {
    renderWith(defaultSettings, new Set(["unrelated"]));
    expect(container.textContent).toBe("");
    expect(query("settings-provide-x-server")).toBeNull();
    expect(query("settings-stop-x-server-idle")).toBeNull();
  });
});
