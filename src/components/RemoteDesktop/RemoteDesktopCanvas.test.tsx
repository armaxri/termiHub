import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { installCanvas2DStub, type CanvasStubHandle } from "@/test/canvasMock";
import { RemoteDesktopCanvas } from "./RemoteDesktopCanvas";
import { MAX_FRAMEBUFFER_DIMENSION } from "@/types/remoteDesktop";
import type {
  RemoteDesktopFramePayload,
  RemoteDesktopCursorPayload,
  RemoteDesktopInput,
  ScaleMode,
} from "@/types/remoteDesktop";

// The canvas subscribes to the frame + cursor event feeds on mount. Mock the
// events module so each test can capture the registered callbacks and drive
// synthetic frames/cursor updates through the component's real paint pipeline.
let frameCb: ((payload: RemoteDesktopFramePayload) => void) | null = null;
let cursorCb: ((payload: RemoteDesktopCursorPayload) => void) | null = null;
const frameUnlisten = vi.fn();
const cursorUnlisten = vi.fn();

vi.mock("@/services/events", () => ({
  onRemoteDesktopFrame: vi.fn((cb: (payload: RemoteDesktopFramePayload) => void) => {
    frameCb = cb;
    return Promise.resolve(frameUnlisten);
  }),
  onRemoteDesktopCursor: vi.fn((cb: (payload: RemoteDesktopCursorPayload) => void) => {
    cursorCb = cb;
    return Promise.resolve(cursorUnlisten);
  }),
}));

const SESSION = "sess-1";

interface RenderOptions {
  sessionId: string;
  scaleMode: ScaleMode;
  viewOnly: boolean;
  onInput: (event: RemoteDesktopInput) => void;
  onResize: (width: number, height: number) => void;
  onDimensions: (width: number, height: number) => void;
  onFirstFrame: () => void;
  onReleaseAll: () => void;
}

let container: HTMLDivElement;
let root: Root;
let canvasStub: CanvasStubHandle;

function render(overrides: Partial<RenderOptions> = {}): {
  onInput: ReturnType<typeof vi.fn>;
  onResize: ReturnType<typeof vi.fn>;
  onDimensions: ReturnType<typeof vi.fn>;
  onFirstFrame: ReturnType<typeof vi.fn>;
} {
  const onInput = vi.fn();
  const onResize = vi.fn();
  const onDimensions = vi.fn();
  const onFirstFrame = vi.fn();
  const props = {
    sessionId: SESSION,
    scaleMode: "pixel" as ScaleMode,
    viewOnly: false,
    onInput,
    onResize,
    onDimensions,
    onFirstFrame,
    ...overrides,
  };
  act(() => {
    root.render(<RemoteDesktopCanvas {...props} />);
  });
  return { onInput, onResize, onDimensions, onFirstFrame };
}

function canvasEl(): HTMLCanvasElement {
  const el = container.querySelector<HTMLCanvasElement>('[data-testid="remote-desktop-canvas"]');
  if (!el) throw new Error("canvas not rendered");
  return el;
}

function surfaceEl(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".rd-canvas");
  if (!el) throw new Error("container not rendered");
  return el;
}

/** Give the (jsdom-zero-sized) container a real client box for scaled modes. */
function setContainerSize(width: number, height: number): void {
  const el = surfaceEl();
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
}

/** A single-rect full-frame update at (width × height). */
function makeFrame(width: number, height: number, sessionId = SESSION): RemoteDesktopFramePayload {
  return {
    session_id: sessionId,
    width,
    height,
    rects: [
      {
        x: 0,
        y: 0,
        width,
        height,
        data: new Array<number>(width * height * 4).fill(0),
      },
    ],
  };
}

function emitFrame(payload: RemoteDesktopFramePayload): void {
  act(() => frameCb?.(payload));
}

function emitCursor(payload: RemoteDesktopCursorPayload): void {
  act(() => cursorCb?.(payload));
}

