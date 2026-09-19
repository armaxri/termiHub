/**
 * Tests for the terminal command bridge (PROD-054).
 *
 * The bridge listens for the `termihub:*` DOM events that palette/keyboard
 * callers dispatch from outside the terminal registry provider, and forwards
 * each to the matching registry method for the addressed tab. This guarantees a
 * command palette entry and its keyboard shortcut drive the identical handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalCommandBridge } from "./TerminalCommandBridge";

const registry = {
  clearTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  copySelectionToClipboard: vi.fn(() => Promise.resolve()),
  pasteToTerminal: vi.fn(() => Promise.resolve()),
  selectAllInTerminal: vi.fn(),
};

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => registry,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(TerminalCommandBridge));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function dispatch(eventName: string, tabId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { tabId } }));
  });
}

describe("TerminalCommandBridge", () => {
  it("routes clipboard events to the matching registry method for the tab", () => {
    dispatch("termihub:copy-selection", "tab-1");
    expect(registry.copySelectionToClipboard).toHaveBeenCalledWith("tab-1");

    dispatch("termihub:paste", "tab-2");
    expect(registry.pasteToTerminal).toHaveBeenCalledWith("tab-2");

    dispatch("termihub:select-all", "tab-3");
    expect(registry.selectAllInTerminal).toHaveBeenCalledWith("tab-3");
  });

  it("still routes the pre-existing clear/focus events", () => {
    dispatch("termihub:clear-terminal", "tab-4");
    expect(registry.clearTerminal).toHaveBeenCalledWith("tab-4");

    dispatch("termihub:focus-terminal", "tab-5");
    expect(registry.focusTerminal).toHaveBeenCalledWith("tab-5");
  });

  it("ignores events with no tabId", () => {
    act(() => {
      window.dispatchEvent(new CustomEvent("termihub:paste", { detail: { tabId: "" } }));
    });
    expect(registry.pasteToTerminal).not.toHaveBeenCalled();
  });
});
