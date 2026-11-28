import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { KeyboardSettings } from "./KeyboardSettings";
import {
  clearOverrides,
  getDefaultBindings,
  getEffectiveCombo,
  isActionCustomized,
  setOverride,
} from "@/services/keybindings";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, info: toastInfo } };
});

vi.mock("@/utils/cheatSheetPdf", () => ({
  exportCheatSheet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <KeyboardSettings />
      </TooltipProvider>
    );
  });
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

setupSettingsRegion();

describe("KeyboardSettings polish (#5561)", () => {
  beforeEach(() => {
    clearOverrides();
    toastInfo.mockClear();
    seedSettings({ editorShortcutDelegation: undefined });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearOverrides();
  });

  it("shows its two toggles as the settings pages' inline rows (#6153)", async () => {
    await render();
    for (const [toggle, label] of [
      ["keyboard-settings-passthrough", "Pass through shell keys when terminal is focused"],
      ["keyboard-settings-editor-delegation", "Let editor tabs handle their own editing shortcuts"],
    ]) {
      const row = byTestId(toggle)?.closest(".settings-form__field");
      expect(row?.classList.contains("settings-form__field--inline"), toggle).toBe(true);
      expect(row?.querySelector(".settings-form__label")?.textContent).toContain(label);
      expect(row?.querySelector(".settings-form__hint")?.textContent).not.toBe("");
      // The toggle sits at the row's end, in its control column.
      expect(
        row?.querySelector(`.settings-form__field-control [data-testid="${toggle}"]`)
      ).not.toBeNull();
    }
    expect(container.querySelector(".keyboard-settings__passthrough")).toBeNull();
  });

  it("shows no reset button on a row that is at its default", async () => {
    await render();
    expect(byTestId("keybinding-row-toggle-sidebar")).not.toBeNull();
    expect(byTestId("keybinding-reset-toggle-sidebar")).toBeNull();
    // No default row in the whole table offers a reset.
    expect(container.querySelector('[data-testid^="keybinding-reset-"]')).toBeNull();
  });

  it("shows the reset button once a binding differs from its default", async () => {
    await render();
    await act(async () => {
      byTestId("keybinding-unbind-toggle-sidebar")!.click();
    });
    expect(byTestId("keybinding-reset-toggle-sidebar")).not.toBeNull();
    await act(async () => {
      byTestId("keybinding-reset-toggle-sidebar")!.click();
    });
    expect(byTestId("keybinding-reset-toggle-sidebar")).toBeNull();
  });

  it("confirms a one-click clear with an undo toast that restores the shortcut", async () => {
    await render();
    const before = getEffectiveCombo("toggle-sidebar");
    await act(async () => {
      byTestId("keybinding-unbind-toggle-sidebar")!.click();
    });
    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [message, opts] = toastInfo.mock.calls[0];
    expect(message).toBe("Shortcut for Toggle sidebar cleared");
    expect(opts.testId).toBe("keybinding-unbind-toast");
    expect(opts.action.label).toBe("Undo");

    await act(async () => {
      opts.action.onClick();
    });
    expect(getEffectiveCombo("toggle-sidebar")).toEqual(before);
    expect(byTestId("keybinding-binding-toggle-sidebar")!.textContent).not.toBe("(unbound)");
  });

  it("names the two shortcut-help rows by what they do", async () => {
    await render();
    const label = (action: string) => byTestId(`keybinding-label-${action}`)?.textContent;
    // R-137 (#5842): the pair says where each one works.
    expect(label("show-shortcuts")).toBe("Show keyboard shortcuts (also from terminal)");
    expect(label("show-shortcuts-outside-terminal")).toBe(
      "Show keyboard shortcuts (not from terminal)"
    );
    expect(byTestId("keybinding-scope-note-show-shortcuts-outside-terminal")).not.toBeNull();
    expect(byTestId("keybinding-scope-note-show-shortcuts")).toBeNull();
  });
});

describe("isActionCustomized", () => {
  afterEach(() => clearOverrides());

  it("is false without an override", () => {
    clearOverrides();
    expect(isActionCustomized("toggle-sidebar")).toBe(false);
  });

  it("is false for an override that equals the platform default", () => {
    const def = getDefaultBindings().find((b) => b.action === "toggle-sidebar")!;
    const combo = getEffectiveCombo("toggle-sidebar") ?? def.winLinuxDefault;
    setOverride("toggle-sidebar", combo);
    expect(isActionCustomized("toggle-sidebar")).toBe(false);
  });

  it("is true for a different combo", () => {
    setOverride("toggle-sidebar", { key: "F9" });
    expect(isActionCustomized("toggle-sidebar")).toBe(true);
  });
});
