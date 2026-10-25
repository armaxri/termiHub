/**
 * The `measureTerminal` / `loseTerminalWebglContext` bridge verbs (#2988) and
 * `readTerminalWebglFrame` (#4970): the
 * dispatcher routing, and the helpers in `terminalRender.ts` driven against a
 * real xterm under jsdom. jsdom cannot lay out or paint, so these pin the
 * shape and the jsdom-reachable values; the real measurements are asserted by
 * `tests/system/tests/test_xterm_render_paths.py` in the nightly lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import {
  loseTerminalWebglContext,
  measureTerminal,
  readTerminalWebglFrame,
  WEBGL_READBACK_TIMEOUT_MS,
} from "./terminalRender";
import type { TerminalMeasurement, TerminalWebglFrame } from "./protocol";
import type { TerminalHandles } from "@/components/Terminal/TerminalRegistry";

/** Inert deps; the verbs under test and the active tab come from the caller. */
function depsWith(overrides: Partial<BridgeDeps>): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: async () => {},
    ...overrides,
  };
}

const MEASUREMENT: TerminalMeasurement = {
  grid: { cols: 80, rows: 24 },
  proposed: { cols: 80, rows: 24 },
  cell: { width: 7.8, height: 17 },
  container: { width: 640, height: 420 },
  renderer: "webgl",
  webglCanvas: { width: 1248, height: 816 },
  domRows: null,
  scrollbar: {
    trackHeight: 420,
    thumbVisible: false,
    thumbHeight: 0,
    thumbTop: 0,
    gutterLeft: 628,
    gutterWidth: 12,
    thumbLeft: 0,
    thumbWidth: 0,
    thumbColor: "rgba(121, 121, 121, 0.5)",
  },
  paint: {
    textRight: 624,
    rowsBottom: 408,
    containerBackground: "rgb(15, 17, 23)",
    themeBackground: "#0f1117",
    horizontalScroll: false,
    viewportClientBottom: 420,
    hscrollBarHeight: 0,
  },
  screenRect: { left: 260, top: 80, width: 624, height: 408 },
  page: { devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800 },
  decorations: [],
  viewportY: 0,
  baseY: 0,
};

