import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// --- Mocks ---

// Capture the onScroll handler and write callback so we can drive them in tests
let capturedOnScrollHandler: (() => void) | null = null;
let capturedWriteCallback: (() => void) | null = null;
const mockScrollToBottom = vi.fn();
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
    write = vi.fn((_data: unknown, cb?: () => void) => {
      capturedWriteCallback = cb ?? null;
    });
    writeln = vi.fn();
    scrollToBottom = mockScrollToBottom;
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
      // Store the output callback so tests can push data
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

// Mock requestAnimationFrame to execute synchronously in tests
// Mock ResizeObserver (not available in jsdom)
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
  capturedOnScrollHandler = null;
  capturedWriteCallback = null;
  mockScrollToBottom.mockClear();
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
        <Terminal tabId="tab-1" config={{ type: "local", name: "Test" }} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
}

describe("Terminal auto-scroll behavior", () => {
  it("auto-scrolls when viewport is at the bottom", async () => {
    renderTerminal();

    // Wait for async setupTerminal
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Simulate output arriving
    if (outputCallback) {
      act(() => {
        outputCallback!(new Uint8Array([65, 66, 67]));
      });
    }

    // Flush the output RAF (flushOutput)
    act(() => flushRaf());

    // The write callback should have been captured
    if (capturedWriteCallback) {
      act(() => capturedWriteCallback!());
    }

    // Flush the scrollToBottom RAF inside scrollAfterWrite
    act(() => flushRaf());

    expect(mockScrollToBottom).toHaveBeenCalled();
  });

  it("suppresses auto-scroll when user has scrolled up", async () => {
    renderTerminal();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Simulate user scrolling up: viewportY < baseY
    mockBuffer.active.viewportY = 50;
    mockBuffer.active.baseY = 100;
    expect(capturedOnScrollHandler).not.toBeNull();
    act(() => capturedOnScrollHandler!());

    // Clear any prior calls
    mockScrollToBottom.mockClear();

    // Simulate output arriving
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

    // scrollToBottom should NOT have been called
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it("resumes auto-scroll when user scrolls back to bottom", async () => {
    renderTerminal();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Simulate scrolling up
    mockBuffer.active.viewportY = 50;
    mockBuffer.active.baseY = 100;
    act(() => capturedOnScrollHandler!());

    // Then scroll back to bottom
    mockBuffer.active.viewportY = 100;
    mockBuffer.active.baseY = 100;
    act(() => capturedOnScrollHandler!());

    mockScrollToBottom.mockClear();

    // Simulate output arriving
    if (outputCallback) {
      act(() => {
        outputCallback!(new Uint8Array([71, 72, 73]));
      });
    }

    act(() => flushRaf());

    if (capturedWriteCallback) {
      act(() => capturedWriteCallback!());
    }

    act(() => flushRaf());

    // scrollToBottom should be called again
    expect(mockScrollToBottom).toHaveBeenCalled();
  });
});
