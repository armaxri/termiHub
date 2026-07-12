import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { AppearanceSettings } from "./AppearanceSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

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
