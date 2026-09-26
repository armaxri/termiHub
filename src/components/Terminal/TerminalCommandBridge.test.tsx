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
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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

const tracker = {
  jumpToPreviousPrompt: vi.fn(() => true),
  jumpToNextPrompt: vi.fn(() => true),
  selectLastCommandOutput: vi.fn(() => true),
  getLastCommandOutput: vi.fn((): string | null => "last output"),
};
const trackers = new Map<string, typeof tracker>([["tab-marks", tracker]]);

vi.mock("@/services/commandMarks", () => ({
  getCommandMarkTracker: (tabId: string) => trackers.get(tabId),
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

  describe("OSC 133 command-mark events (#3415)", () => {
    it("route prompt navigation and output selection to the tab's tracker", () => {
      dispatch("termihub:jump-prev-prompt", "tab-marks");
      expect(tracker.jumpToPreviousPrompt).toHaveBeenCalledTimes(1);

      dispatch("termihub:jump-next-prompt", "tab-marks");
      expect(tracker.jumpToNextPrompt).toHaveBeenCalledTimes(1);

      dispatch("termihub:select-last-command-output", "tab-marks");
      expect(tracker.selectLastCommandOutput).toHaveBeenCalledTimes(1);
    });

    it("copies the last command's output to the OS clipboard", async () => {
      dispatch("termihub:copy-last-command-output", "tab-marks");
      await act(async () => {});
      expect(writeText).toHaveBeenCalledWith("last output");
    });

    it("copies nothing when there is no finished command output", async () => {
      tracker.getLastCommandOutput.mockReturnValueOnce(null);
      dispatch("termihub:copy-last-command-output", "tab-marks");
      await act(async () => {});
      expect(writeText).not.toHaveBeenCalled();
    });

    it("is a no-op for a tab without a tracker", () => {
      expect(() => dispatch("termihub:jump-prev-prompt", "tab-unknown")).not.toThrow();
      expect(() => dispatch("termihub:copy-last-command-output", "tab-unknown")).not.toThrow();
      expect(tracker.jumpToPreviousPrompt).not.toHaveBeenCalled();
    });
  });
});
