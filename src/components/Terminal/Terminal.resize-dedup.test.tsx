/**
 * Regression tests for resize deduplication in Terminal.tsx.
 *
 * Before the fix, every terminal session produced at least two identical
 * resizeTerminal() calls at setup time — one from xterm.onResize (triggered by
 * fitAddon.fit()) and one from the unconditional explicit call right after.
 * Each extra call sends a SIGWINCH to the running process; for TUI apps like
 * Claude Code that continuously rewrite a multi-line status bar, duplicate
 * SIGWINCHs at the same terminal size can cause partial clears that leave
 * ghost / duplicate lines in the output.
 *
 * The fix: track (lastSentCols, lastSentRows) and only call resizeTerminal
 * when the PTY dimensions actually change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { resizeTerminal } from "@/services/api";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture the onResize callback so tests can simulate terminal resize events.
let capturedOnResize: ((dims: { cols: number; rows: number }) => void) | null = null;

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn((cb: (dims: { cols: number; rows: number }) => void) => {
      capturedOnResize = cb;
      return { dispose: vi.fn() };
    });
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    writeln = vi.fn();
    scrollToBottom = vi.fn();
    scrollLines = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    unicode = { activeVersion: "6" };
    cols = 80;
    rows = 24;
    resize = vi.fn(function (this: MockXTerm, cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    });
    focus = vi.fn();
    element = document.createElement("div");
    buffer = { active: { viewportY: 0, baseY: 0, length: 0, getLine: vi.fn() } };
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    options = {};
    modes = { bracketedPasteMode: false };
    clearSelection = vi.fn();
    clear = vi.fn();
  }
  return { Terminal: MockXTerm };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    dispose = vi.fn();
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
  },
}));

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
}));

const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("session-resize-test"),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn(() => vi.fn()),
    subscribeExit: vi.fn(() => vi.fn()),
  },
}));

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOCAL_CONFIG = { type: "local" as const, config: {} };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  capturedOnResize = null;
  mockResizeTerminal.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Terminal — resize deduplication", () => {
  it("does not send resizeTerminal when onResize fires with the same dims as session creation", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-resize-1" config={LOCAL_CONFIG} isVisible={true} />
        </TerminalPortalProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedOnResize).not.toBeNull();
    const callCountAfterSetup = mockResizeTerminal.mock.calls.length;

    // Simulate xterm.onResize firing with the SAME 80×24 dims (as at session
    // creation).  This happens when TerminalSlot's RAF fit or the visibility
    // effect calls fitAddon.fit() and the container hasn't changed.
    act(() => {
      capturedOnResize!({ cols: 80, rows: 24 });
    });

    // resizeTerminal must NOT be called again — same dims, no new SIGWINCH.
    expect(mockResizeTerminal.mock.calls.length).toBe(callCountAfterSetup);
  });

  it("sends resizeTerminal when onResize fires with genuinely different dims", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-resize-2" config={LOCAL_CONFIG} isVisible={true} />
        </TerminalPortalProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedOnResize).not.toBeNull();
    const callCountAfterSetup = mockResizeTerminal.mock.calls.length;

    // Simulate a real resize (user dragged the splitter).
    act(() => {
      capturedOnResize!({ cols: 200, rows: 50 });
    });

    expect(mockResizeTerminal.mock.calls.length).toBe(callCountAfterSetup + 1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-resize-test", 200, 50);
  });

  it("does not send duplicate resizeTerminal calls at startup for a new session", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-resize-3" config={LOCAL_CONFIG} isVisible={true} />
        </TerminalPortalProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The startup sequence (fitAddon.fit() → onResize → explicit resize)
    // previously sent resizeTerminal twice with the same 80×24 dims.
    // With deduplication, at most one call should be made (and only if the
    // container changed during the async createTerminal call).
    const callsWithCreationDims = mockResizeTerminal.mock.calls.filter(
      ([, cols, rows]) => cols === 80 && rows === 24
    );
    // At most once — not the two-or-more that the old code produced.
    expect(callsWithCreationDims.length).toBeLessThanOrEqual(1);
  });
});
