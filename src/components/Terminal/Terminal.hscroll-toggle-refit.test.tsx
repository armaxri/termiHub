/**
 * Regression tests for #5121: toggling horizontal scrolling re-fits against
 * the layout actually on screen, not the one the WebView's computed style
 * still reports at the moment of the toggle.
 *
 * Horizontal mode reserves a strip under the last row for the horizontal bar
 * (`.xterm` padding-bottom) and insets the scroll viewport. The toggle effect
 * flips the viewport class and fits straight away. On the macOS CI runner the
 * WebView's computed style lagged that flip by one step: entering horizontal
 * mode fitted the normal-mode rows (the bar then covered the last row) and
 * leaving it fitted the horizontal-mode grid. The container (`el`) keeps its
 * size across the toggle, so its ResizeObserver never corrected either. The
 * viewport's box does change, so the terminal also observes the viewport.
 *
 * The mocks: the fit addon proposes a grid from `applied`, the mode the
 * modelled layout engine has applied, which the test advances by hand after the
 * toggle (as the next layout pass would), firing the observers of the elements
 * whose box changed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

const h = vi.hoisted(() => {
  const CELL_WIDTH = 8;
  const CELL_HEIGHT = 18;
  /** Default horizontal bar height (Terminal.css `--hscroll-bar`, #5280). */
  const HSCROLL_BAR_DEFAULT = 10;
  /** Gap between the bar and the last row (`--spacing-xs`). */
  const HSCROLL_GAP = 4;
  /** Viewport insets in horizontal mode: edge gap (8) + gutter (12). */
  const HSCROLL_INSET = 20;
  const state = {
    containerWidth: 711,
    containerHeight: 504,
    /** The mode whose layout the modelled engine has applied. */
    applied: "normal" as "normal" | "horizontal",
    xterm: null as null | { cols: number; rows: number },
    /** The bar height the hidden probe lays out; `null` = overlay (no layout space). */
    probeBar: null as number | null,
  };
  /**
   * `.xterm` bottom padding in horizontal mode: the container's `--hscroll-bar`
   * (set by the terminal from the probe, else the CSS default) plus the gap.
   */
  const hscrollReserve = () => {
    const el = document.querySelector<HTMLElement>("[data-testid^='terminal-renderer-']");
    const bar = parseFloat(el?.style.getPropertyValue("--hscroll-bar") ?? "");
    return (Number.isFinite(bar) ? bar : HSCROLL_BAR_DEFAULT) + HSCROLL_GAP;
  };
  const gridFor = (mode: "normal" | "horizontal" = state.applied) => {
    const horizontal = mode === "horizontal";
    const width = state.containerWidth - (horizontal ? HSCROLL_INSET : 16) - 14;
    const height = state.containerHeight - (horizontal ? hscrollReserve() : 0);
    return { cols: Math.floor(width / CELL_WIDTH), rows: Math.floor(height / CELL_HEIGHT) };
  };
  const observers: Array<{
    targets: Set<Element>;
    cb: (entries: ResizeObserverEntry[]) => void;
  }> = [];
  return { state, gridFor, observers };
});

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  class FitXTerm extends MockXTerm {
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
    write = vi.fn();
    constructor(options?: Record<string, unknown>) {
      super(options);
      h.state.xterm = this;
    }
  }
  return { Terminal: FitXTerm };
});

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    proposeDimensions = vi.fn(() => h.gridFor());
    fit = vi.fn(() => {
      const xterm = h.state.xterm as { resize?: (c: number, r: number) => void } | null;
      const { cols, rows } = h.gridFor();
      xterm?.resize?.(cols, rows);
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
  createTerminal: vi.fn().mockResolvedValue("session-hscroll"),
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
  private readonly entry: { targets: Set<Element>; cb: (e: ResizeObserverEntry[]) => void };
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    this.entry = { targets: new Set(), cb };
    h.observers.push(this.entry);
  }
  observe = vi.fn((target: Element) => {
    this.entry.targets.add(target);
  });
  unobserve = vi.fn((target: Element) => {
    this.entry.targets.delete(target);
  });
  disconnect = vi.fn(() => {
    this.entry.targets.clear();
  });
} as unknown as typeof ResizeObserver;

const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const clientHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");

let rafCallbacks: Array<() => void> = [];
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

let container: HTMLDivElement;
let root: Root;

const TAB = "tab-hscroll";
const LOCAL_CONFIG = { type: "local" as const, config: {} };

