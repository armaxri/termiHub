/**
 * Regression tests for #5025: a terminal fitted while its container is still
 * parked (not laid out yet) must never resize itself or its PTY to the
 * degenerate 2x1 grid `FitAddon` proposes for a ~0-sized container.
 *
 * The macOS system tests saw a fresh bash tab get `resize_terminal 2x1` about
 * 100 ms after it spawned, then the real grid 50 ms later. macOS's bash 3.2
 * redraws its prompt and the start-up line for the 2-column grid; on the real
 * grid that redraw lands on the wrong rows, so the next prompt overwrote the
 * tail of the echoed shell-integration line (MT-LOCAL command marks, bash).
 * The ResizeObserver, visibility and registry fits already skip a degenerate
 * container (#2693, #2700); the fits around session creation and the web-font
 * re-fit did not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { createTerminal } from "@/services/api";
import { resetSessionInputGatesForTests } from "@/services/sessionInputGate";

const h = vi.hoisted(() => {
  const state = {
    /** Container size; 0x0 while the terminal is parked (not laid out). */
    containerWidth: 0,
    containerHeight: 0,
    xterm: null as null | {
      cols: number;
      rows: number;
      resize: (cols: number, rows: number) => void;
    },
    /** Every grid the xterm was resized to. */
    xtermGrids: [] as string[],
  };
  /**
   * What `FitAddon.proposeDimensions()` returns: xterm's 2x1 floor for a
   * container that has no size yet, like the real addon once a renderer has
   * measured its cell.
   */
  const proposed = () => ({
    cols: Math.max(2, Math.floor(state.containerWidth / 8)),
    rows: Math.max(1, Math.floor(state.containerHeight / 20)),
  });
  const resizeObserverCallbacks: Array<(entries: ResizeObserverEntry[]) => void> = [];
  return { state, proposed, resizeObserverCallbacks };
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
      h.state.xtermGrids.push(`${cols}x${rows}`);
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
    constructor() {
      throw new Error("no WebGL2 context");
    }
  },
}));

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    proposeDimensions = vi.fn(() => h.proposed());
    fit = vi.fn(() => {
      const { cols, rows } = h.proposed();
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

// The real `resizeTerminal` wrapper runs; only the Tauri IPC is faked, and each
// resize applies at once.
const ipc = vi.hoisted(() => ({ resizes: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "resize_terminal") {
      ipc.resizes.push(`${String(args?.cols)}x${String(args?.rows)}`);
    }
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  createTerminal: vi.fn().mockResolvedValue("session-degenerate"),
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

// jsdom lays nothing out; report the modelled container to the px guards.
const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const fontsDesc = Object.getOwnPropertyDescriptor(document, "fonts");

let rafCallbacks: Array<() => void> = [];
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;
let fontsLoaded: () => void = () => {};

let container: HTMLDivElement;
let root: Root;

function renderTerminal(isVisible: boolean, isOnScreen: boolean = isVisible) {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId="tab-degenerate"
          config={{ type: "local", config: {} }}
          isVisible={isVisible}
          isOnScreen={isOnScreen}
        />
      </TerminalPortalProvider>
    );
  });
}

/** Let the connect flow, the resize pump and frame callbacks run. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    act(() => {
      const cbs = [...rafCallbacks];
      rafCallbacks = [];
      cbs.forEach((cb) => cb());
    });
  }
}

/** The panel is laid out: the container gets its real size and is observed. */
async function layOut(width: number, height: number) {
  h.state.containerWidth = width;
  h.state.containerHeight = height;
  const entry = { contentRect: { width, height } } as ResizeObserverEntry;
  act(() => h.resizeObserverCallbacks.forEach((cb) => cb([entry])));
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

  h.state.containerWidth = 0;
  h.state.containerHeight = 0;
  h.state.xterm = null;
  h.state.xtermGrids = [];
  h.resizeObserverCallbacks.length = 0;
  ipc.resizes.length = 0;
  vi.mocked(createTerminal).mockClear();
  resetSessionInputGatesForTests();

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => h.state.containerWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => h.state.containerHeight,
  });
  // The web font loads when the test says so.
  const fontsReady = new Promise<void>((resolve) => {
    fontsLoaded = resolve;
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn(() => fontsReady), ready: fontsReady },
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
  if (fontsDesc) Object.defineProperty(document, "fonts", fontsDesc);
  else delete (document as { fonts?: unknown }).fonts;
});

const degenerate = (grid: string) => Number(grid.split("x")[0]) < 20;

describe("fits while the terminal is still parked (#5025)", () => {
  it("never sends a degenerate resize to the PTY when it connects before layout", async () => {
    renderTerminal(true);
    await settle();

    expect(createTerminal).toHaveBeenCalled();
    const sessionConfig = vi.mocked(createTerminal).mock.calls[0][0] as {
      config: { cols?: number };
    };
    // The PTY is not spawned at the parked grid either.
    expect(sessionConfig.config.cols ?? 80).toBeGreaterThanOrEqual(20);
    expect(ipc.resizes.filter(degenerate)).toEqual([]);
    expect(h.state.xtermGrids.filter(degenerate)).toEqual([]);

    // Once laid out, the real grid reaches the PTY.
    await layOut(944, 560);
    expect(ipc.resizes[ipc.resizes.length - 1]).toBe("118x28");
    expect(ipc.resizes.filter(degenerate)).toEqual([]);
  });

  it("skips the web-font re-fit while the terminal is parked", async () => {
    renderTerminal(true);
    await settle();
    await layOut(944, 560);
    expect(ipc.resizes[ipc.resizes.length - 1]).toBe("118x28");

    // Parked again (e.g. mid-reparent) when the font finishes loading.
    h.state.containerWidth = 0;
    h.state.containerHeight = 0;
    fontsLoaded();
    await settle();

    expect(ipc.resizes.filter(degenerate)).toEqual([]);
    expect(h.state.xtermGrids.filter(degenerate)).toEqual([]);
  });
});
