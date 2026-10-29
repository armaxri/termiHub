/**
 * Regression tests for #5082: a new terminal's grid follows the web font.
 *
 * xterm measures its character cell when it opens and afterwards only on a
 * font-option change, a resize or a pixel-ratio change. The terminal font is a
 * web font that usually finishes loading after a new tab opened, so the first
 * measurement is the fallback font's. On a Retina Mac that cell is 16px tall
 * where the loaded font's is 18px: the fit proposed (and the PTY got) too many
 * rows, the bottom rows fell below the pane, and only a window resize fixed it.
 * Re-fitting on font load proposed the same stale grid, because nothing made
 * xterm measure the loaded font.
 *
 * The mocks: xterm's char-size service measures the fallback or the loaded
 * font; the fit addon proposes from that measurement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  /** Cell height (px) of the fallback font, and of the loaded web font. */
  const FALLBACK_HEIGHT = 16;
  const WEBFONT_HEIGHT = 18;
  const state = {
    /** Whether the terminal web font has finished loading. */
    fontLoaded: false,
    /** The cell height xterm last measured (its char-size service). */
    measuredHeight: FALLBACK_HEIGHT,
    containerWidth: 1000,
    containerHeight: 480,
    liveWebgl: 0,
    /** When set, creating a WebGL addon throws (no WebGL2: DOM renderer only). */
    webglFails: false,
    xterm: null as null | {
      resize: (cols: number, rows: number) => void;
    },
  };
  /** What a fit proposes: xterm's *measured* cell, not the font's real one. */
  const gridFor = () => ({
    cols: Math.floor(state.containerWidth / 8),
    rows: Math.floor(state.containerHeight / state.measuredHeight),
  });
  /** The grid the loaded font really fits. */
  const loadedGrid = () => ({
    cols: Math.floor(state.containerWidth / 8),
    rows: Math.floor(state.containerHeight / WEBFONT_HEIGHT),
  });
  const webglInstances: Array<{ triggerContextLoss: () => void }> = [];
  const resizeObserverCallbacks: Array<(entries: ResizeObserverEntry[]) => void> = [];
  return {
    state,
    gridFor,
    loadedGrid,
    FALLBACK_HEIGHT,
    WEBFONT_HEIGHT,
    webglInstances,
    resizeObserverCallbacks,
  };
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
      // xterm's char-size service: it measures whatever font is loaded *now*.
      (this._core as unknown as Record<string, unknown>)._charSizeService = {
        width: 8,
        get height() {
          return h.state.measuredHeight;
        },
        measure: () => {
          h.state.measuredHeight = h.state.fontLoaded ? h.WEBFONT_HEIGHT : h.FALLBACK_HEIGHT;
        },
      };
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
  createTerminal: vi.fn().mockResolvedValue("session-font"),
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

/** A promise with its resolver exposed. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const fontsDesc = Object.getOwnPropertyDescriptor(document, "fonts");
/** The pending load of the terminal web font. */
let fontLoad = deferred();

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
          tabId="tab-font"
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

  h.state.fontLoaded = false;
  h.state.measuredHeight = h.FALLBACK_HEIGHT;
  fontLoad = deferred();
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load: vi.fn(() => fontLoad.promise),
      get ready() {
        return fontLoad.promise;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
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
  if (fontsDesc) Object.defineProperty(document, "fonts", fontsDesc);
  else delete (document as unknown as { fonts?: unknown }).fonts;
  container.remove();
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  if (offsetWidthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDesc);
  if (offsetHeightDesc) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
  }
});

describe("Terminal follows the loaded web font (#5082)", () => {
  it("precondition: the fallback cell fits more rows than the loaded font", () => {
    expect(h.gridFor().rows).toBeGreaterThan(h.loadedGrid().rows);
  });

  it("re-measures the cell when the font loads and sends the PTY the real grid", async () => {
    await mountConnected();
    expect(h.state.xterm).toMatchObject({ rows: h.gridFor().rows });

    h.state.fontLoaded = true;
    await act(async () => {
      fontLoad.resolve();
      await fontLoad.promise;
    });
    await settle();
    await settle();

    const grid = h.loadedGrid();
    expect(h.state.xterm).toMatchObject({ cols: grid.cols, rows: grid.rows });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-font", grid.cols, grid.rows);
  });

  it("owes a hidden terminal the re-fit until it is shown", async () => {
    await mountConnected();
    renderTerminal(false);
    await settle();
    mockResizeTerminal.mockClear();

    h.state.fontLoaded = true;
    await act(async () => {
      fontLoad.resolve();
      await fontLoad.promise;
    });
    await settle();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    renderTerminal(true);
    await settle();
    await settle();
    const grid = h.loadedGrid();
    expect(h.state.xterm).toMatchObject({ rows: grid.rows });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-font", grid.cols, grid.rows);
  });
});
