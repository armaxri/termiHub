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

  it("disables Export with no custom theme selected, enables it for one", () => {
    renderWith({ ...defaultSettings, theme: "dark" });
    expect((byId("appearance-theme-export") as HTMLButtonElement).disabled).toBe(true);
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
