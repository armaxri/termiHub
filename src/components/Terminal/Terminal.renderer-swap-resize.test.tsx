/**
 * Regression tests for #4858: a WebGL lease release / re-lease (tab hide/show)
 * must not resize the PTY when the container size is unchanged.
 *
 * The DOM and WebGL renderers measure different cells — WebGL floors the cell
 * to whole device pixels, the DOM renderer does not — so the same container
 * fits a different grid under each (117 vs 111 cols on a Windows runner). The
 * WebGL context is a lease of on-screen terminals (#4308/#4426), so every tab
 * switch swaps the renderer. Re-fitting on that swap sent a PTY resize to the
 * hidden *and* the shown session on every switch (two SIGWINCHs per tab, and a
 * dropped keystroke under Windows ConPTY, #4841).
 *
 * The mocks model exactly that: the fit addon proposes a grid from the current
 * container width and the cell width of whichever renderer is live.
 *
 * #4863: a real container change while a tab is hidden is fitted once, on the
 * next show, to the grid the tab is shown with — not to the DOM grid while
 * hidden and again to the WebGL grid on show.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  /** Cell width each renderer measures for the same font (px). */
  const CELL_WIDTH = { dom: 8.43, webgl: 8 };
  const state = {
    containerWidth: 1000,
    containerHeight: 480,
    liveWebgl: 0,
    /** When set, creating a WebGL addon throws (no WebGL2: DOM renderer only). */
    webglFails: false,
    xterm: null as null | {
      resize: (cols: number, rows: number) => void;
    },
  };
  const gridFor = () => {
    const cell = state.liveWebgl > 0 ? CELL_WIDTH.webgl : CELL_WIDTH.dom;
    return {
      cols: Math.floor(state.containerWidth / cell),
      rows: Math.floor(state.containerHeight / 20),
    };
  };
  const webglInstances: Array<{ triggerContextLoss: () => void }> = [];
  const resizeObserverCallbacks: Array<(entries: ResizeObserverEntry[]) => void> = [];
  return { state, gridFor, webglInstances, resizeObserverCallbacks };
});

// xterm whose resize() fires onResize only on a real dimension change, like the
// real terminal. loadAddon counts a live WebGL addon so the fit sees its cell.
vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  class SwapXTerm extends MockXTerm {
    private resizeListeners: Array<(dims: { cols: number; rows: number }) => void> = [];
    onResize = vi.fn((cb: (dims: { cols: number; rows: number }) => void) => {
      this.resizeListeners.push(cb);
      return { dispose: vi.fn() };
    });
    resize = vi.fn((cols: number, rows: number) => {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.resizeListeners.forEach((cb) => cb({ cols, rows }));
    });
    loadAddon = vi.fn((addon: { isWebgl?: boolean; activate?: () => void }) => {
      if (addon.isWebgl) addon.activate?.();
    });
    write = vi.fn();
    constructor(options?: Record<string, unknown>) {
      super(options);
      h.state.xterm = this;
    }
  }
  return { Terminal: SwapXTerm };
});

vi.mock("@xterm/addon-webgl", () => {
  class MockWebglAddon {
    readonly isWebgl = true;
    private live = false;
    private lossCb: (() => void) | null = null;
    onContextLoss = vi.fn((cb: () => void) => {
      this.lossCb = cb;
    });
    activate() {
      this.live = true;
      h.state.liveWebgl++;
    }
    dispose = vi.fn(() => {
      if (this.live) h.state.liveWebgl--;
      this.live = false;
    });
    triggerContextLoss() {
      this.lossCb?.();
    }
    constructor() {
      if (h.state.webglFails) throw new Error("no WebGL2 context");
      h.webglInstances.push(this);
    }
  }
  return { WebglAddon: MockWebglAddon };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    proposeDimensions = vi.fn(() => h.gridFor());
    fit = vi.fn(() => {
      const { cols, rows } = h.gridFor();
      h.state.xterm?.resize(cols, rows);
    });
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
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("session-swap"),
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
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    h.resizeObserverCallbacks.push(cb);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// jsdom lays nothing out (offsetWidth/Height are 0), which the degenerate-fit
// guard (#2693) would read as a parked terminal. Report the modelled container.
const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

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

const LOCAL_CONFIG = { type: "local" as const, config: {} };

function renderTerminal(isVisible: boolean, isOnScreen: boolean = isVisible) {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId="tab-swap"
          config={LOCAL_CONFIG}
          isVisible={isVisible}
          isOnScreen={isOnScreen}
        />
      </TerminalPortalProvider>
    );
  });
}

