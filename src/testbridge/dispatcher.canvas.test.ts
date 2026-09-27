import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/** Deps resolving `data-testid`s against `root`; every other dep is inert. */
function depsFor(root: ParentNode): BridgeDeps {
  return {
    root,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: async () => {},
  };
}

/** Mount a `width` x `height` canvas carrying `data-testid="rd"`. */
function mountCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-testid", "rd");
  canvas.width = width;
  canvas.height = height;
  document.body.appendChild(canvas);
  return canvas;
}

describe("dispatchCommand sampleCanvas", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the size and one RGBA tuple per point, in order", async () => {
    mountCanvas(40, 20);
    // jsdom has no 2D context: stub one whose pixel is derived from (x, y).
    const getImageData = vi.fn((x: number, y: number) => ({
      data: new Uint8ClampedArray([x, y, 7, 255]),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getImageData,
    } as unknown as CanvasRenderingContext2D);

    const res = await dispatchCommand(
      {
        action: "sampleCanvas",
        testId: "rd",
        points: [
          { x: 3, y: 4 },
          { x: 39, y: 19 },
        ],
      },
      depsFor(document)
    );

    expect(res).toEqual({
      ok: true,
      action: "sampleCanvas",
      value: {
        width: 40,
        height: 20,
        pixels: [
          [3, 4, 7, 255],
          [39, 19, 7, 255],
        ],
      },
    });
    expect(getImageData).toHaveBeenCalledWith(3, 4, 1, 1);
  });

  it("reads only the size when no points are given (no context needed)", async () => {
    mountCanvas(12, 8);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const res = await dispatchCommand({ action: "sampleCanvas", testId: "rd" }, depsFor(document));
    expect(res).toEqual({
      ok: true,
      action: "sampleCanvas",
      value: { width: 12, height: 8, pixels: [] },
    });
    expect(getContext).not.toHaveBeenCalled();
  });

  it("fails for a missing element", async () => {
    const res = await dispatchCommand(
      { action: "sampleCanvas", testId: "nope" },
      depsFor(document)
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no element with data-testid="nope"');
  });

  it("fails for an element that is not a canvas", async () => {
    document.body.innerHTML = `<div data-testid="rd"></div>`;
    const res = await dispatchCommand({ action: "sampleCanvas", testId: "rd" }, depsFor(document));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("is not a <canvas>");
  });

  it.each([
    { x: -1, y: 0 },
    { x: 0, y: 20 },
    { x: 40, y: 0 },
    { x: 1.5, y: 2 },
  ])("rejects the out-of-bounds or fractional point %o", async (point) => {
    mountCanvas(40, 20);
    const res = await dispatchCommand(
      { action: "sampleCanvas", testId: "rd", points: [point] },
      depsFor(document)
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("40x20 canvas");
  });

  it("fails cleanly when the canvas has no 2D context", async () => {
    mountCanvas(4, 4);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const res = await dispatchCommand(
      { action: "sampleCanvas", testId: "rd", points: [{ x: 0, y: 0 }] },
      depsFor(document)
    );
    expect(res).toEqual({
      ok: false,
      action: "sampleCanvas",
      error: 'canvas data-testid="rd" has no 2D context',
    });
  });

  it("surfaces a getImageData failure (e.g. a tainted canvas) as an error", async () => {
    mountCanvas(4, 4);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getImageData: () => {
        throw new Error("The canvas has been tainted");
      },
    } as unknown as CanvasRenderingContext2D);
    const res = await dispatchCommand(
      { action: "sampleCanvas", testId: "rd", points: [{ x: 0, y: 0 }] },
      depsFor(document)
    );
    expect(res).toEqual({
      ok: false,
      action: "sampleCanvas",
      error: "The canvas has been tainted",
    });
  });
});
