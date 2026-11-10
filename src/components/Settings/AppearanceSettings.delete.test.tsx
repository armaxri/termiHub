/**
 * Custom-theme delete: confirm first (with the "don't ask again" opt-out), then
 * a 10 s Undo toast that restores the theme (#5158).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import type { ThemeDefinition } from "@/themes/types";
import type { ToastOptions } from "@/components/ui";
import { __emitSettingsViewForTest, stopSettingsSubscription } from "@/store/settingsBridge";
import { UNDO_WINDOW_MS } from "@/utils/undoableDelete";
import { AppearanceSettings } from "./AppearanceSettings";

const toastSuccess = vi.fn((_message: string, _opts?: ToastOptions) => "toast-id");
const mockRestoreTheme = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), readTextFile: vi.fn() }));
vi.mock("@/themes", async (orig) => ({
  ...(await orig<typeof import("@/themes")>()),
  applyTheme: vi.fn(),
  previewTheme: vi.fn(),
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
vi.mock("./restoreTheme", () => ({
  restoreTheme: (...args: unknown[]) => mockRestoreTheme(...args),
}));

function customTheme(id: string, name: string): ThemeDefinition {
  return {
    id,
    name,
    colorScheme: "dark",
    baseTheme: "dark",
    colors: {} as ThemeDefinition["colors"],
  };
}

const ocean = customTheme("t1", "Ocean");
const settings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  theme: "custom:t1",
  customThemes: [customTheme("t0", "Forest"), ocean],
};

let container: HTMLDivElement;
let root: Root;

function render(onChange = vi.fn()) {
  act(() => root.render(<AppearanceSettings settings={settings} onChange={onChange} />));
  return onChange;
}

function click(testId: string) {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el).not.toBeNull();
  act(() => el!.click());
}

const dialog = () => document.querySelector('[data-testid="confirm-delete-dialog"]');

describe("AppearanceSettings — custom theme delete (#5158)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSettingsSubscription();
  });

  it("asks for confirmation before deleting", () => {
    const onChange = render();
    click("appearance-theme-delete");
    expect(dialog()?.textContent).toContain("Ocean");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the theme when the confirm is cancelled", () => {
    const onChange = render();
    click("appearance-theme-delete");
    click("confirm-delete-cancel");
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes on confirm and offers a 10 s Undo that restores the theme", () => {
    const onChange = render();
    click("appearance-theme-delete");
    click("confirm-delete-confirm");

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", customThemes: [settings.customThemes![0]] })
    );
    expect(onChange.mock.calls[0][0]).not.toHaveProperty("confirmUndoableDelete");
    const [message, opts] = toastSuccess.mock.calls[0];
    expect(message).toContain("Ocean");
    expect(opts?.duration).toBe(UNDO_WINDOW_MS);
    expect(opts?.action?.label).toBe("Undo");

    opts!.action!.onClick();
    expect(mockRestoreTheme).toHaveBeenCalledWith(ocean, 1, "custom:t1", "dark");
    // A second press does nothing.
    opts!.action!.onClick();
    expect(mockRestoreTheme).toHaveBeenCalledTimes(1);
  });

  it("saves the opt-out together with the delete when the box is ticked", () => {
    const onChange = render();
    click("appearance-theme-delete");
    click("confirm-delete-dont-ask-again");
    click("confirm-delete-confirm");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        customThemes: [settings.customThemes![0]],
        confirmUndoableDelete: false,
      })
    );
  });

  it("deletes without asking once opted out, still offering Undo", () => {
    act(() => __emitSettingsViewForTest({ ...settings, confirmUndoableDelete: false }, 1));
    const onChange = render();
    click("appearance-theme-delete");
    expect(dialog()).toBeNull();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(toastSuccess.mock.calls[0][1]?.action?.label).toBe("Undo");
  });
});
