import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// Regression tests for #2078: the WebGL renderer (@xterm/addon-webgl) is the
// GPU-accelerated path for xterm. It must degrade to the DOM renderer on any
// failure — a blank/garbled terminal is app-breaking — so these lock in that:
//   1. the WebGL addon is loaded when it can be created,
//   2. a runtime context loss disposes the addon (xterm reverts to DOM),
//   3. a failed initialization is swallowed and the terminal still mounts and
//      renders through the DOM path.

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  const loadedAddons: unknown[] = [];
  const webglInstances: Array<{
    dispose: ReturnType<typeof vi.fn>;
    triggerContextLoss: () => void;
  }> = [];
  const state = { webglConstructThrows: false };
  return { loadedAddons, webglInstances, state };
});

const mockRefresh = vi.fn();
let capturedWriteCallback: (() => void) | null = null;

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn((addon: unknown) => {
      h.loadedAddons.push(addon);
    });
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onCursorMove = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    scrollToLine = vi.fn();
    write = vi.fn((_data: unknown, cb?: () => void) => {
      capturedWriteCallback = cb ?? null;
    });
    writeln = vi.fn();
    scrollToBottom = vi.fn();
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
    buffer = { active: { viewportY: 100, baseY: 100, length: 1, getLine: vi.fn() } };
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    options = {};
  }
  return { Terminal: MockXTerm };
});

vi.mock("@xterm/addon-webgl", () => {
  class MockWebglAddon {
    dispose = vi.fn();
    private lossCb: (() => void) | null = null;
    onContextLoss = vi.fn((cb: () => void) => {
      this.lossCb = cb;
    });
    triggerContextLoss() {
      this.lossCb?.();
    }
    constructor() {
      if (h.state.webglConstructThrows) {
        throw new Error("WebGL2 context unavailable");
      }
      h.webglInstances.push(this);
    }
  }
  return { WebglAddon: MockWebglAddon };
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

let outputCallback: ((data: Uint8Array) => void) | null = null;

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

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

let rafCallbacks: Array<() => void> = [];
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

function flushRaf() {
  const cbs = [...rafCallbacks];
  rafCallbacks = [];
  cbs.forEach((cb) => cb());
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rafCallbacks = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafCallbacks.push(() => cb(0));
    return id;
  });
  globalThis.cancelAnimationFrame = vi.fn();

  h.loadedAddons.length = 0;
  h.webglInstances.length = 0;
  h.state.webglConstructThrows = false;
  mockRefresh.mockClear();
  capturedWriteCallback = null;
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
      </TerminalPortalProvider>,
    );
  });
}

describe("Terminal WebGL renderer (#2078)", () => {
  it("loads the WebGL addon and wires up its context-loss handler", () => {
    renderTerminal();

    expect(h.webglInstances).toHaveLength(1);
    const webgl = h.webglInstances[0];
    // The addon that was constructed is the one handed to xterm.loadAddon.
    expect(h.loadedAddons).toContain(webgl);
    // A context-loss handler is registered so the renderer can fall back.
    expect(
      (webgl as unknown as { onContextLoss: ReturnType<typeof vi.fn> }).onContextLoss,
    ).toHaveBeenCalledTimes(1);
    // The active renderer is surfaced on the container for diagnostics.
    const container = document.querySelector('[data-testid="terminal-renderer-tab-1"]');
    expect(container?.getAttribute("data-terminal-renderer")).toBe("webgl");
  });

  it("disposes the WebGL addon on context loss (falls back to DOM renderer)", () => {
    renderTerminal();

    const webgl = h.webglInstances[0];
    expect(webgl.dispose).not.toHaveBeenCalled();

    act(() => webgl.triggerContextLoss());

    // Disposing the addon makes xterm revert to its DOM renderer automatically.
    expect(webgl.dispose).toHaveBeenCalledTimes(1);
    const container = document.querySelector('[data-testid="terminal-renderer-tab-1"]');
    expect(container?.getAttribute("data-terminal-renderer")).toBe("dom");
  });

  it("still mounts and renders via the DOM path when WebGL init fails", async () => {
    h.state.webglConstructThrows = true;

    // Must not throw even though the WebGL addon cannot be created.
    expect(() => renderTerminal()).not.toThrow();
    expect(h.webglInstances).toHaveLength(0);

    // The terminal is fully functional on the DOM path: output still flushes and
    // forces the full-viewport repaint (#1849) after a write.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    if (outputCallback) {
      act(() => outputCallback!(new Uint8Array([65, 66, 67])));
    }
    act(() => flushRaf());
    if (capturedWriteCallback) {
      act(() => capturedWriteCallback!());
    }
    act(() => flushRaf());

    expect(mockRefresh).toHaveBeenCalledWith(0, 23);
    const container = document.querySelector('[data-testid="terminal-renderer-tab-1"]');
    expect(container?.getAttribute("data-terminal-renderer")).toBe("dom");
  });
});
