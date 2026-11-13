import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { AppSettings } from "@/types/connection";
import type { ThemeDefinition } from "@/themes/types";
import { AppearanceSettings } from "./AppearanceSettings";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), readTextFile: vi.fn() }));

// Keep the real theme helpers (createCustomTheme, resolve, encode, IO) but stub
// the applyTheme/previewTheme side effects so the tests don't mutate global CSS.
vi.mock("@/themes", async (orig) => ({
  ...(await orig<typeof import("@/themes")>()),
  applyTheme: vi.fn(),
  previewTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", async (orig) => ({
  ...(await orig<typeof import("@/components/ui")>()),
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    loading: vi.fn(),
  },
}));

const mockedSave = vi.mocked(save);
const mockedOpen = vi.mocked(open);
const mockedWriteTextFile = vi.mocked(writeTextFile);
const mockedReadTextFile = vi.mocked(readTextFile);

/** Flush pending microtasks so async dialog handlers settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A minimal but valid custom theme for option/select tests. */
function customTheme(id: string, name: string): ThemeDefinition {
  return {
    id,
    name,
    colorScheme: "dark",
    baseTheme: "dark",
    colors: {} as ThemeDefinition["colors"],
  };
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
    expect(fieldInput("Font size").classList.contains("ui-input")).toBe(true);
    expect(fieldInput("Font size").type).toBe("number");
    expect(fieldInput("Line height").classList.contains("ui-input")).toBe(true);
    expect(fieldInput("Line height").type).toBe("number");
  });

  it("shows a blank font size and line height when unset (#1453)", () => {
    renderWith(defaultSettings);
    expect(fieldInput("Font size").value).toBe("");
    expect(fieldInput("Line height").value).toBe("");
  });

  it("shows the effective default font size and line height when unset (#5554)", () => {
    renderWith(defaultSettings);
    expect(fieldInput("Font size").placeholder).toBe("14");
    expect(fieldInput("Line height").placeholder).toBe("1");
    expect(container.querySelector('[data-testid="settings-font-size-default"]')?.textContent).toBe(
      "Default"
    );
    expect(container.querySelector('[data-testid="settings-line-height-default"]')).not.toBeNull();
  });

  it("resets a set font size back to the default (#5554)", () => {
    const onChange = renderWith({ ...defaultSettings, fontSize: 18 });
    expect(container.querySelector('[data-testid="settings-font-size-default"]')).toBeNull();
    const reset = container.querySelector(
      '[data-testid="settings-font-size-reset"]'
    ) as HTMLButtonElement;
    expect(reset.getAttribute("aria-label")).toBe("Reset font size to the default (14)");
    act(() => reset.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: undefined }));
  });

  it("reflects the configured font size and line height", () => {
    renderWith({ ...defaultSettings, fontSize: 18, lineHeight: 1.4 });
    expect(fieldInput("Font size").value).toBe("18");
    expect(fieldInput("Line height").value).toBe("1.4");
  });

  it("editing the font size emits the parsed number (#1453)", () => {
    const onChange = renderWith(defaultSettings);
    setValue(fieldInput("Font size"), "20");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 20 }));
  });

  it("editing the line height emits the parsed float (#1453)", () => {
    const onChange = renderWith(defaultSettings);
    setValue(fieldInput("Line height"), "1.2");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lineHeight: 1.2 }));
  });

  it("clearing the font size emits undefined instead of coercing (#1453)", () => {
    const onChange = renderWith({ ...defaultSettings, fontSize: 16 });
    setValue(fieldInput("Font size"), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: undefined }));
  });

  it("clearing the line height emits undefined instead of coercing (#1453)", () => {
    const onChange = renderWith({ ...defaultSettings, lineHeight: 1.5 });
    setValue(fieldInput("Line height"), "");
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

  it("hides Edit, Export and Delete when no custom theme is selected (#5561)", () => {
    renderWith({ ...defaultSettings, theme: "dark" });
    expect(byId("appearance-theme-custom-actions")).toBeNull();
    expect(byId("appearance-theme-edit")).toBeNull();
    expect(byId("appearance-theme-export")).toBeNull();
    expect(byId("appearance-theme-delete")).toBeNull();
    expect((byId("appearance-theme-new") as HTMLButtonElement).disabled).toBe(false);
    expect((byId("appearance-theme-import") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows enabled Edit, Export and Delete for a custom theme", () => {
    renderWith({
      ...defaultSettings,
      theme: "custom:t1",
      customThemes: [customTheme("t1", "Ocean")],
    });
    expect(byId("appearance-theme-custom-actions")?.getAttribute("aria-label")).toBe(
      "Custom theme Ocean"
    );
    expect((byId("appearance-theme-edit") as HTMLButtonElement).disabled).toBe(false);
    expect((byId("appearance-theme-export") as HTMLButtonElement).disabled).toBe(false);
    expect((byId("appearance-theme-delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the theme editor when New theme is clicked", () => {
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
    // The delete confirms first (#5158).
    act(() => (byId("confirm-delete-confirm") as HTMLButtonElement).click());
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

describe("AppearanceSettings — theme import/export (#1880)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    toastSuccess.mockReset();
    toastError.mockReset();
    mockedSave.mockReset();
    mockedOpen.mockReset();
    mockedWriteTextFile.mockReset();
    mockedReadTextFile.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const withOcean: AppSettings = {
    ...defaultSettings,
    theme: "custom:t1",
    customThemes: [customTheme("t1", "Ocean")],
  };

  it("shows Export only once a custom theme is selected", () => {
    renderWith({ ...defaultSettings, theme: "dark" });
    expect(byId("appearance-theme-export")).toBeNull();
    // Import is always available.
    expect((byId("appearance-theme-import") as HTMLButtonElement).disabled).toBe(false);

    act(() => root.render(<AppearanceSettings settings={withOcean} onChange={vi.fn()} />));
    expect((byId("appearance-theme-export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("serializes the selected theme and writes it to the chosen file", async () => {
    mockedSave.mockResolvedValue("/tmp/ocean.json");
    mockedWriteTextFile.mockResolvedValue(undefined);
    renderWith(withOcean);

    act(() => (byId("appearance-theme-export") as HTMLButtonElement).click());
    await flush();

    expect(mockedWriteTextFile).toHaveBeenCalledTimes(1);
    const [path, contents] = mockedWriteTextFile.mock.calls[0] as [string, string];
    expect(path).toBe("/tmp/ocean.json");
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    expect(parsed.$schema).toBe("termihub-theme-v1");
    expect(parsed.name).toBe("Ocean");
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("does nothing when the export dialog is cancelled", async () => {
    mockedSave.mockResolvedValue(null);
    renderWith(withOcean);

    act(() => (byId("appearance-theme-export") as HTMLButtonElement).click());
    await flush();

    expect(mockedWriteTextFile).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("validates a file, adds and selects it, and de-dupes a colliding name", async () => {
    mockedOpen.mockResolvedValue("/tmp/import.json");
    mockedReadTextFile.mockResolvedValue(
      JSON.stringify({ name: "Ocean", baseTheme: "dark", colors: { bgPrimary: "#010203" } })
    );
    const onChange = renderWith(withOcean);

    act(() => (byId("appearance-theme-import") as HTMLButtonElement).click());
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as AppSettings;
    expect(next.customThemes).toHaveLength(2);
    const imported = next.customThemes![1];
    expect(imported.name).toBe("Ocean (2)"); // de-duped against the existing "Ocean"
    expect(imported.colors.bgPrimary).toBe("#010203");
    expect(next.theme).toBe(`custom:${imported.id}`);
    expect(toastSuccess).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a recoverable error toast for a malformed file", async () => {
    mockedOpen.mockResolvedValue("/tmp/bad.json");
    mockedReadTextFile.mockResolvedValue("this is not json {");
    const onChange = renderWith(withOcean);

    act(() => (byId("appearance-theme-import") as HTMLButtonElement).click());
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toMatch(/Invalid theme file/);
  });

  it("does nothing when the import dialog is cancelled", async () => {
    mockedOpen.mockResolvedValue(null);
    const onChange = renderWith(withOcean);

    act(() => (byId("appearance-theme-import") as HTMLButtonElement).click());
    await flush();

    expect(mockedReadTextFile).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("AppearanceSettings — font family (#5561)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("stays empty at the default, with a short placeholder and a Default marker", () => {
    renderWith(defaultSettings);
    const input = fieldInput("Font family");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Default font chain");
    expect(byId("settings-font-family-default")?.textContent).toBe("Default");
    expect(byId("settings-font-family-reset")).toBeNull();
    // The full chain is readable in the hint instead of crammed into the input.
    const hint = input.closest(".settings-form__field")?.textContent ?? "";
    expect(hint).toContain("MesloLGS Nerd Font Mono");
    expect(hint).not.toContain("'");
  });

  it("stores a typed value and clears it back to the default with Reset", () => {
    const onChange = renderWith(defaultSettings);
    setValue(fieldInput("Font family"), "JetBrains Mono");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fontFamily: "JetBrains Mono" })
    );

    renderWith({ ...defaultSettings, fontFamily: "JetBrains Mono" }, onChange);
    expect(fieldInput("Font family").value).toBe("JetBrains Mono");
    expect(byId("settings-font-family-default")).toBeNull();
    act(() => byId("settings-font-family-reset")!.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: undefined }));
  });

  it("treats clearing the input as returning to the default", () => {
    const onChange = renderWith({ ...defaultSettings, fontFamily: "Hack" });
    setValue(fieldInput("Font family"), "");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: undefined }));
  });
});
