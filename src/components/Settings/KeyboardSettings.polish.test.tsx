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

const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, success: toastSuccess } };
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
    toastSuccess.mockClear();
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
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const [message, opts] = toastSuccess.mock.calls[0];
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
    const label = (action: string) =>
      byTestId(`keybinding-row-${action}`)?.querySelector("td")?.textContent;
    expect(label("show-shortcuts")).toBe("Show keyboard shortcuts");
    expect(label("show-shortcuts-outside-terminal")).toBe(
      "Show keyboard shortcuts outside terminals"
    );
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
