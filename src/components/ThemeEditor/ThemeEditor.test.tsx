import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThemeEditor } from "./ThemeEditor";
import { createCustomTheme } from "@/themes";
import { darkTheme } from "@/themes/dark";
import type { ThemeDefinition } from "@/themes/types";

// Stub the live-preview side effect; the editor's own logic is what we test.
vi.mock("@/themes", async (orig) => ({
  ...(await orig<typeof import("@/themes")>()),
  previewTheme: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function render(theme: ThemeDefinition, onSave = vi.fn(), onCancel = vi.fn()) {
  act(() => {
    root.render(
      <ThemeEditor open initialTheme={theme} onSave={onSave} onCancel={onCancel} />
    );
  });
  return { onSave, onCancel };
}

/** Query into the Radix portal on document.body. */
function q<T extends Element = HTMLElement>(testid: string): T {
  return document.querySelector(`[data-testid="${testid}"]`) as T;
}

/** Drive a controlled input the way a real keystroke would. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ThemeEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the name field and every color group", () => {
    render(createCustomTheme("dark", "My Theme"));
    expect(q<HTMLInputElement>("theme-editor-name").value).toBe("My Theme");
    // A representative token from the first and last groups is present.
    expect(q("theme-editor-hex-bgPrimary")).toBeTruthy();
    expect(q("theme-editor-hex-scrollbarThumbHover")).toBeTruthy();
  });

  it("disables Save when the name is blank", () => {
    render(createCustomTheme("dark", "X"));
    setValue(q<HTMLInputElement>("theme-editor-name"), "   ");
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the edited colors with a trimmed name", () => {
    const { onSave } = render(createCustomTheme("dark", "Base"));
    setValue(q<HTMLInputElement>("theme-editor-name"), "  Renamed  ");
    setValue(q<HTMLInputElement>("theme-editor-hex-accentColor"), "#ff8800");
    act(() => (q("theme-editor-save") as HTMLButtonElement).click());

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ThemeDefinition;
    expect(saved.name).toBe("Renamed");
    expect(saved.colors.accentColor).toBe("#ff8800");
    expect(saved.baseTheme).toBe("dark");
  });

  it("enables per-token Reset only when overridden and restores the base value", () => {
    render(createCustomTheme("dark", "Reset Me"));
    const resetBtn = () => q("theme-editor-reset-accentColor") as HTMLButtonElement;
    expect(resetBtn().disabled).toBe(true);

    setValue(q<HTMLInputElement>("theme-editor-hex-accentColor"), "#010101");
    expect(resetBtn().disabled).toBe(false);

    act(() => resetBtn().click());
    expect(q<HTMLInputElement>("theme-editor-hex-accentColor").value).toBe(
      darkTheme.colors.accentColor
    );
    expect(resetBtn().disabled).toBe(true);
  });

  it("invokes onCancel from the Cancel button", () => {
    const { onCancel } = render(createCustomTheme("dark", "Cancelable"));
    act(() => (q("theme-editor-cancel") as HTMLButtonElement).click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
