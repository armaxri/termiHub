/**
 * SessionSettings (UX-029): the session-lifecycle section (startup restore + Recent
 * Sessions history) split out of the old "General" category. These tests pin the
 * restore-mode dropdown value, the history toggles/limit and their function-updater
 * onChange, the Clear-History button's enabled/disabled gating on the live history
 * count, and `visibleFields` gating. Part of TFE-007 coverage (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import type { SettingsUpdate } from "./GeneralSettings";

// Drive the two store reads (history count + clear action) through a configurable
// mock so the Clear-History gating can be exercised without a real bridge.
let mockHistoryLength = 0;
const clearSessionHistory = vi.fn(() => Promise.resolve());

interface FakeStoreState {
  sessionHistory: unknown[];
  clearSessionHistory: () => Promise<void>;
}

vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: FakeStoreState) => T): T =>
    selector({
      sessionHistory: Array.from({ length: mockHistoryLength }),
      clearSessionHistory,
    }),
}));

// The dropdown resolves its value asynchronously via core::restore_mode; return the
// explicit mode synchronously so the trigger label is deterministic.
vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: (settings: AppSettings) =>
    Promise.resolve(settings.restoreLastSessionMode ?? "ask"),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

import { SessionSettings } from "./SessionSettings";

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
      <SessionSettings settings={settings} onChange={onChange} visibleFields={visibleFields} />
    );
  });
  return onChange;
}

function applied(onChange: Mock, prev: AppSettings): AppSettings {
  const update = onChange.mock.calls.at(-1)![0] as SettingsUpdate;
  return typeof update === "function" ? update(prev) : update;
}

describe("SessionSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockHistoryLength = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the Restore and Session History groups with their controls", () => {
    renderWith(defaultSettings);
    expect(container.textContent).toContain("Restore");
    expect(container.textContent).toContain("Session History");
    expect(query("settings-restore-last-session-mode")).not.toBeNull();
    expect(query("settings-session-history-enabled")).not.toBeNull();
    expect(query("settings-session-history-limit")).not.toBeNull();
    expect(query("settings-show-recent-sessions")).not.toBeNull();
    expect(query("settings-clear-session-history")).not.toBeNull();
  });

  it("shows the label for the explicitly-selected restore mode", () => {
    renderWith({ ...defaultSettings, restoreLastSessionMode: "always" });
    expect(query("settings-restore-last-session-mode")?.textContent).toContain("Always");
  });

  it("defaults the history-enabled toggle on and reflects an explicit off", () => {
    renderWith(defaultSettings);
    expect(query("settings-session-history-enabled")!.getAttribute("aria-checked")).toBe("true");

    act(() => root.unmount());
    root = createRoot(container);
    renderWith({ ...defaultSettings, sessionHistoryEnabled: false });
    expect(query("settings-session-history-enabled")!.getAttribute("aria-checked")).toBe("false");
  });

  it("emits the flipped history-enabled value through the updater", () => {
    const onChange = renderWith(defaultSettings);
    act(() => query("settings-session-history-enabled")!.click());
    expect(applied(onChange, defaultSettings)).toEqual(
      expect.objectContaining({ sessionHistoryEnabled: false })
    );
  });

  it("emits a numeric history limit from the number input", () => {
    const onChange = renderWith(defaultSettings);
    const input = query("settings-session-history-limit") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(input, "200");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(applied(onChange, defaultSettings)).toEqual(
      expect.objectContaining({ sessionHistoryLimit: 200 })
    );
  });

  it("disables Clear History when the history is empty", () => {
    mockHistoryLength = 0;
    renderWith(defaultSettings);
    expect((query("settings-clear-session-history") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Clear History and calls the store action when there is history", () => {
    mockHistoryLength = 3;
    renderWith(defaultSettings);
    const btn = query("settings-clear-session-history") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => btn.click());
    expect(clearSessionHistory).toHaveBeenCalledTimes(1);
  });

  it("hides the Session History group when visibleFields excludes its fields", () => {
    renderWith(defaultSettings, new Set(["restoreLastSessionOnStartup"]));
    expect(query("settings-restore-last-session-mode")).not.toBeNull();
    expect(query("settings-session-history-enabled")).toBeNull();
    expect(query("settings-clear-session-history")).toBeNull();
  });
});