/** Run pending frames and let the ordered resize sender drain. */
async function settle() {
  act(() => flushRaf());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Mount visible, connect, and settle on the WebGL grid. */
async function mountConnected() {
  renderTerminal(true);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await settle();
  mockResizeTerminal.mockClear();
}

/** Simulate the container being laid out at a new size. */
function resizeContainer(width: number, height: number) {
  h.state.containerWidth = width;
  h.state.containerHeight = height;
  const entry = { contentRect: { width, height } } as ResizeObserverEntry;
  act(() => h.resizeObserverCallbacks.forEach((cb) => cb([entry])));
}

beforeEach(() => {
  rafCallbacks = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafCallbacks.push(() => cb(0));
    return ++rafId;
  });
  globalThis.cancelAnimationFrame = vi.fn();

  h.state.containerWidth = 1000;
  h.state.containerHeight = 480;
  h.state.liveWebgl = 0;
  h.state.webglFails = false;
  h.state.xterm = null;
  h.webglInstances.length = 0;
  h.resizeObserverCallbacks.length = 0;
  mockResizeTerminal.mockClear();

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => h.state.containerWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => h.state.containerHeight,
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  if (offsetWidthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDesc);
  if (offsetHeightDesc) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
  }
});

describe("Terminal renderer swap keeps the PTY grid (#4858)", () => {
  it("precondition: the two renderers fit different grids into the same container", async () => {
    await mountConnected();
    expect(h.state.liveWebgl).toBe(1);
    expect(h.state.xterm).not.toBeNull();
    const webglGrid = h.gridFor();
    h.state.liveWebgl = 0;
    const domGrid = h.gridFor();
    h.state.liveWebgl = 1;
    expect(webglGrid.cols).not.toBe(domGrid.cols);
  });

  it("does not resize the PTY when the tab is hidden and shown at an unchanged size", async () => {
    await mountConnected();

    renderTerminal(false);
    await settle();
    expect(h.state.liveWebgl).toBe(0);

    renderTerminal(true);
    await settle();
    expect(h.state.liveWebgl).toBe(1);

    renderTerminal(false);
    await settle();
    renderTerminal(true);
    await settle();

    expect(mockResizeTerminal).not.toHaveBeenCalled();
  });

  it("still resizes the PTY on a real container change while visible", async () => {
    await mountConnected();

    resizeContainer(800, 480);
    await settle();

    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 100, 24);
  });

  it("defers a container change while hidden to one resize on show (#4863)", async () => {
    await mountConnected();
    renderTerminal(false);
    await settle();

    resizeContainer(800, 600);
    await settle();

    // Hidden: nothing is fitted, so the PTY is not resized to the DOM grid.
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    renderTerminal(true);
    await settle();

    // Shown: exactly one resize, to the WebGL grid the tab is shown with.
    expect(h.state.liveWebgl).toBe(1);
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 100, 30);
  });

  it("collapses several container changes while hidden into one resize on show", async () => {
    await mountConnected();
    renderTerminal(false);
    await settle();

    resizeContainer(900, 520);
    await settle();
    resizeContainer(700, 400);
    await settle();
    resizeContainer(800, 600);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    renderTerminal(true);
    await settle();

    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 100, 30);
  });

  it("keeps the fit pending when the tab is hidden again before the show frame", async () => {
    // Only isOnScreen flips (an inactive tab group's active tab), so the
    // visibility effect does not fit synchronously on show.
    await mountConnected();
    renderTerminal(true, false);
    await settle();
    resizeContainer(800, 600);
    await settle();

    // Put on screen and taken off again before any frame runs: nothing
    // reaches the PTY.
    renderTerminal(true, true);
    renderTerminal(true, false);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    // The next real show still owes (and sends) the one resize.
    renderTerminal(true, true);
    await settle();
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 100, 30);
  });

  it("runs the deferred fit on show even when no renderer swap re-fits (DOM only)", async () => {
    // No WebGL2: the DOM renderer is live throughout, so showing the tab swaps
    // nothing. Only isOnScreen flips (an inactive tab group's active tab), so
    // the visibility effect does not re-fit either: the deferred fit must.
    h.state.webglFails = true;
    await mountConnected();
    expect(h.state.liveWebgl).toBe(0);

    renderTerminal(true, false);
    await settle();
    resizeContainer(800, 600);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    renderTerminal(true, true);
    await settle();
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 94, 30);
  });

  it("does not fit a degenerate container on show (#2693)", async () => {
    await mountConnected();
    renderTerminal(false);
    await settle();
    resizeContainer(800, 600);
    await settle();

    // Shown into a panel that is not laid out yet: no fit, no PTY resize.
    h.state.containerWidth = 0;
    h.state.containerHeight = 0;
    renderTerminal(true);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    // The ResizeObserver fits once the panel reaches its real size.
    resizeContainer(800, 600);
    await settle();
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 100, 30);
  });

  it("re-fits and resizes when the context is lost on a visible terminal", async () => {
    await mountConnected();

    act(() => h.webglInstances[0].triggerContextLoss());
    await settle();

    // The visible terminal now draws with the DOM cell; its grid must fit.
    expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-swap", 118, 24);
  });
});