/** Run pending frames and let the ordered resize sender drain. */
async function settle() {
  act(() => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    cbs.forEach((cb) => cb());
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountConnected() {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={TAB} config={LOCAL_CONFIG} isVisible isOnScreen />
      </TerminalPortalProvider>
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await settle();
}

/**
 * The layout pass after a toggle: the engine applies `mode`, and the observers
 * of the scroll viewport (whose insets changed) fire. The container keeps its
 * size, so an observer watching only it is not called.
 */
async function layoutLands(mode: "normal" | "horizontal") {
  h.state.applied = mode;
  const contentRect = {
    width: h.state.containerWidth,
    height: h.state.containerHeight,
  } as DOMRectReadOnly;
  act(() => {
    for (const { targets, cb } of h.observers) {
      const changed = [...targets].filter((t) => t.classList.contains("terminal-scroll-viewport"));
      if (changed.length > 0) {
        cb(changed.map((target) => ({ target, contentRect }) as ResizeObserverEntry));
      }
    }
  });
  await settle();
}

/** Flip the tab's horizontal scrolling while the computed style still lags. */
async function toggle(on: boolean) {
  act(() => useAppStore.getState().setTabHorizontalScrolling(TAB, on));
  await settle();
}

beforeEach(() => {
  rafCallbacks = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafCallbacks.push(() => cb(0));
    return ++rafId;
  });
  globalThis.cancelAnimationFrame = vi.fn();
  h.state.applied = "normal";
  h.state.xterm = null;
  h.state.containerHeight = 504;
  h.state.probeBar = null;
  h.observers.length = 0;
  mockResizeTerminal.mockClear();
  useAppStore.getState().setTabHorizontalScrolling(TAB, false);
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => h.state.containerWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => h.state.containerHeight,
  });
  // The probe lays out `offsetHeight - probeBar`; every other element keeps
  // jsdom's 0 client height.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("terminal-hscroll-probe")) return 0;
      return h.state.containerHeight - (h.state.probeBar ?? 0);
    },
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
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  if (clientHeightDesc) Object.defineProperty(Element.prototype, "clientHeight", clientHeightDesc);
});

describe("Terminal re-fits after a horizontal-scroll toggle lands (#5121)", () => {
  it("precondition: horizontal mode reserves a row for the bar", () => {
    expect(h.gridFor("horizontal").rows).toBe(h.gridFor("normal").rows - 1);
  });

  it("entering horizontal mode drops the row the bar covers", async () => {
    await mountConnected();
    expect(h.state.xterm).toMatchObject(h.gridFor("normal"));

    await toggle(true);
    // Fitted against the lagging style: the normal-mode rows, under the bar.
    expect(h.state.xterm?.rows).toBe(h.gridFor("normal").rows);

    await layoutLands("horizontal");
    const rows = h.gridFor("horizontal").rows;
    expect(h.state.xterm).toMatchObject({ cols: 500, rows });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-hscroll", 500, rows);
  });

  it("leaving horizontal mode restores the normal grid", async () => {
    await mountConnected();
    await toggle(true);
    await layoutLands("horizontal");

    await toggle(false);
    // Fitted against the lagging style: the horizontal-mode grid.
    expect(h.state.xterm).toMatchObject(h.gridFor("horizontal"));

    await layoutLands("normal");
    const grid = h.gridFor("normal");
    expect(h.state.xterm).toMatchObject(grid);
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-hscroll", grid.cols, grid.rows);
  });
});

/** The scrollbar style changes (e.g. a mouse is plugged in): the probe's box changes. */
async function probeBarBecomes(bar: number | null) {
  h.state.probeBar = bar;
  const contentRect = { width: 64, height: 64 - (bar ?? 0) } as DOMRectReadOnly;
  act(() => {
    for (const { targets, cb } of h.observers) {
      const changed = [...targets].filter((t) => t.classList.contains("terminal-hscroll-probe"));
      if (changed.length > 0) {
        cb(changed.map((target) => ({ target, contentRect }) as ResizeObserverEntry));
      }
    }
  });
  await settle();
}

describe("Terminal sizes the horizontal-scroll reserve from the real bar (#5280)", () => {
  // 500 px: a 14 px reserve (10 px default bar + gap) leaves 27 rows, a 17 px
  // reserve (13 px classic bar + gap) leaves 26.
  beforeEach(() => {
    h.state.containerHeight = 500;
  });

  it("precondition: a 13 px bar needs one row more than the default reserve", () => {
    expect(Math.floor((500 - 14) / 18)).toBe(27);
    expect(Math.floor((500 - 17) / 18)).toBe(26);
  });

  it("entering horizontal mode reserves the measured bar plus the gap", async () => {
    h.state.probeBar = 13;
    await mountConnected();
    await toggle(true);
    await layoutLands("horizontal");

    const el = document.querySelector<HTMLElement>("[data-testid^='terminal-renderer-']");
    expect(el?.style.getPropertyValue("--hscroll-bar")).toBe("13px");
    expect(h.state.xterm).toMatchObject({ cols: 500, rows: 26 });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-hscroll", 500, 26);
  });

  it("overlay scrollbars keep the CSS default reserve", async () => {
    await mountConnected();
    await toggle(true);
    await layoutLands("horizontal");

    const el = document.querySelector<HTMLElement>("[data-testid^='terminal-renderer-']");
    expect(el?.style.getPropertyValue("--hscroll-bar")).toBe("");
    expect(h.state.xterm).toMatchObject({ cols: 500, rows: 27 });
  });

  it("a scrollbar style change in horizontal mode re-fits the rows", async () => {
    await mountConnected();
    await toggle(true);
    await layoutLands("horizontal");
    expect(h.state.xterm?.rows).toBe(27);

    await probeBarBecomes(13);
    expect(h.state.xterm).toMatchObject({ cols: 500, rows: 26 });
    expect(mockResizeTerminal).toHaveBeenLastCalledWith("session-hscroll", 500, 26);

    await probeBarBecomes(null);
    expect(h.state.xterm).toMatchObject({ cols: 500, rows: 27 });
  });
});
