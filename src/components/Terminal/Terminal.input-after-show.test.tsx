/**
 * Regression tests for #4942: input typed right after a tab is shown must reach
 * the PTY after the resize the show performs, never before it.
 *
 * Showing a tab can change its grid (the WebGL renderer measures a different
 * cell than the DOM renderer a hidden tab draws with, and a container change
 * while hidden is fitted on show, #4858/#4863). xterm adopts the new grid at
 * once; the PTY only when the async `resize_terminal` invoke lands. Input sent
 * in between reached the shell at the old width, so readline laid the echoed
 * line out for the old grid and, on the wider one, its wrapped tail overwrote
 * the start of the line: the system tests saw a typed `echo` that "never
 * rendered" (MT-LOCAL-33 on macOS). The session input gate now holds input
 * from the show until the show-time fits ran and their resize was applied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { sendInput } from "@/services/api";
import { resetSessionInputGatesForTests } from "@/services/sessionInputGate";
import { RESIZE_REDRAW_QUIET_MS, RESIZE_REDRAW_WAIT_MS } from "./shellRedrawWait";

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
    /** The terminal's onData listener: what a keystroke in xterm calls. */
    onData: null as null | ((data: string) => void),
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
    onData = vi.fn((cb: (data: string) => void) => {
      h.state.onData = cb;
      return { dispose: vi.fn() };
    });
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

