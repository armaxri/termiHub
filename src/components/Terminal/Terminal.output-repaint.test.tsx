import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// Regression test for #1849: terminal output painted out of order (a later
// prompt line rendered between an earlier command's output lines) until the tab
// is resized. The maintainer confirmed a resize fixes it, proving the xterm.js
// buffer is correct but the DOM renderer paints rows at stale positions during
// rapid scrolling output (Windows ConPTY redrawing a `git status`). The fix
// forces a full-viewport `xterm.refresh(0, rows - 1)` after each output flush so
// the repaint is deterministic without a manual resize. This test locks in that
// the refresh is issued on the output path.

let capturedWriteCallback: (() => void) | null = null;
let capturedOnScrollHandler: (() => void) | null = null;
const mockScrollToBottom = vi.fn();
const mockRefresh = vi.fn();
const mockBuffer = {
  active: { viewportY: 100, baseY: 100, length: 1, getLine: vi.fn() },
};

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn((handler: () => void) => {
      capturedOnScrollHandler = handler;
      return { dispose: vi.fn() };
    });
    onCursorMove = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    scrollToLine = vi.fn();
    write = vi.fn((_data: unknown, cb?: () => void) => {
      capturedWriteCallback = cb ?? null;
    });
    writeln = vi.fn();
    scrollToBottom = mockScrollToBottom;
    refresh = mockRefresh;
    scrollLines = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    unicode = { activeVersion: "6" };
    cols = 80;
    rows = 24;
    resize = vi.fn();
    focus = vi.fn();
    element = document.createElement("div");
    buffer = mockBuffer;
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    options = {};
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

vi.mock("@xterm/addon-unicode11", () => {
  class MockUnicode11Addon {
    dispose = vi.fn();
  }
  return { Unicode11Addon: MockUnicode11Addon };
});

vi.mock("@xterm/addon-search", () => {
  class MockSearchAddon {
    dispose = vi.fn();
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("session-1"),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn((_id: string, cb: (data: Uint8Array) => void) => {
      outputCallback = cb;
      return vi.fn();
    }),
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

let outputCallback: ((data: Uint8Array) => void) | null = null;

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

let rafCallbacks: Array<() => void> = [];
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

beforeEach(() => {
  rafCallbacks = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafCallbacks.push(() => cb(0));
    return id;
  });
  globalThis.cancelAnimationFrame = vi.fn();
});

function flushRaf() {
  const cbs = [...rafCallbacks];
  rafCallbacks = [];
  cbs.forEach((cb) => cb());
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  capturedWriteCallback = null;
  capturedOnScrollHandler = null;
  mockScrollToBottom.mockClear();
  mockRefresh.mockClear();
  mockBuffer.active.viewportY = 100;
  mockBuffer.active.baseY = 100;
  outputCallback = null;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
});

function renderTerminal() {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId="tab-1" config={{ type: "local", config: {} }} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
}

async function pushOutputAndFlush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  if (outputCallback) {
    act(() => {
      outputCallback!(new Uint8Array([65, 66, 67]));
    });
  }

  // Flush the output RAF (flushOutput → xterm.write)
  act(() => flushRaf());

  // Run the write callback (afterWrite schedules the repaint RAF)
  if (capturedWriteCallback) {
    act(() => capturedWriteCallback!());
  }

  // Flush the scroll/refresh RAF
  act(() => flushRaf());
}

describe("Terminal output repaint (#1849)", () => {
  it("forces a full-viewport refresh after appended output", async () => {
    renderTerminal();
    await pushOutputAndFlush();

    expect(mockRefresh).toHaveBeenCalledWith(0, 23);
  });

  it("still refreshes when the user has scrolled up (stale rows stay correct)", async () => {
    renderTerminal();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Simulate the user scrolling away from the bottom: onScroll marks the
    // terminal as scrolled-up so auto-scroll is suppressed.
    mockBuffer.active.viewportY = 50;
    mockBuffer.active.baseY = 100;
    expect(capturedOnScrollHandler).not.toBeNull();
    act(() => capturedOnScrollHandler!());
    mockScrollToBottom.mockClear();
    mockRefresh.mockClear();

    if (outputCallback) {
      act(() => {
        outputCallback!(new Uint8Array([68, 69, 70]));
      });
    }
    act(() => flushRaf());
    if (capturedWriteCallback) {
      act(() => capturedWriteCallback!());
    }
    act(() => flushRaf());

    // Auto-scroll is suppressed while scrolled up, but the viewport is still
    // repainted so no stale rows are left behind.
    expect(mockScrollToBottom).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledWith(0, 23);
  });
});
