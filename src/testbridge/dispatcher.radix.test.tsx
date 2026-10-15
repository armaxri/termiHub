import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
} from "@/components/ui";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/**
 * The bridge `click` must drive Radix dropdowns (via the shared ui/Menu skin) the way a real mouse does: open
 * the menu (which opens on pointerdown) and select an item exactly once. A naive
 * `element.click()` never opened the menu; the realistic pointer+mouse+click
 * sequence must not regress into double-activating the item either.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function deps(): BridgeDeps {
  return {
    root: document.body, // Radix renders its content in a portal under <body>
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
  };
}

describe("dispatchCommand click against a Radix dropdown", () => {
  it("opens the menu and selects an item exactly once", async () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <DropdownMenuRoot>
          <DropdownMenuTrigger asChild>
            <button data-testid="menu-host">Host</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <MenuItem data-testid="menu-disconnect" onSelect={onSelect}>
              Disconnect
            </MenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      );
    });

    // Menu starts closed.
    expect(document.querySelector('[data-testid="menu-disconnect"]')).toBeNull();

    // Open it via the bridge click (must reach Radix's pointerdown-to-open).
    await act(async () => {
      await dispatchCommand({ action: "click", testId: "menu-host" }, deps());
    });
    expect(document.querySelector('[data-testid="menu-disconnect"]')).not.toBeNull();

    // Select the item via the bridge click — exactly once, no double-activation.
    await act(async () => {
      await dispatchCommand({ action: "click", testId: "menu-disconnect" }, deps());
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