// The real `sendInput` / `resizeTerminal` wrappers run, so the session input
// gate between them is the production one; only the Tauri IPC is faked. Each
// `resize_terminal` invoke stays pending until the test applies it, like a PTY
// resize still on its way to the backend.
const ipc = vi.hoisted(() => ({
  log: [] as string[],
  pendingResizes: [] as Array<() => void>,
  /** The terminal's output subscription: what the shell's output reaches. */
  emitOutput: null as null | ((data: Uint8Array) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "resize_terminal") {
      ipc.log.push(`resize ${String(args?.cols)}x${String(args?.rows)}`);
      return new Promise<void>((resolve) => {
        ipc.pendingResizes.push(() => {
          ipc.log.push(`resized ${String(args?.cols)}x${String(args?.rows)}`);
          resolve();
        });
      });
    }
    if (cmd === "send_input") {
      ipc.log.push(`input ${JSON.stringify(args?.data)}`);
    }
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  createTerminal: vi.fn().mockResolvedValue("session-swap"),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn((_sessionId: string, cb: (data: Uint8Array) => void) => {
      ipc.emitOutput = cb;
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

/** Let promise continuations (the gate's queued sends, the resize pump) run. */
async function drainMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Apply every resize invoke still on its way to the backend. */
/** Apply every resize invoke still on its way to the backend, nothing more. */
async function applyResizesOnly() {
  while (ipc.pendingResizes.length > 0) {
    ipc.pendingResizes.shift()?.();
    await drainMicrotasks();
  }
}

/** The shell redraws for a resize: one output chunk, then the quiet period passes. */
async function shellRedraws() {
  act(() => ipc.emitOutput?.(new TextEncoder().encode("\r$ ")));
  await act(async () => {
    await new Promise((r) => setTimeout(r, RESIZE_REDRAW_QUIET_MS + 10));
  });
}

/** Apply every pending resize and let the shell redraw for it, like a real PTY. */
async function applyPendingResizes() {
  const applied = ipc.pendingResizes.length > 0;
  await applyResizesOnly();
  if (applied) await shellRedraws();
}

/** Run pending frames, then apply the resizes they sent. */
async function settle() {
  act(() => flushRaf());
  await drainMicrotasks();
  await applyPendingResizes();
}

/** Mount visible, connect, settle on the WebGL grid, then clear the IPC log. */
async function mountConnected() {
  renderTerminal(true);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await settle();
  ipc.log.length = 0;
}

/** Simulate the container being laid out at a new size. */
function resizeContainer(width: number, height: number) {
  h.state.containerWidth = width;
  h.state.containerHeight = height;
  const entry = { contentRect: { width, height } } as ResizeObserverEntry;
  act(() => h.resizeObserverCallbacks.forEach((cb) => cb([entry])));
}

/** Hide the tab (off screen only, so showing it runs no synchronous fit). */
async function hideAndResizeWhileHidden() {
  renderTerminal(true, false);
  await settle();
  resizeContainer(800, 600);
  await settle();
  expect(ipc.log).toEqual([]);
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
  h.state.onData = null;
  h.webglInstances.length = 0;
  h.resizeObserverCallbacks.length = 0;
  ipc.log.length = 0;
  ipc.pendingResizes.length = 0;
  ipc.emitOutput = null;
  resetSessionInputGatesForTests();

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

describe("input typed right after a tab is shown (#4942)", () => {
  it("reaches the PTY only after the show-time resize was applied", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    // Shown, and the test bridge types into it at once — before the frame that
    // runs the deferred fit.
    renderTerminal(true, true);
    let sent = false;
    const typed = sendInput("session-swap", "echo PERF05-05\n").then(() => {
      sent = true;
    });
    await drainMicrotasks();
    expect(ipc.log).toEqual([]);

    // The frame fits the shown grid; its resize is in flight, input still waits.
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30"]);
    expect(sent).toBe(false);

    // Applied: now the input goes out, after the size it was typed at.
    await applyPendingResizes();
    await typed;
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30", 'input "echo PERF05-05\\n"']);
  });

  it("orders a keystroke typed in xterm behind an in-flight resize", async () => {
    await mountConnected();

    resizeContainer(800, 480);
    expect(ipc.log).toEqual(["resize 100x24"]);

    act(() => h.state.onData?.("x"));
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x24"]);

    await applyPendingResizes();
    expect(ipc.log).toEqual(["resize 100x24", "resized 100x24", 'input "x"']);
  });

  it("keeps input in typing order while it is held", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    renderTerminal(true, true);
    act(() => h.state.onData?.("a"));
    void sendInput("session-swap", "b");
    act(() => h.state.onData?.("c"));
    await settle();

    expect(ipc.log.filter((e) => e.startsWith("input"))).toEqual([
      'input "a"',
      'input "b"',
      'input "c"',
    ]);
  });

  it("sends input on the next frame when showing changes nothing", async () => {
    await mountConnected();
    renderTerminal(true, false);
    await settle();

    renderTerminal(true, true);
    void sendInput("session-swap", "ls\n");
    await drainMicrotasks();
    expect(ipc.log).toEqual([]);

    act(() => flushRaf());
    await drainMicrotasks();
    // Same grid: no resize, and the input is not held past the show frame.
    expect(ipc.log).toEqual(['input "ls\\n"']);
  });

  it("releases held input when the tab is hidden again before the show frame", async () => {
    await mountConnected();
    renderTerminal(true, false);
    await settle();

    renderTerminal(true, true);
    void sendInput("session-swap", "q");
    renderTerminal(true, false);
    await drainMicrotasks();

    expect(ipc.log).toEqual(['input "q"']);
  });

  it("waits for a show-time resize that lands frames later (panel laid out late)", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    // Shown into a panel that is not laid out yet: the show frame cannot fit.
    h.state.containerWidth = 0;
    h.state.containerHeight = 0;
    renderTerminal(true, true);
    void sendInput("session-swap", "echo PERF05-26\n");
    act(() => flushRaf());
    await drainMicrotasks();
    act(() => flushRaf());
    await drainMicrotasks();
    // Still nothing on the wire: the grid the tab will show is not known yet.
    expect(ipc.log).toEqual([]);

    // The panel reaches its size; the ResizeObserver fit resizes the PTY, and
    // only once that is applied does the input go out.
    resizeContainer(800, 600);
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30"]);
    await applyPendingResizes();
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30", 'input "echo PERF05-26\\n"']);
  });

  it("waits while the shown grid still differs from what a fit proposes", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    // A fit is owed (the container changed while hidden) but the frame that
    // would run it has not come yet: two frames pass with the deferred fit
    // swallowed, as when the element is still parked at show time.
    const fitSpy = vi.spyOn(h.state.xterm as { resize: (c: number, r: number) => void }, "resize");
    fitSpy.mockImplementation(() => undefined);
    renderTerminal(true, true);
    void sendInput("session-swap", "late\n");
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual([]);

    // The owed fit finally applies (here through a ResizeObserver pass).
    fitSpy.mockRestore();
    resizeContainer(800, 600);
    await applyPendingResizes();
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30", 'input "late\\n"']);
  });

  it("holds input after the resize is applied until the shell redrew for it (#4958)", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    renderTerminal(true, true);
    void sendInput("session-swap", "echo PERF05-16\n");
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30"]);

    // Applied, but bash has not handled SIGWINCH yet (no redraw output): input
    // sent now would be echoed and then wiped by that redraw.
    await applyResizesOnly();
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30"]);

    // The redraw arrives: after its quiet period the input goes out.
    await shellRedraws();
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30", 'input "echo PERF05-16\\n"']);
  });

  it("releases input after a bounded wait when the shell never redraws", async () => {
    await mountConnected();
    await hideAndResizeWhileHidden();

    renderTerminal(true, true);
    void sendInput("session-swap", "quiet\n");
    act(() => flushRaf());
    await drainMicrotasks();
    await applyResizesOnly();
    act(() => flushRaf());
    await drainMicrotasks();
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30"]);

    await act(async () => {
      await new Promise((r) => setTimeout(r, RESIZE_REDRAW_WAIT_MS + 20));
    });
    expect(ipc.log).toEqual(["resize 100x30", "resized 100x30", 'input "quiet\\n"']);
  });
});