describe("RemoteDesktopCanvas", () => {
  beforeEach(() => {
    frameCb = null;
    cursorCb = null;
    canvasStub = installCanvas2DStub();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    canvasStub.restore();
  });

  it("renders the canvas surface with its testid and scale-mode class", () => {
    render({ scaleMode: "fit" });
    const canvas = canvasEl();
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.className).toContain("rd-canvas__surface");
    expect(surfaceEl().className).toContain("rd-canvas--fit");
  });

  it("subscribes to the frame and cursor feeds once on mount", () => {
    render();
    // The mock records callbacks synchronously as the mount effect runs.
    expect(frameCb).toBeTypeOf("function");
    expect(cursorCb).toBeTypeOf("function");
  });

  it("paints the first frame: reports dimensions, blits the framebuffer, fires onFirstFrame", () => {
    const { onDimensions, onFirstFrame } = render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));

    expect(onDimensions).toHaveBeenCalledWith(100, 50);
    expect(onFirstFrame).toHaveBeenCalledOnce();

    const ctx = canvasStub.contextFor(canvasEl());
    // Pixel mode sizes the visible canvas to the framebuffer.
    expect(canvasEl().width).toBe(100);
    expect(canvasEl().height).toBe(50);
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalledOnce();

    // The blit source is the offscreen framebuffer canvas, sized to the frame,
    // into which the dirty rect was putImageData'd.
    const fb = ctx.drawImage.mock.calls[0][0] as HTMLCanvasElement;
    expect(fb.width).toBe(100);
    expect(fb.height).toBe(50);
    expect(canvasStub.contextFor(fb).putImageData).toHaveBeenCalledOnce();
  });

  it("fires onFirstFrame only once and onDimensions only when the size changes", () => {
    const { onDimensions, onFirstFrame } = render();
    emitFrame(makeFrame(100, 50));
    emitFrame(makeFrame(100, 50));
    expect(onFirstFrame).toHaveBeenCalledOnce();
    expect(onDimensions).toHaveBeenCalledOnce();

    emitFrame(makeFrame(120, 60));
    expect(onDimensions).toHaveBeenCalledTimes(2);
    expect(onDimensions).toHaveBeenLastCalledWith(120, 60);
    expect(onFirstFrame).toHaveBeenCalledOnce();
  });

  it("ignores frames for a different session id", () => {
    const { onDimensions } = render();
    emitFrame(makeFrame(100, 50, "other-session"));
    expect(onDimensions).not.toHaveBeenCalled();
    // Nothing was painted onto the visible canvas.
    expect(canvasStub.contextFor(canvasEl()).drawImage).not.toHaveBeenCalled();
  });

  // MOCK-011: the backend frame pump enforces the shared bound, but the canvas
  // must not trust the wire either — it sizes an offscreen canvas from these.
  it("ignores a frame whose framebuffer exceeds the shared cap without resizing", () => {
    const { onDimensions, onFirstFrame } = render();
    emitFrame({
      session_id: SESSION,
      width: MAX_FRAMEBUFFER_DIMENSION + 1,
      height: 65_535,
      rects: [],
    });
    expect(onDimensions).not.toHaveBeenCalled();
    expect(onFirstFrame).not.toHaveBeenCalled();
    expect(canvasStub.contextFor(canvasEl()).drawImage).not.toHaveBeenCalled();
  });

  it("ignores a zero-sized framebuffer", () => {
    const { onDimensions } = render();
    emitFrame({ session_id: SESSION, width: 0, height: 50, rects: [] });
    expect(onDimensions).not.toHaveBeenCalled();
  });

  it("skips dirty rects that fall outside the framebuffer or are malformed", () => {
    render({ scaleMode: "pixel" });
    const inBounds = { x: 0, y: 0, width: 2, height: 2, data: new Array<number>(16).fill(0) };
    emitFrame({
      session_id: SESSION,
      width: 10,
      height: 10,
      rects: [
        // Spills past the right/bottom edge.
        { x: 9, y: 9, width: 2, height: 2, data: new Array<number>(16).fill(0) },
        // Wrong byte length.
        { x: 0, y: 0, width: 2, height: 2, data: new Array<number>(15).fill(0) },
        // Zero-sized.
        { x: 0, y: 0, width: 0, height: 2, data: [] },
        inBounds,
      ],
    });
    const fb = canvasStub.contextFor(canvasEl()).drawImage.mock.calls[0][0] as HTMLCanvasElement;
    const put = canvasStub.contextFor(fb).putImageData;
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0].slice(1)).toEqual([0, 0]);
  });

  it("fit mode scales uniformly and letterboxes into the container", () => {
    render({ scaleMode: "fit" });
    setContainerSize(200, 100);
    emitFrame(makeFrame(100, 50));

    const canvas = canvasEl();
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    // s = min(200/100, 100/50) = 2 → 100×50 drawn at 200×100, centered (no bars).
    expect(canvasStub.contextFor(canvas).drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      0,
      0,
      100,
      50,
      0,
      0,
      200,
      100
    );
  });

  it("match mode stretches the framebuffer to fill the container", () => {
    render({ scaleMode: "match" });
    setContainerSize(300, 200);
    emitFrame(makeFrame(100, 50));

    const canvas = canvasEl();
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(200);
    // scaleX = 300/100 = 3, scaleY = 200/50 = 4 → dest 300×200 at origin.
    expect(canvasStub.contextFor(canvas).drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      0,
      0,
      100,
      50,
      0,
      0,
      300,
      200
    );
  });

  it("draws the synthetic cursor marker when visible", () => {
    render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    emitCursor({ session_id: SESSION, x: 10, y: 20, visible: true });
    // Cursor is drawn during a repaint, so drive a second frame.
    emitFrame(makeFrame(100, 50));

    const ctx = canvasStub.contextFor(canvasEl());
    expect(ctx.beginPath).toHaveBeenCalled();
    // Pixel mode: drawX/drawY = 0, scale = 1 → marker centered on (10, 20).
    expect(ctx.arc).toHaveBeenCalledWith(10, 20, 4, 0, Math.PI * 2);
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("ignores cursor updates for a different session id", () => {
    render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    emitCursor({ session_id: "other", x: 10, y: 20, visible: true });
    emitFrame(makeFrame(100, 50));
    // No cursor was drawn.
    expect(canvasStub.contextFor(canvasEl()).arc).not.toHaveBeenCalled();
  });

  it("forwards a reverse-scaled pointer event", () => {
    const { onInput } = render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    act(() => {
      canvasEl().dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 20, buttons: 1 })
      );
    });
    expect(onInput).toHaveBeenCalledWith({ kind: "pointer", x: 10, y: 20, buttons: 1 });
  });

  it("drops pointer positions that fall outside the framebuffer", () => {
    const { onInput } = render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    act(() => {
      canvasEl().dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 500, buttons: 1 })
      );
    });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("forwards wheel events reverse-scaled to framebuffer pixels", () => {
    const { onInput } = render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    act(() => {
      canvasEl().dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, clientX: 10, clientY: 20, deltaX: 4, deltaY: -3 })
      );
    });
    expect(onInput).toHaveBeenCalledWith({
      kind: "wheel",
      x: 10,
      y: 20,
      deltaX: 4,
      deltaY: -3,
    });
  });

  it("forwards key down/up events", () => {
    const { onInput } = render();
    act(() => {
      canvasEl().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyA" }));
    });
    expect(onInput).toHaveBeenCalledWith({ kind: "key", code: "KeyA", pressed: true });
    act(() => {
      canvasEl().dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, code: "KeyA" }));
    });
    expect(onInput).toHaveBeenCalledWith({ kind: "key", code: "KeyA", pressed: false });
  });

  it("does not forward input while view-only", () => {
    const { onInput } = render({ viewOnly: true, scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    act(() => {
      canvasEl().dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 20, buttons: 1 })
      );
      canvasEl().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyA" }));
    });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("Ctrl+Alt+Shift releases held keys and does not forward the escape combo", () => {
    const { onInput } = render();
    // Hold a key, then trigger the focus-release escape hatch.
    act(() => {
      canvasEl().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyA" }));
    });
    onInput.mockClear();
    act(() => {
      canvasEl().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          code: "ShiftLeft",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        })
      );
    });
    // The previously-held key is released; the escape combo itself is not sent.
    expect(onInput).toHaveBeenCalledWith({ kind: "key", code: "KeyA", pressed: false });
    expect(onInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "key", code: "ShiftLeft" })
    );
  });

  describe("releases held input on focus loss (#3402)", () => {
    function holdKeyAndButton(): void {
      emitFrame(makeFrame(100, 50));
      act(() => {
        canvasEl().focus();
        canvasEl().dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, code: "ShiftLeft" })
        );
        canvasEl().dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 20, buttons: 1 })
        );
      });
    }

    it("canvas blur asks the backend to release everything instead of per-key ups", () => {
      const onReleaseAll = vi.fn();
      const { onInput } = render({ onReleaseAll });
      holdKeyAndButton();
      onInput.mockClear();
      act(() => canvasEl().blur());
      expect(onReleaseAll).toHaveBeenCalledTimes(1);
      expect(onInput).not.toHaveBeenCalled();
    });

    it("window blur releases while the canvas is focused or holds input", () => {
      const onReleaseAll = vi.fn();
      render({ onReleaseAll });
      holdKeyAndButton();
      act(() => {
        window.dispatchEvent(new FocusEvent("blur"));
      });
      expect(onReleaseAll).toHaveBeenCalled();
    });

    it("the document turning hidden releases held input", () => {
      const onReleaseAll = vi.fn();
      render({ onReleaseAll });
      holdKeyAndButton();
      onReleaseAll.mockClear();
      const prev = Object.getOwnPropertyDescriptor(document, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      try {
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
      } finally {
        if (prev) Object.defineProperty(document, "visibilityState", prev);
        else delete (document as { visibilityState?: string }).visibilityState;
      }
      expect(onReleaseAll).toHaveBeenCalledTimes(1);
    });

    it("an idle, unfocused canvas sends nothing on window blur", () => {
      const onReleaseAll = vi.fn();
      render({ onReleaseAll });
      act(() => {
        window.dispatchEvent(new FocusEvent("blur"));
      });
      expect(onReleaseAll).not.toHaveBeenCalled();
    });

    it("a view-only (evicted) canvas never sends a release", () => {
      const onReleaseAll = vi.fn();
      const { onInput } = render({ onReleaseAll, viewOnly: true });
      holdKeyAndButton();
      act(() => {
        canvasEl().blur();
        window.dispatchEvent(new FocusEvent("blur"));
      });
      expect(onReleaseAll).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
    });
  });

  it("requests a debounced resolution change on resize in match mode", () => {
    vi.useFakeTimers();
    let roCb: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const prevRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { onResize } = render({ scaleMode: "match" });
      setContainerSize(320, 240);
      act(() => roCb?.([], {} as ResizeObserver));
      // Debounced: nothing until the interval elapses.
      expect(onResize).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onResize).toHaveBeenCalledWith(320, 240);
    } finally {
      globalThis.ResizeObserver = prevRO;
      vi.useRealTimers();
    }
  });

  it("does not request a resolution change on resize outside match mode", () => {
    vi.useFakeTimers();
    let roCb: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const prevRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { onResize } = render({ scaleMode: "fit" });
      setContainerSize(320, 240);
      act(() => roCb?.([], {} as ResizeObserver));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onResize).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = prevRO;
      vi.useRealTimers();
    }
  });

  it("unsubscribes from the frame and cursor feeds on unmount", async () => {
    render();
    // Let the subscription promises settle so the unlisteners are registered.
    await flushAsync();
    act(() => root.unmount());
    expect(frameUnlisten).toHaveBeenCalled();
    expect(cursorUnlisten).toHaveBeenCalled();
    // Re-mount so afterEach's unmount call remains valid.
    root = createRoot(container);
  });
});
