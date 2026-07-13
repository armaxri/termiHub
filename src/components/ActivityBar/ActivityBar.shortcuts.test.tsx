/**
 * The keyboard-shortcuts reference must be discoverable from a visible menu, not
 * only via a shortcut the user has to already know (#1353). These tests pin:
 *
 *  - a "Keyboard Shortcuts" item in the Settings wheel dropdown that opens the
 *    shortcuts overlay, and
 *  - inline accelerators rendered on the Settings-menu rows that have a binding
 *    (Settings, Keyboard Shortcuts), using the same effective binding the
 *    overlay shows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getActionAccelerator } from "@/services/keybindings";
import { withTooltip } from "@/test/tooltip";
import { ActivityBar } from "./ActivityBar";

vi.mock("@/components/OpenConnections/OpenConnectionsModal", () => ({
  OpenConnectionsModal: () => null,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the Settings dropdown via keyboard and wait for the portalled content. */
async function openSettingsMenu(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="activity-bar-settings"]'
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (
    let i = 0;
    i < 20 && !document.querySelector('[data-testid="settings-menu-shortcuts"]');
    i++
  ) {
    await act(async () => {
      await nextFrame();
    });
  }
}

function render(): void {
  act(() => {
    root.render(withTooltip(<ActivityBar />));
  });
}

describe("ActivityBar Settings menu — shortcuts discoverability (#1353)", () => {
  it("offers a Keyboard Shortcuts item that opens the shortcuts overlay", async () => {
    render();
    await openSettingsMenu();

    const item = document.querySelector<HTMLElement>('[data-testid="settings-menu-shortcuts"]');
    expect(item).not.toBeNull();
    expect(useAppStore.getState().shortcutsOverlayOpen).toBe(false);

    await act(async () => {
      item!.click();
    });
    expect(useAppStore.getState().shortcutsOverlayOpen).toBe(true);
  });

  it("renders the show-shortcuts accelerator on the Keyboard Shortcuts row", async () => {
    render();
    await openSettingsMenu();

    const item = document.querySelector<HTMLElement>('[data-testid="settings-menu-shortcuts"]')!;
    const accel = getActionAccelerator("show-shortcuts")!;
    expect(accel).toBeTruthy();
    expect(item.textContent).toContain(accel);
  });

  it("renders the open-settings accelerator on the Settings row", async () => {
    render();
    await openSettingsMenu();

    const item = document.querySelector<HTMLElement>('[data-testid="settings-menu-open"]')!;
    const accel = getActionAccelerator("open-settings")!;
    expect(accel).toBeTruthy();
    expect(item.textContent).toContain(accel);
  });
});
