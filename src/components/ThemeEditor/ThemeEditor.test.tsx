import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThemeEditor } from "./ThemeEditor";
import { createCustomTheme, previewTheme } from "@/themes";
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
    root.render(<ThemeEditor open initialTheme={theme} onSave={onSave} onCancel={onCancel} />);
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

  it("populates the base-theme select from the initial theme", () => {
    render(createCustomTheme("light", "Light Based"));
    expect(q("theme-editor-base").getAttribute("data-value")).toBe("light");
  });

  it("keeps Save enabled for a valid theme", () => {
    render(createCustomTheme("dark", "Valid"));
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Save when the name is blank", () => {
    render(createCustomTheme("dark", "X"));
    setValue(q<HTMLInputElement>("theme-editor-name"), "   ");
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-enables Save once a required name is restored", () => {
    render(createCustomTheme("dark", "Recover"));
    setValue(q<HTMLInputElement>("theme-editor-name"), "");
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(true);
    setValue(q<HTMLInputElement>("theme-editor-name"), "Named Again");
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(false);
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

  describe("live preview effect (#4370)", () => {
    it("previews the draft again when a colour or the name changes", () => {
      render(createCustomTheme("dark", "Base"));
      vi.mocked(previewTheme).mockClear();

      setValue(q<HTMLInputElement>("theme-editor-hex-accentColor"), "#ff8800");
      expect(previewTheme).toHaveBeenCalledTimes(1);
      expect(vi.mocked(previewTheme).mock.calls[0][0].colors.accentColor).toBe("#ff8800");

      setValue(q<HTMLInputElement>("theme-editor-name"), "Renamed");
      expect(previewTheme).toHaveBeenCalledTimes(2);
      expect(vi.mocked(previewTheme).mock.calls[1][0].name).toBe("Renamed");
    });

    it("does not preview again on a parent re-render with the same theme", () => {
      const theme = createCustomTheme("dark", "Base");
      const onSave = vi.fn();
      const onCancel = vi.fn();
      render(theme, onSave, onCancel);
      vi.mocked(previewTheme).mockClear();

      render(theme, vi.fn(), vi.fn());
      render(theme, onSave, onCancel);

      expect(previewTheme).not.toHaveBeenCalled();
    });
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

  it("shows 'Name is required.' on the Name field while it is blank (UISF2-003)", () => {
    render(createCustomTheme("dark", "Named"));
    const nameError = () => document.getElementById("theme-editor-name-error");
    expect(nameError()).toBeNull();

    setValue(q<HTMLInputElement>("theme-editor-name"), "  ");
    expect(nameError()?.textContent).toBe("Name is required.");
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(true);

    setValue(q<HTMLInputElement>("theme-editor-name"), "Named");
    expect(nameError()).toBeNull();
    expect((q("theme-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });
});
