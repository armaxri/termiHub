import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { KeyboardSettings } from "./KeyboardSettings";
import {
  RELEASE_CHORD_ACTION,
  clearOverrides,
  getReleaseChord,
  setOverrides,
} from "@/services/keybindings";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { currentSettingsView } from "@/store/settingsBridge";

vi.mock("@/utils/cheatSheetPdf", () => ({
  exportCheatSheet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

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

function bindingButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `[data-testid="keybinding-binding-${RELEASE_CHORD_ACTION}"]`
  );
  if (!el) throw new Error("release chord binding control not found");
  return el;
}

function conflictText(): string {
  return container.querySelector('[data-testid="keyboard-settings-conflict"]')?.textContent ?? "";
}

function announcement(): string {
  return (
    container.querySelector('[data-testid="keyboard-settings-announcement"]')?.textContent ?? ""
  );
}

function releaseOverride(): string | undefined {
  return (currentSettingsView().keybindingOverrides ?? []).find(
    (o) => o.action === RELEASE_CHORD_ACTION
  )?.key;
}

type Mods = Pick<KeyboardEventInit, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** Dispatch a key event on window, the way the recorder listens for it. */
function key(type: "keydown" | "keyup", keyName: string, mods: Mods = {}): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true, ...mods });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function startRecording() {
  act(() => bindingButton().click());
}

setupSettingsRegion();

describe("KeyboardSettings — remote-desktop release chord (#4524)", () => {
  beforeEach(() => {
    clearOverrides();
    seedSettings({ keybindingOverrides: undefined });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearOverrides();
  });

  it("lists the release chord with its default in a Remote Desktop group", async () => {
    await renderComponent();
    expect(container.textContent).toContain("Remote Desktop");
    expect(container.textContent).toContain("Release Remote Desktop Keyboard");
    expect(bindingButton().textContent).toBe("Ctrl+Shift+Alt");
  });

  it("offers no Clear button, so the escape chord can never be unbound", async () => {
    await renderComponent();
    expect(
      container.querySelector(`[data-testid="keybinding-unbind-${RELEASE_CHORD_ACTION}"]`)
    ).toBeNull();
  });

  it("announces modifier-only recording instructions", async () => {
    await renderComponent();
    startRecording();
    expect(announcement()).toContain("Hold at least two modifier keys");
    expect(bindingButton().textContent).toContain("Hold 2+ modifier keys");
  });

  it("records a modifier-only combo and persists it", async () => {
    await renderComponent();
    startRecording();
    key("keydown", "Control", { ctrlKey: true });
    key("keydown", "Alt", { ctrlKey: true, altKey: true });
    expect(bindingButton().textContent).toContain("Ctrl+Alt");
    await act(async () => {
      key("keyup", "Alt", { ctrlKey: true });
      await Promise.resolve();
    });

    expect(releaseOverride()).toBe("Ctrl+Alt");
    expect(getReleaseChord()).toEqual({ key: "", ctrl: true, alt: true });
    expect(bindingButton().textContent).toBe("Ctrl+Alt");
    expect(announcement()).toBe("Release Remote Desktop Keyboard shortcut set to Ctrl+Alt.");
  });

  it("rejects a single modifier and keeps the default chord", async () => {
    await renderComponent();
    startRecording();
    key("keydown", "Shift", { shiftKey: true });
    key("keyup", "Shift");

    expect(conflictText()).toContain("at least 2 modifier keys");
    expect(conflictText()).toContain("shortcut unchanged");
    expect(releaseOverride()).toBeUndefined();
    expect(getReleaseChord()).toEqual({ key: "", ctrl: true, alt: true, shift: true });
  });

  it("rejects a combo that includes a non-modifier key", async () => {
    await renderComponent();
    startRecording();
    key("keydown", "Control", { ctrlKey: true });
    key("keydown", "x", { ctrlKey: true });

    expect(conflictText()).toContain("modifier keys only");
    expect(releaseOverride()).toBeUndefined();
  });

  it("refuses to clear the chord with Backspace", async () => {
    await renderComponent();
    startRecording();
    key("keydown", "Backspace");

    expect(conflictText()).toContain("cannot be cleared");
    expect(releaseOverride()).toBeUndefined();
    expect(bindingButton().textContent).toBe("Ctrl+Shift+Alt");
  });

  it("cancels with Escape and leaves a bare Tab uncaptured (no keyboard trap)", async () => {
    await renderComponent();
    startRecording();
    key("keydown", "Escape");
    expect(announcement()).toContain("Recording cancelled");

    startRecording();
    const tab = key("keydown", "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(bindingButton().textContent).toBe("Ctrl+Shift+Alt");
    expect(releaseOverride()).toBeUndefined();
  });

  it("shows a persisted override after a reload, and reset restores the default", async () => {
    setOverrides([{ action: RELEASE_CHORD_ACTION, key: "Ctrl+Cmd" }]);
    await renderComponent();
    expect(bindingButton().textContent).toMatch(/^(Ctrl\+Cmd|Cmd\+Ctrl)$/);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          `[data-testid="keybinding-reset-${RELEASE_CHORD_ACTION}"]`
        )
        ?.click();
      await Promise.resolve();
    });
    expect(bindingButton().textContent).toBe("Ctrl+Shift+Alt");
    expect(releaseOverride()).toBeUndefined();
  });
});
