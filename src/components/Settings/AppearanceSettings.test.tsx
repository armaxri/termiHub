import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import type { ThemeDefinition } from "@/themes/types";
import { AppearanceSettings } from "./AppearanceSettings";

const toastSuccess = vi.fn();

// Keep the real theme helpers (createCustomTheme, resolve, encode) but stub the
// applyTheme/previewTheme side effects so the tests don't mutate global CSS.
vi.mock("@/themes", async (orig) => ({
  ...(await orig<typeof import("@/themes")>()),
  applyTheme: vi.fn(),
  previewTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", async (orig) => ({
  ...(await orig<typeof import("@/components/ui")>()),
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), loading: vi.fn() },
}));

/** A minimal but valid custom theme for option/select tests. */
function customTheme(id: string, name: string): ThemeDefinition {
  return { id, name, colorScheme: "dark", baseTheme: "dark", colors: {} as ThemeDefinition["colors"] };
}

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
    root.render(<AppearanceSettings settings={settings} onChange={onChange} />);
  });
  return onChange;
}

/** Drive a controlled input the way a real keystroke would. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fieldInput(label: string): HTMLInputElement {
  const el = Array.from(container.querySelectorAll(".settings-form__label")).find(
    (l) => l.textContent === label
  );
  return el?.closest(".settings-form__field")?.querySelector("input") as HTMLInputElement;
}

describe("AppearanceSettings — numeric fields", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders font size and line height through the shared NumberInput primitive (#1453)", () => {
    renderWith(defaultSettings);
    expect(fieldInput("Font Size").classList.contains("ui-input")).toBe(true);
    expect(fieldInput("Font Size").type).toBe("number");
    expect(fieldInput("Line Height").classList.contains("ui-input")).toBe(true);
    expect(fieldInput("Line Height").type).toBe("number");
  });

  it("shows a blank font size and line height when unset (#1453)", () => {
    renderWith(defaultSettings);
    expect(fieldInput("Font Size").value).toBe("");
    expect(fieldInput("Line Height").value).toBe("");
  });

  it("reflects the configured font size and line height", () => {
    renderWith({ ...defaultSettings, fontSize: 18, lineHeight: 1.4 });
    expect(fieldInput("Font Size").value).toBe("18");
    expect(fieldInput("Line Height").value).toBe("1.4");
  });

  it("editing the font size emits the parsed number (#1453)", () => {
    const onChange = renderWith(defaultSettings);
    setValue(fieldInput("Font Size"), "20");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 20 }));
  });

  it("editing the line height emits the parsed float (#1453)", () => {
    const onChange = renderWith(defaultSettings);
    setValue(fieldInput("Line Height"), "1.2");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lineHeight: 1.2 }));
  });

  it("clearing the font size emits undefined instead of coercing (#1453)", () => {
    const onChange = renderWith({ ...defaultSettings, fontSize: 16 });
    setValue(fieldInput("Font Size"), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: undefined }));
  });

  it("clearing the line height emits undefined instead of coercing (#1453)", () => {
    const onChange = renderWith({ ...defaultSettings, lineHeight: 1.5 });
    setValue(fieldInput("Line Height"), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lineHeight: undefined }));
  });
});

/** Query a testid from the container or any Radix portal on document.body. */
function byId<T extends Element = HTMLElement>(testid: string): T {
  return document.querySelector(`[data-testid="${testid}"]`) as T;
}

describe("AppearanceSettings — custom themes", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    toastSuccess.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("disables Edit and Delete when no custom theme is selected", () => {
    renderWith({ ...defaultSettings, theme: "dark" });
    expect((byId("appearance-theme-edit") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("appearance-theme-delete") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("appearance-theme-new") as HTMLButtonElement).disabled).toBe(false);
  });

  it("enables Edit and Delete when the active theme is a custom one", () => {
    renderWith({
      ...defaultSettings,
      theme: "custom:t1",
      customThemes: [customTheme("t1", "Ocean")],
    });
    expect((byId("appearance-theme-edit") as HTMLButtonElement).disabled).toBe(false);
    expect((byId("appearance-theme-delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the theme editor when New Theme is clicked", () => {
    renderWith(defaultSettings);
    act(() => (byId("appearance-theme-new") as HTMLButtonElement).click());
    expect(byId("theme-editor")).toBeTruthy();
  });

  it("deletes the active custom theme and falls back to dark", () => {
    const onChange = renderWith({
      ...defaultSettings,
      theme: "custom:t1",
      customThemes: [customTheme("t1", "Ocean")],
    });
    act(() => (byId("appearance-theme-delete") as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", customThemes: [] })
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("creates and selects a new custom theme end to end", () => {
    const onChange = renderWith(defaultSettings);
    act(() => (byId("appearance-theme-new") as HTMLButtonElement).click());
    setValue(byId<HTMLInputElement>("theme-editor-name"), "Sunset");
    act(() => (byId("theme-editor-save") as HTMLButtonElement).click());

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as AppSettings;
    expect(next.customThemes).toHaveLength(1);
    expect(next.customThemes![0].name).toBe("Sunset");
    expect(next.theme).toBe(`custom:${next.customThemes![0].id}`);
    expect(toastSuccess).toHaveBeenCalled();
  });
});
