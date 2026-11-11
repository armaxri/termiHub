/**
 * "Reset to Safer Defaults" and the JSON import replace every custom binding:
 * both confirm first with a summary of what changes, and offer a 10 s Undo that
 * restores the previous bindings exactly (#5375).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import type { ToastOptions } from "@/components/ui";
import type { KeybindingOverrideEntry } from "@/types/keybindings";
import { clearOverrides, getOverrides, setOverrides } from "@/services/keybindings";
import { serializeKeybindings } from "@/services/keybindingIo";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { currentSettingsView } from "@/store/settingsBridge";
import { UNDO_WINDOW_MS } from "@/utils/undoableDelete";
import { KeyboardSettings } from "./KeyboardSettings";

const toastSuccess = vi.fn((_message: string, _opts?: ToastOptions) => "toast-id");
const { openDialog, readTextFile } = vi.hoisted(() => ({
  openDialog: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: openDialog }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), readTextFile }));
vi.mock("@/utils/cheatSheetPdf", () => ({ exportCheatSheet: vi.fn() }));
vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));
vi.mock("@/components/ui", async (orig) => ({
  ...(await orig<typeof import("@/components/ui")>()),
  toast: {
    success: (message: string, opts?: ToastOptions) => toastSuccess(message, opts),
    error: vi.fn(),
    loading: vi.fn(),
  },
}));

/** The user's custom bindings before each test: three overrides, one unbound. */
const CUSTOM: KeybindingOverrideEntry[] = [
  { action: "toggle-sidebar", key: "Ctrl+Shift+Y" },
  { action: "new-terminal", key: "Ctrl+k Ctrl+j" },
  { action: "open-settings", key: "" },
];

let container: HTMLDivElement;
let root: Root;

async function renderComponent() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <KeyboardSettings />
      </TooltipProvider>
    );
  });
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(id: string) {
  const el = byTestId(id);
  expect(el, `${id} should be rendered`).not.toBeNull();
  await act(async () => {
    el!.click();
    await Promise.resolve();
  });
}

/** Run the Undo action of the last success toast. */
async function undoLastToast() {
  const opts = toastSuccess.mock.calls.at(-1)?.[1];
  expect(opts?.action?.label).toBe("Undo");
  await act(async () => {
    opts!.action!.onClick();
    await Promise.resolve();
  });
}

const persisted = () => currentSettingsView().keybindingOverrides ?? [];

setupSettingsRegion();

describe("KeyboardSettings — confirmed reset / import with undo (#5375)", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    openDialog.mockReset();
    readTextFile.mockReset();
    setOverrides(CUSTOM);
    seedSettings({ keybindingOverrides: CUSTOM });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearOverrides();
  });

  describe("Reset to Safer Defaults", () => {
    it("asks first with a summary, and resets on confirm", async () => {
      await renderComponent();
      await click("keyboard-settings-reset-all");

      // Nothing changes until the user confirms.
      expect(getOverrides()).toEqual(CUSTOM);
      expect(byTestId("confirm-keybinding-replace-dialog")?.textContent).toContain(
        "3 custom bindings will be replaced with the built-in defaults."
      );

      await click("confirm-keybinding-replace-confirm");

      expect(getOverrides()).toEqual([]);
      expect(persisted()).toEqual([]);
      expect(toastSuccess).toHaveBeenCalledWith(
        "Keyboard shortcuts reset to safer defaults",
        expect.objectContaining({ duration: UNDO_WINDOW_MS, testId: "keybinding-undo-toast" })
      );
    });

    it("cancel leaves every custom binding in place", async () => {
      await renderComponent();
      await click("keyboard-settings-reset-all");
      await click("confirm-keybinding-replace-cancel");

      expect(getOverrides()).toEqual(CUSTOM);
      expect(persisted()).toEqual(CUSTOM);
      expect(byTestId("confirm-keybinding-replace-dialog")).toBeNull();
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("Undo restores exactly the previous bindings", async () => {
      await renderComponent();
      await click("keyboard-settings-reset-all");
      await click("confirm-keybinding-replace-confirm");
      await undoLastToast();

      expect(getOverrides()).toEqual(CUSTOM);
      expect(persisted()).toEqual(CUSTOM);
      expect(byTestId("keybinding-unbind-open-settings")).toBeNull(); // still unbound
    });

    it("resets at once when there are no custom bindings to lose", async () => {
      clearOverrides();
      seedSettings({ keybindingOverrides: undefined });
      await renderComponent();
      await click("keyboard-settings-reset-all");

      expect(byTestId("confirm-keybinding-replace-dialog")).toBeNull();
      expect(getOverrides()).toEqual([]);
    });
  });

  describe("JSON import", () => {
    const IMPORTED: KeybindingOverrideEntry[] = [{ action: "toggle-sidebar", key: "Alt+B" }];

    async function startImport() {
      openDialog.mockResolvedValue("/tmp/shortcuts.json");
      readTextFile.mockResolvedValue(serializeKeybindings(IMPORTED));
      await renderComponent();
      await click("keyboard-settings-import-json");
      await act(async () => {
        await Promise.resolve();
      });
    }

    it("asks first with a summary, and imports on confirm", async () => {
      await startImport();

      expect(getOverrides()).toEqual(CUSTOM);
      expect(byTestId("confirm-keybinding-replace-dialog")?.textContent).toContain(
        "3 custom bindings will be replaced with the 1 keyboard shortcut from this file."
      );

      await click("confirm-keybinding-replace-confirm");

      expect(getOverrides()).toEqual(IMPORTED);
      expect(persisted()).toEqual(IMPORTED);
      expect(toastSuccess).toHaveBeenCalledWith(
        "Imported 1 keyboard shortcut",
        expect.objectContaining({ testId: "keybinding-undo-toast" })
      );
    });

    it("cancel leaves every custom binding in place", async () => {
      await startImport();
      await click("confirm-keybinding-replace-cancel");

      expect(getOverrides()).toEqual(CUSTOM);
      expect(persisted()).toEqual(CUSTOM);
    });

    it("Undo restores exactly the previous bindings", async () => {
      await startImport();
      await click("confirm-keybinding-replace-confirm");
      await undoLastToast();

      expect(getOverrides()).toEqual(CUSTOM);
      expect(persisted()).toEqual(CUSTOM);
    });
  });
});
