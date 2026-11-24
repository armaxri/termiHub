import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { KeyboardSettings } from "./KeyboardSettings";
import {
  clearOverrides,
  formatActionBindings,
  getEffectiveCombo,
  isUnboundCombo,
} from "@/services/keybindings";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { currentSettingsView } from "@/store/settingsBridge";

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
const keys = (action: string) => byTestId(`keybinding-keys-${action}`)?.textContent ?? "";
const notice = () => byTestId("keyboard-settings-conflict");
const overrideOf = (action: string) =>
  (currentSettingsView().keybindingOverrides ?? []).find((o) => o.action === action)?.key;

/** Dispatch a keydown on the focused element, the way a real key press arrives. */
function press(key: string, init: KeyboardEventInit = {}) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

/** Let the single-combo chord window elapse so the recording commits. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
  });
}

async function clickChange(action: string) {
  await act(async () => byTestId(`keybinding-change-${action}`)!.click());
}

setupSettingsRegion();

describe("KeyboardSettings editing (#5842)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearOverrides();
    toastInfo.mockClear();
    seedSettings({ editorShortcutDelegation: undefined, keybindingOverrides: undefined });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearOverrides();
    vi.useRealTimers();
  });

  it("shows a visible Change label and a plain Default marker on every unchanged row", async () => {
    await render();
    expect(byTestId("keybinding-change-toggle-sidebar")?.textContent).toBe("Change");
    const marker = byTestId("keybinding-default-toggle-sidebar");
    expect(marker?.textContent).toBe("Default");
    expect(marker?.tagName).toBe("SPAN");
    expect(byTestId("keybinding-reset-toggle-sidebar")).toBeNull();
  });

  it("records a new chord after clicking Change", async () => {
    await render();
    await clickChange("toggle-sidebar");
    expect(keys("toggle-sidebar")).toContain("Press a key combination");
    expect(byTestId("keybinding-cancel-toggle-sidebar")).not.toBeNull();
    press("j", { code: "KeyJ", ctrlKey: true, shiftKey: true });
    await settle();
    expect(overrideOf("toggle-sidebar")).toBe("Ctrl+Shift+J");
    expect(keys("toggle-sidebar")).toBe("Ctrl+Shift+J");
  });

  it("records the physical key for an Option character on a German Mac layout", async () => {
    await render();
    await clickChange("toggle-sidebar");
    // Option+L types "@" on a German Mac; the shortcut is the L key.
    press("@", { code: "KeyL", altKey: true, ctrlKey: true });
    await settle();
    expect(overrideOf("toggle-sidebar")).toBe("Ctrl+Alt+l");
  });

  it("cancels with Escape or the Cancel button and keeps the binding", async () => {
    await render();
    const before = keys("toggle-sidebar");
    await clickChange("toggle-sidebar");
    press("Escape");
    expect(keys("toggle-sidebar")).toBe(before);

    await clickChange("toggle-sidebar");
    await act(async () => byTestId("keybinding-cancel-toggle-sidebar")!.click());
    expect(keys("toggle-sidebar")).toBe(before);
    expect(byTestId("keybinding-cancel-toggle-sidebar")).toBeNull();
    expect(currentSettingsView().keybindingOverrides ?? []).toEqual([]);
  });

  it("explains a conflict under the row and keeps both bindings on Cancel", async () => {
    await render();
    await clickChange("new-terminal");
    press("Tab", { code: "Tab", ctrlKey: true });
    await settle();
    const row = byTestId("keybinding-row-new-terminal")!;
    // The notice sits right under the recorded row.
    expect(row.nextElementSibling?.contains(notice())).toBe(true);
    expect(notice()!.textContent).toContain('already used by "Next tab"');
    expect(byTestId("keybinding-conflict-reassign")?.textContent).toBe("Reassign");

    await act(async () => byTestId("keybinding-conflict-cancel")!.click());
    expect(notice()).toBeNull();
    expect(currentSettingsView().keybindingOverrides ?? []).toEqual([]);
  });

  it("reassigns a taken shortcut, and Undo puts both back", async () => {
    await render();
    const nextTabBefore = formatActionBindings("next-tab");
    await clickChange("new-terminal");
    press("Tab", { code: "Tab", ctrlKey: true });
    await settle();
    await act(async () => byTestId("keybinding-conflict-reassign")!.click());

    expect(overrideOf("new-terminal")).toBe("Ctrl+Tab");
    expect(formatActionBindings("next-tab") ?? "").not.toContain("Ctrl+Tab");
    expect(notice()).toBeNull();
    // Both changed rows now offer a reset.
    expect(byTestId("keybinding-reset-new-terminal")).not.toBeNull();
    expect(byTestId("keybinding-reset-next-tab")).not.toBeNull();

    const [message, opts] = toastInfo.mock.lastCall!;
    expect(message).toBe("Ctrl+Tab moved from Next tab to New terminal");
    expect(opts.testId).toBe("keybinding-reassign-toast");
    await act(async () => opts.action.onClick());
    expect(formatActionBindings("next-tab")).toBe(nextTabBefore);
    expect(overrideOf("new-terminal")).toBeUndefined();
  });

  it("refuses a plain function key for an action that fires in terminals", async () => {
    await render();
    await clickChange("toggle-sidebar");
    press("F5", { code: "F5" });
    await settle();
    expect(notice()!.textContent).toContain("stays with terminal programs");
    expect(notice()!.textContent).toContain("Add Ctrl, Alt or Cmd");
    expect(overrideOf("toggle-sidebar")).toBeUndefined();

    // With a modifier the same key is fine.
    await clickChange("toggle-sidebar");
    press("F5", { code: "F5", ctrlKey: true });
    await settle();
    expect(overrideOf("toggle-sidebar")).toBe("Ctrl+F5");
  });

  it("accepts a plain function key for an action that yields to a focused terminal", async () => {
    await render();
    await clickChange("focus-next-region");
    press("F7", { code: "F7" });
    await settle();
    expect(overrideOf("focus-next-region")).toBe("F7");
  });

  it("refuses a dead key with a clear reason", async () => {
    await render();
    await clickChange("toggle-sidebar");
    press("Dead", { code: "Equal" });
    expect(notice()!.textContent).toContain("starts an accent");
    expect(overrideOf("toggle-sidebar")).toBeUndefined();
    await act(async () => byTestId("keybinding-notice-close")!.click());
    expect(notice()).toBeNull();
  });

  it("offers Reset to default only once changed, and reset restores the default", async () => {
    await render();
    const before = getEffectiveCombo("toggle-sidebar");
    await clickChange("toggle-sidebar");
    press("j", { code: "KeyJ", ctrlKey: true, shiftKey: true });
    await settle();
    const reset = byTestId("keybinding-reset-toggle-sidebar");
    expect(reset?.textContent).toBe("Reset to default");
    expect(byTestId("keybinding-default-toggle-sidebar")).toBeNull();
    await act(async () => reset!.click());
    expect(getEffectiveCombo("toggle-sidebar")).toEqual(before);
    expect(byTestId("keybinding-default-toggle-sidebar")).not.toBeNull();
  });

  it("offers Undo when Backspace clears a binding while recording", async () => {
    await render();
    const before = getEffectiveCombo("toggle-sidebar");
    await clickChange("toggle-sidebar");
    press("Backspace");
    expect(isUnboundCombo(getEffectiveCombo("toggle-sidebar"))).toBe(true);
    const [message, opts] = toastInfo.mock.lastCall!;
    expect(message).toBe("Shortcut for Toggle sidebar cleared");
    await act(async () => opts.action.onClick());
    expect(getEffectiveCombo("toggle-sidebar")).toEqual(before);
  });
});
