/**
 * The `measureTerminal` / `loseTerminalWebglContext` bridge verbs (#2988): the
 * dispatcher routing, and the helpers in `terminalRender.ts` driven against a
 * real xterm under jsdom. jsdom cannot lay out or paint, so these pin the
 * shape and the jsdom-reachable values; the real measurements are asserted by
 * `tests/system/tests/test_xterm_render_paths.py` in the nightly lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import { loseTerminalWebglContext, measureTerminal } from "./terminalRender";
import type { TerminalMeasurement } from "./protocol";
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
  scrollbar: { trackHeight: 420, thumbVisible: false, thumbHeight: 0, thumbTop: 0 },
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
    element.appendChild(viewport);
    const gutter = document.createElement("div");
    gutter.className = "terminal-vscroll-gutter";
    const thumb = document.createElement("div");
    thumb.className = "terminal-vscroll-thumb";
    gutter.appendChild(thumb);
    element.appendChild(gutter);
    document.body.appendChild(element);

    term = new XTerm({ cols: 80, rows: 24, allowProposedApi: true });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(viewport);
    handles = { element, xterm: term, fitAddon };
  });

  afterEach(() => {
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
    expect(measureTerminal(handles).scrollbar).toEqual({
      trackHeight: 0,
      thumbVisible: false,
      thumbHeight: 0,
      thumbTop: 0,
    });
    thumb.style.display = "none";
    expect(measureTerminal(handles).scrollbar?.thumbVisible).toBe(false);
    thumb.style.display = "block";
    expect(measureTerminal(handles).scrollbar?.thumbVisible).toBe(true);
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
});
