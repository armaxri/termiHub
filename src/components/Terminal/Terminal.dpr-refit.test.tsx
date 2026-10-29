/**
 * Regression tests for #5065: a device-pixel-ratio change re-fits the terminal.
 *
 * Moving the window to a monitor with another scale (or the display scale, or
 * the WebView settling on its real scale after start-up) changes
 * `devicePixelRatio` without changing the container's CSS size, so the
 * ResizeObserver never fires. The WebGL renderer floors its cell to whole
 * device pixels, so its cell width changes with the ratio (13px font: 7px at
 * 1x, 7.5px at 2x). Without a re-fit the grid fitted at the old ratio is wider
 * than the pane: the right-most columns are cut off, and a full-screen program
 * (Claude Code) lays out for columns nobody can see.
 *
 * The mocks: the fit addon proposes a grid from the container width and the
 * live renderer's cell at the current ratio.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  /** The font's measured advance (px): 13px MesloLGS Nerd Font Mono. */
  const CHAR_WIDTH = 7.83;
  const state = {
    /** The window's device pixel ratio. */
    dpr: 1,
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
    // WebGL floors the cell to whole device pixels; the DOM renderer does not.
    const cell = state.liveWebgl > 0 ? Math.floor(CHAR_WIDTH * state.dpr) / state.dpr : CHAR_WIDTH;
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
  createTerminal: vi.fn().mockResolvedValue("session-dpr"),
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
          tabId="tab-dpr"
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

beforeEach(() => {
  rafCallbacks = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafCallbacks.push(() => cb(0));
    return ++rafId;
  });
  globalThis.cancelAnimationFrame = vi.fn();

  h.state.dpr = 1;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
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

/** Change the window's device pixel ratio the way a monitor move does. */
function changeDpr(dpr: number) {
  h.state.dpr = dpr;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("Terminal re-fits on a device pixel ratio change (#5065)", () => {
  it("precondition: the WebGL grid at 1x is wider than the pane at 2x", async () => {
    await mountConnected();
    const at1x = h.gridFor();
    h.state.dpr = 2;
    expect(h.gridFor().cols).toBeLessThan(at1x.cols);
  });

  it("re-fits the grid and resizes the PTY when the ratio changes", async () => {
    await mountConnected();
    expect(h.state.liveWebgl).toBe(1);
    const before = h.gridFor();
    expect(h.state.xterm).toMatchObject({ cols: before.cols });

    changeDpr(2);
    await settle();

    const after = h.gridFor();
    expect(after.cols).toBeLessThan(before.cols);
    expect(h.state.xterm).toMatchObject({ cols: after.cols, rows: after.rows });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-dpr", after.cols, after.rows);
  });

  it("follows the ratio back and forth", async () => {
    await mountConnected();
    changeDpr(1.5);
    await settle();
    changeDpr(1);
    await settle();
    const grid = h.gridFor();
    expect(h.state.xterm).toMatchObject({ cols: grid.cols });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-dpr", grid.cols, grid.rows);
  });

  it("owes a hidden terminal the re-fit until it is shown", async () => {
    await mountConnected();
    renderTerminal(false);
    await settle();
    mockResizeTerminal.mockClear();

    changeDpr(2);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    renderTerminal(true);
    await settle();
    await settle();
    const grid = h.gridFor();
    expect(h.state.xterm).toMatchObject({ cols: grid.cols });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-dpr", grid.cols, grid.rows);
  });

  it("sends nothing when the ratio is unchanged", async () => {
    await mountConnected();
    changeDpr(1);
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();
  });
});
