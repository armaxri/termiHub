/**
 * The command palette opens from its keyboard shortcut (#1484, #4013).
 *
 * Unlike `useKeyboardShortcuts.test.ts` (which mocks `processKeyEvent`), this
 * mounts the real global shortcut hook against the real keybinding service and
 * the real palette, so it pins the whole path: platform default binding →
 * `command-palette` action → store flag → palette rendered with its search box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { clearOverrides } from "@/services/keybindings";
import { CommandPalette } from "./CommandPalette";

vi.mock("@/hooks/useConnectSavedConnection", () => ({
  useConnectSavedConnection: () => ({ connect: vi.fn(() => Promise.resolve()) }),
}));

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

/** The app shell in miniature: the global shortcut hook plus the palette. */
function Shell() {
  useKeyboardShortcuts();
  return <CommandPalette />;
}

let container: HTMLDivElement;
let root: Root;

setupConnectionsRegion();

function setUserAgent(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function paletteInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]');
}

async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    document.body.dispatchEvent(event);
  });
  await flushAsync();
  return event;
}

beforeEach(async () => {
  clearOverrides();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ ...useAppStore.getInitialState(), commandPaletteOpen: false });
  seedConnectionsRegion({ connections: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(<Shell />);
  });
  await flushAsync();
  expect(paletteInput()).toBeNull();
}

describe("command palette shortcut", () => {
  it("Cmd+P opens the palette on macOS", async () => {
    setUserAgent(MAC_UA);
    await mount();

    const event = await press({ key: "p", code: "KeyP", metaKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().commandPaletteOpen).toBe(true);
    expect(paletteInput()).not.toBeNull();
  });

  it.each([
    ["Windows", WINDOWS_UA],
    ["Linux", LINUX_UA],
  ])("Ctrl+Shift+P opens the palette on %s", async (_name, ua) => {
    setUserAgent(ua);
    await mount();

    const event = await press({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().commandPaletteOpen).toBe(true);
    expect(paletteInput()).not.toBeNull();
  });

  it("bare Ctrl+P does not open the palette on Windows/Linux (readline previous-history)", async () => {
    setUserAgent(LINUX_UA);
    await mount();

    await press({ key: "p", code: "KeyP", ctrlKey: true });

    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(paletteInput()).toBeNull();
  });
});
