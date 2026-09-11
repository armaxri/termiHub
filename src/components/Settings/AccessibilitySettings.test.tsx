/**
 * A11Y-006: the terminal Screen Reader Mode setting is surfaced under a dedicated,
 * discoverable Accessibility category (rather than buried in Terminal settings).
 * These tests pin that the toggle renders, reflects the value, drives onChange,
 * and that the registry files it under the accessibility category.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { SETTINGS_REGISTRY } from "./settingsRegistry";

let container: HTMLDivElement;
let root: Root;

const defaultSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

function renderWith(settings: AppSettings, onChange = vi.fn()) {
  act(() => {
    root.render(<AccessibilitySettings settings={settings} onChange={onChange} />);
  });
  return onChange;
}

function screenReaderToggle(): HTMLElement | null {
  return container.querySelector('[data-testid="settings-screen-reader-mode"]');
}

describe("AccessibilitySettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("files screenReaderMode under the accessibility category", () => {
    const entry = SETTINGS_REGISTRY.find((s) => s.id === "screenReaderMode");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("accessibility");
  });

  it("renders the screen-reader toggle reflecting the current value", () => {
    renderWith({ ...defaultSettings, screenReaderMode: true });
    const toggle = screenReaderToggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
  });

  it("defaults the toggle off when the setting is unset", () => {
    renderWith(defaultSettings);
    expect(screenReaderToggle()!.getAttribute("aria-checked")).toBe("false");
  });

  it("emits screenReaderMode: true when toggled on", () => {
    const onChange = renderWith(defaultSettings);
    act(() => screenReaderToggle()!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ screenReaderMode: true }));
  });

  it("hides the toggle when visibleFields excludes it", () => {
    act(() => {
      root.render(
        <AccessibilitySettings
          settings={defaultSettings}
          onChange={vi.fn()}
          visibleFields={new Set(["somethingElse"])}
        />
      );
    });
    expect(screenReaderToggle()).toBeNull();
  });
});
