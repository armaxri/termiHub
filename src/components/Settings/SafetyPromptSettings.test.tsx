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
  const calls = onChange.mock.calls;
  const update = calls[calls.length - 1][0] as SettingsUpdate;
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

  it("renders the sub-headers, the close choice and the five guard toggles by default", () => {
    renderWith(defaultSettings);
    expect(container.textContent).toContain("Close confirmations");
    expect(container.textContent).toContain("Delete confirmations");
    expect(container.textContent).toContain("Network operation warnings");
    for (const id of [
      "settings-close-live-session-confirm",
      "settings-confirm-close-attached-tab",
      "settings-confirm-undoable-delete",
      "settings-warn-large-port-scan",
      "settings-warn-large-ping-sweep",
    ]) {
      expect(query(id)).not.toBeNull();
    }
  });

  it("defaults each toggle to on when the setting is unset", () => {
    renderWith(defaultSettings);
    expect(query("settings-confirm-close-attached-tab")!.getAttribute("aria-checked")).toBe("true");
    expect(query("settings-warn-large-port-scan")!.getAttribute("aria-checked")).toBe("true");
  });

  describe("one live-session close choice (#5844)", () => {
    const trigger = () => query("settings-close-live-session-confirm")!;

    it("replaces the two overlapping close toggles", () => {
      renderWith(defaultSettings);
      expect(query("settings-confirm-close-tab-on-shortcut")).toBeNull();
      expect(query("settings-confirm-close-live-session")).toBeNull();
      expect(container.textContent).toContain("Ask before closing a live session");
    });

    it("shows Always and the plain Default tag when unset", () => {
      renderWith(defaultSettings);
      expect(trigger().textContent).toContain("Always");
      expect(query("settings-close-live-session-confirm-default")).not.toBeNull();
      expect(query("settings-close-live-session-confirm-reset")).toBeNull();
    });

    it.each([
      ["shortcut", "Only for keyboard shortcuts"],
      ["pointer", "Only for mouse closes"],
      ["never", "Never"],
    ] as const)("reflects a stored %s choice", (value, label) => {
      renderWith({ ...defaultSettings, closeLiveSessionConfirm: value });
      expect(trigger().textContent).toContain(label);
    });

    it("lists every choice when opened", () => {
      renderWith(defaultSettings);
      act(() => {
        trigger().focus();
        trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
        (o) => o.textContent
      );
      expect(labels).toEqual([
        "Always",
        "Only for keyboard shortcuts",
        "Only for mouse closes",
        "Never",
      ]);
    });

    it("resets an overridden choice to the default", () => {
      const start = { ...defaultSettings, closeLiveSessionConfirm: "never" as const };
      const onChange = renderWith(start);
      act(() => query("settings-close-live-session-confirm-reset")!.click());
      expect(applied(onChange, start).closeLiveSessionConfirm).toBeUndefined();
    });

    it("falls back to Always for an unknown stored value", () => {
      renderWith({
        ...defaultSettings,
        closeLiveSessionConfirm: "sometimes" as unknown as "always",
      });
      expect(trigger().textContent).toContain("Always");
    });
  });

  it("turns the undoable-delete confirmation back on (#5158)", () => {
    const start = { ...defaultSettings, confirmUndoableDelete: false };
    const onChange = renderWith(start);
    expect(query("settings-confirm-undoable-delete")!.getAttribute("aria-checked")).toBe("false");
    act(() => query("settings-confirm-undoable-delete")!.click());
    expect(applied(onChange, start)).toEqual(
      expect.objectContaining({ confirmUndoableDelete: true })
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
    expect(query("settings-close-live-session-confirm")).toBeNull();
    // The network-warnings group survives because one of its fields is visible.
    expect(container.textContent).toContain("Network operation warnings");
    expect(query("settings-warn-large-port-scan")).not.toBeNull();
    expect(query("settings-warn-large-ping-sweep")).toBeNull();
  });
});