describe("dispatchCommand measureTerminal", () => {
  it("measures the active terminal", async () => {
    const deps = depsWith({
      getActiveTabId: () => "tab-1",
      measureTerminal: (tabId) => (tabId === "tab-1" ? MEASUREMENT : undefined),
    });
    const res = await dispatchCommand({ action: "measureTerminal" }, deps);
    expect(res).toEqual({ ok: true, action: "measureTerminal", value: MEASUREMENT });
  });

  it("measures an explicit tabId", async () => {
    const deps = depsWith({
      measureTerminal: (tabId) => (tabId === "tab-9" ? MEASUREMENT : undefined),
    });
    const res = await dispatchCommand({ action: "measureTerminal", tabId: "tab-9" }, deps);
    expect(res.value).toEqual(MEASUREMENT);
  });

  it("fails when there is no active terminal", async () => {
    const deps = depsWith({ measureTerminal: () => MEASUREMENT });
    const res = await dispatchCommand({ action: "measureTerminal" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no active terminal/);
  });

  it("fails when no terminal is registered for the tab", async () => {
    const deps = depsWith({ measureTerminal: () => undefined });
    const res = await dispatchCommand({ action: "measureTerminal", tabId: "ghost" }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no terminal registered for tab "ghost"/);
  });

  it("fails clearly when the dependency is absent", async () => {
    const res = await dispatchCommand({ action: "measureTerminal", tabId: "t" }, depsWith({}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available/);
  });
});

describe("dispatchCommand loseTerminalWebglContext", () => {
  it("answers whether a context was lost on the active terminal", async () => {
    const lose = vi.fn((tabId: string) => (tabId === "tab-1" ? true : undefined));
    const deps = depsWith({ getActiveTabId: () => "tab-1", loseTerminalWebglContext: lose });
    const res = await dispatchCommand({ action: "loseTerminalWebglContext" }, deps);
    expect(res).toEqual({ ok: true, action: "loseTerminalWebglContext", value: true });
    expect(lose).toHaveBeenCalledWith("tab-1");
  });

  it("passes false through when the terminal has no WebGL context", async () => {
    const deps = depsWith({ loseTerminalWebglContext: () => false });
    const res = await dispatchCommand({ action: "loseTerminalWebglContext", tabId: "t" }, deps);
    expect(res).toEqual({ ok: true, action: "loseTerminalWebglContext", value: false });
  });

  it("fails when no terminal is registered, none is active, or the dep is absent", async () => {
    const ghost = await dispatchCommand(
      { action: "loseTerminalWebglContext", tabId: "ghost" },
      depsWith({ loseTerminalWebglContext: () => undefined })
    );
    expect(ghost.error).toMatch(/no terminal registered for tab "ghost"/);
    const inactive = await dispatchCommand(
      { action: "loseTerminalWebglContext" },
      depsWith({ loseTerminalWebglContext: () => true })
    );
    expect(inactive.error).toMatch(/no active terminal/);
    const absent = await dispatchCommand(
      { action: "loseTerminalWebglContext", tabId: "t" },
      depsWith({})
    );
    expect(absent.error).toMatch(/not available/);
  });
});

const FRAME: TerminalWebglFrame = { width: 2, height: 1, devicePixelRatio: 1, rgb: "/wAAAAD/" };

describe("dispatchCommand readTerminalWebglFrame", () => {
  it("reads the active terminal's frame", async () => {
    const read = vi.fn(async () => FRAME);
    const deps = depsWith({ getActiveTabId: () => "tab-1", readTerminalWebglFrame: read });
    const res = await dispatchCommand({ action: "readTerminalWebglFrame" }, deps);
    expect(res).toEqual({ ok: true, action: "readTerminalWebglFrame", value: FRAME });
    expect(read).toHaveBeenCalledWith("tab-1");
  });

  it("answers null on the DOM renderer", async () => {
    const deps = depsWith({ readTerminalWebglFrame: async () => null });
    const res = await dispatchCommand({ action: "readTerminalWebglFrame", tabId: "t" }, deps);
    expect(res).toEqual({ ok: true, action: "readTerminalWebglFrame", value: null });
  });

  it("fails on no active terminal, an unknown tab, a rejected read or no dependency", async () => {
    const none = await dispatchCommand(
      { action: "readTerminalWebglFrame" },
      depsWith({ readTerminalWebglFrame: async () => FRAME })
    );
    expect(none.error).toMatch(/no active terminal/);
    const ghost = await dispatchCommand(
      { action: "readTerminalWebglFrame", tabId: "ghost" },
      depsWith({ readTerminalWebglFrame: () => undefined })
    );
    expect(ghost.error).toMatch(/no terminal registered for tab "ghost"/);
    const rejected = await dispatchCommand(
      { action: "readTerminalWebglFrame", tabId: "t" },
      depsWith({ readTerminalWebglFrame: () => Promise.reject(new Error("no animation frame")) })
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no animation frame/),
    });
    const absent = await dispatchCommand(
      { action: "readTerminalWebglFrame", tabId: "t" },
      depsWith({})
    );
    expect(absent.error).toMatch(/not available/);
  });
});

describe("terminalRender helpers against a real xterm (jsdom)", () => {
  let term: XTerm;
  let fitAddon: FitAddon;
  let handles: TerminalHandles;

  beforeEach(() => {
    // Mirror the container Terminal.tsx builds: renderer marker, the viewport
    // xterm opens into, and the gutter + thumb the scrollbar controller drives.
    const element = document.createElement("div");
    element.dataset.terminalRenderer = "dom";
    const viewport = document.createElement("div");
    viewport.className = "terminal-scroll-viewport";
    element.appendChild(viewport);
    const gutter = document.createElement("div");
    gutter.className = "terminal-vscroll-gutter";
    const thumb = document.createElement("div");
    thumb.className = "terminal-vscroll-thumb";
    gutter.appendChild(thumb);
    element.appendChild(gutter);
    document.body.appendChild(element);

    term = new XTerm({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      theme: { background: "#0f1117" },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(viewport);
    handles = { element, xterm: term, fitAddon };
  });

  afterEach(() => {
    // The readback tests spy on prototypes and window, not just this terminal.
    vi.restoreAllMocks();
    term.dispose();
    handles.element.remove();
  });

  it("reports the grid, renderer and the jsdom measurement gap", () => {
    const m = measureTerminal(handles);
    expect(m.grid).toEqual({ cols: 80, rows: 24 });
    expect(m.renderer).toBe("dom");
    // No layout engine: FitAddon cannot propose and the cell is unmeasured.
    // The E2E suite asserts these are real and positive in a WebView.
    expect(m.proposed).toBeNull();
    expect(m.cell.width).toBe(0);
    expect(typeof m.cell.height).toBe("number");
    expect(m.webglCanvas).toBeNull();
    expect(m.viewportY).toBe(0);
    expect(m.baseY).toBe(0);
  });

  it("reads the DOM renderer's row container", () => {
    const rows = measureTerminal(handles).domRows;
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(24);
  });

  it("reads a hidden thumb as not visible and a shown one with its geometry", () => {
    const thumb = handles.element.querySelector<HTMLElement>(".terminal-vscroll-thumb")!;
    // Before the scrollbar controller has run (or with no scrollback) it is hidden.
    expect(measureTerminal(handles).scrollbar).toMatchObject({
      trackHeight: 0,
      thumbVisible: false,
      thumbHeight: 0,
      thumbTop: 0,
      thumbLeft: 0,
      thumbWidth: 0,
    });
    thumb.style.display = "none";
    expect(measureTerminal(handles).scrollbar?.thumbVisible).toBe(false);
    thumb.style.display = "block";
    expect(measureTerminal(handles).scrollbar?.thumbVisible).toBe(true);
  });

  it("reads the thumb's computed colour", () => {
    const thumb = handles.element.querySelector<HTMLElement>(".terminal-vscroll-thumb")!;
    thumb.style.backgroundColor = "rgb(121, 121, 121)";
    expect(measureTerminal(handles).scrollbar?.thumbColor).toBe("rgb(121, 121, 121)");
  });

  it("reports the backgrounds behind the cells and the horizontal-scroll mode", () => {
    handles.element.style.backgroundColor = "rgb(15, 17, 23)";
    const paint = measureTerminal(handles).paint;
    expect(paint.containerBackground).toBe("rgb(15, 17, 23)");
    expect(paint.themeBackground).toBe("#0f1117");
    expect(paint.horizontalScroll).toBe(false);
    expect(paint.hscrollBarHeight).toBe(0);
    // jsdom lays nothing out, so the edges are numbers but not meaningful here.
    expect(typeof paint.textRight).toBe("number");
    handles.element
      .querySelector(".terminal-scroll-viewport")!
      .classList.add("terminal-horizontal-scroll");
    expect(measureTerminal(handles).paint.horizontalScroll).toBe(true);
  });

  it("reads the painted ancestor's background when the element itself is transparent", () => {
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(1, 2, 3)";
    handles.element.replaceWith(host);
    host.appendChild(handles.element);
    expect(measureTerminal(handles).paint.containerBackground).toBe("rgb(1, 2, 3)");
    host.replaceWith(handles.element);
  });

  it("lists rendered decorations with their classes and colour", () => {
    expect(measureTerminal(handles).decorations).toEqual([]);
    const bar = document.createElement("div");
    bar.className = "xterm-decoration terminal-command-mark terminal-command-mark--failure";
    bar.style.backgroundColor = "rgb(255, 0, 0)";
    handles.element.querySelector(".xterm-screen")!.appendChild(bar);
    const [decoration] = measureTerminal(handles).decorations;
    expect(decoration.classes).toContain("terminal-command-mark--failure");
    expect(decoration.background).toBe("rgb(255, 0, 0)");
  });

  it("returns null for the scrollbar when the gutter is not mounted", () => {
    handles.element.querySelector(".terminal-vscroll-gutter")!.remove();
    expect(measureTerminal(handles).scrollbar).toBeNull();
  });

  it("reports the WebGL canvas backing size and ignores the image layer", () => {
    const screen = handles.element.querySelector(".xterm-screen")!;
    const image = document.createElement("canvas");
    image.classList.add("xterm-image-layer");
    screen.appendChild(image);
    expect(measureTerminal(handles).webglCanvas).toBeNull();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    screen.appendChild(canvas);
    expect(measureTerminal(handles).webglCanvas).toEqual({ width: 640, height: 480 });
  });

  it("loses a live WebGL2 context through WEBGL_lose_context", () => {
    const canvas = document.createElement("canvas");
    handles.element.querySelector(".xterm-screen")!.appendChild(canvas);
    const loseContext = vi.fn();
    const gl = {
      isContextLost: () => false,
      getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null),
    };
    const getContext = vi
      .spyOn(canvas, "getContext")
      .mockReturnValue(gl as unknown as WebGL2RenderingContext);
    expect(loseTerminalWebglContext(handles)).toBe(true);
    expect(getContext).toHaveBeenCalledWith("webgl2");
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("answers false when there is no WebGL canvas or its context is already lost", () => {
    expect(loseTerminalWebglContext(handles)).toBe(false);
    const canvas = document.createElement("canvas");
    handles.element.querySelector(".xterm-screen")!.appendChild(canvas);
    vi.spyOn(canvas, "getContext").mockReturnValue({
      isContextLost: () => true,
      getExtension: () => null,
    } as unknown as WebGL2RenderingContext);
    expect(loseTerminalWebglContext(handles)).toBe(false);
  });

  it("answers null from readTerminalWebglFrame on the DOM renderer", async () => {
    await expect(readTerminalWebglFrame(handles)).resolves.toBeNull();
  });

  it("copies the WebGL canvas as RGB in the frame after a forced repaint", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 1;
    handles.element.querySelector(".xterm-screen")!.appendChild(canvas);
    const order: string[] = [];
    vi.spyOn(term, "refresh").mockImplementation(() => order.push("refresh"));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      order.push("raf");
      frames.push(cb);
      return frames.length;
    });
    const drawImage = vi.fn(() => order.push("draw"));
    // Red then blue, fully opaque: alpha is dropped from the payload.
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      getImageData: () => ({ data }),
    } as unknown as CanvasRenderingContext2D);

    const pending = readTerminalWebglFrame(handles);
    expect(order).toEqual(["refresh", "raf"]);
    expect(drawImage).not.toHaveBeenCalled();
    frames[0](0);
    await expect(pending).resolves.toEqual({
      width: 2,
      height: 1,
      devicePixelRatio: window.devicePixelRatio,
      rgb: "/wAAAAD/",
    });
    expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0);
  });

  it("rejects readTerminalWebglFrame when no animation frame arrives", async () => {
    vi.useFakeTimers();
    try {
      handles.element.querySelector(".xterm-screen")!.appendChild(document.createElement("canvas"));
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
      const pending = readTerminalWebglFrame(handles);
      vi.advanceTimersByTime(WEBGL_READBACK_TIMEOUT_MS);
      await expect(pending).rejects.toThrow(/no animation frame/);
    } finally {
      vi.useRealTimers();
    }
  });
});
