import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { installCanvas2DStub, type CanvasStubHandle } from "@/test/canvasMock";
import { RemoteDesktopCanvas } from "./RemoteDesktopCanvas";
import { subscribeRemoteDesktopFrames } from "@/services/remoteDesktopFrames";
import type {
  BinaryCursorShape,
  BinaryDirtyRect,
  RemoteDesktopFrameHandlers,
} from "@/services/remoteDesktopFrames";
import { remoteDesktopRequestFullFrame } from "@/services/api";
import { MAX_FRAMEBUFFER_DIMENSION } from "@/types/remoteDesktop";
import type { RemoteDesktopInput, ScaleMode } from "@/types/remoteDesktop";
import { RELEASE_CHORD_ACTION, clearOverrides, setOverride } from "@/services/keybindings";

/** A decoded frame addressed to a session, as the tests drive it. */
interface TestFrame {
  session_id: string;
  width: number;
  height: number;
  rects: BinaryDirtyRect[];
}

/** A decoded cursor update addressed to a session. */
interface TestCursor {
  session_id: string;
  x: number;
  y: number;
  visible: boolean;
  shape?: BinaryCursorShape;
}

// The canvas opens its session's binary frame channel on mount (#4291). Mock
// the channel module so each test can capture the registered handlers (and the
// session they were opened for) and drive decoded frames/cursor updates through
// the component's real paint pipeline.
let subscribedSession: string | null = null;
let handlers: RemoteDesktopFrameHandlers | null = null;
const frameUnsubscribe = vi.fn();

vi.mock("@/services/remoteDesktopFrames", () => ({
  subscribeRemoteDesktopFrames: vi.fn((sessionId: string, h: RemoteDesktopFrameHandlers) => {
    subscribedSession = sessionId;
    handlers = h;
    return Promise.resolve(frameUnsubscribe);
  }),
}));

vi.mock("@/services/api", () => ({
  remoteDesktopRequestFullFrame: vi.fn(() => Promise.resolve()),
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
  viewport: { x: number; y: number; width: number; height: number } | null;
  label: string;
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
function makeFrame(width: number, height: number, sessionId = SESSION): TestFrame {
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
        data: new Uint8ClampedArray(width * height * 4),
      },
    ],
  };
}

/** Deliver a frame on `session_id`'s channel (only the subscribed one is open). */
function emitFrame({ session_id, ...frame }: TestFrame): void {
  if (session_id !== subscribedSession) return;
  act(() => handlers?.onFrame({ kind: "frame", ...frame }));
}

/** Deliver a cursor update on `session_id`'s channel. */
function emitCursor({ session_id, ...cursor }: TestCursor): void {
  if (session_id !== subscribedSession) return;
  act(() => handlers?.onCursor({ kind: "cursor", ...cursor }));
}

describe("RemoteDesktopCanvas", () => {
  beforeEach(() => {
    subscribedSession = null;
    handlers = null;
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

  it("asks for a full frame once the frame feed is subscribed (#4017)", async () => {
    render();
    expect(remoteDesktopRequestFullFrame).not.toHaveBeenCalled();
    await flushAsync();
    expect(remoteDesktopRequestFullFrame).toHaveBeenCalledExactlyOnceWith(SESSION);
  });

  it("keeps one frame subscription across re-renders with new callbacks (#4017)", async () => {
    render();
    await flushAsync();
    const second = render();
    await flushAsync();
    // A re-subscription would drop the frames sent in between.
    expect(subscribeRemoteDesktopFrames).toHaveBeenCalledOnce();
    expect(frameUnsubscribe).not.toHaveBeenCalled();
    expect(remoteDesktopRequestFullFrame).toHaveBeenCalledOnce();
    // The latest onDimensions is the one notified.
    emitFrame(makeFrame(100, 50));
    expect(second.onDimensions).toHaveBeenCalledWith(100, 50);
  });

  it("opens its own session's frame channel once on mount", () => {
    render();
    // The mock records the handlers synchronously as the mount effect runs.
    expect(subscribedSession).toBe(SESSION);
    expect(handlers?.onFrame).toBeTypeOf("function");
    expect(handlers?.onCursor).toBeTypeOf("function");
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
    const inBounds = { x: 0, y: 0, width: 2, height: 2, data: new Uint8ClampedArray(16) };
    emitFrame({
      session_id: SESSION,
      width: 10,
      height: 10,
      rects: [
        // Spills past the right/bottom edge.
        { x: 9, y: 9, width: 2, height: 2, data: new Uint8ClampedArray(16) },
        // Wrong byte length.
        { x: 0, y: 0, width: 2, height: 2, data: new Uint8ClampedArray(15) },
        // Zero-sized.
        { x: 0, y: 0, width: 0, height: 2, data: new Uint8ClampedArray(0) },
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

  it("1:1 mode draws the framebuffer at native size regardless of the container", () => {
    // The other half of a fixed-resolution session's Fit ↔ 1:1 toggle
    // (PROD-026): the canvas is the framebuffer size and the container scrolls.
    render({ scaleMode: "pixel" });
    setContainerSize(200, 100);
    emitFrame(makeFrame(400, 300));

    const canvas = canvasEl();
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(canvasStub.contextFor(canvas).drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      0,
      0,
      400,
      300,
      0,
      0,
      400,
      300
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

  // #3333: the backend cursor pump strips invalid shapes, but the canvas must
  // not trust the wire either.
  it("keeps the cursor position when its shape is hostile", () => {
    render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    emitCursor({
      session_id: SESSION,
      x: 10,
      y: 20,
      visible: true,
      shape: {
        width: 65_535,
        height: 65_535,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8ClampedArray(0),
      },
    });
    emitFrame(makeFrame(100, 50));
    expect(canvasStub.contextFor(canvasEl()).arc).toHaveBeenCalledWith(10, 20, 4, 0, Math.PI * 2);
  });

  it("ignores a cursor update with a non-integral or negative position", () => {
    render({ scaleMode: "pixel" });
    emitFrame(makeFrame(100, 50));
    emitCursor({ session_id: SESSION, x: -1, y: 20, visible: true });
    emitCursor({ session_id: SESSION, x: Number.NaN, y: 20, visible: true });
    emitFrame(makeFrame(100, 50));
    expect(canvasStub.contextFor(canvasEl()).arc).not.toHaveBeenCalled();
  });

  describe("monitor viewport (#3696)", () => {
    const RIGHT = { x: 100, y: 0, width: 100, height: 50 };

    it("fit mode draws only the viewport's region of the framebuffer", () => {
      render({ scaleMode: "fit", viewport: RIGHT });
      setContainerSize(200, 100);
      emitFrame(makeFrame(200, 50));
      // The right-hand 100×50 monitor, scaled 2× into the 200×100 tab.
      expect(canvasStub.contextFor(canvasEl()).drawImage).toHaveBeenLastCalledWith(
        expect.any(HTMLCanvasElement),
        100,
        0,
        100,
        50,
        0,
        0,
        200,
        100
      );
    });

    it("maps pointer positions back into full-framebuffer coordinates", () => {
      const { onInput } = render({ scaleMode: "pixel", viewport: RIGHT });
      emitFrame(makeFrame(200, 50));
      expect(canvasEl().width).toBe(100);
      act(() => {
        canvasEl().dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 20, buttons: 1 })
        );
      });
      expect(onInput).toHaveBeenCalledWith({ kind: "pointer", x: 110, y: 20, buttons: 1 });
    });

    it("clamps a viewport that no longer fits the framebuffer", () => {
      render({ scaleMode: "pixel", viewport: { x: 150, y: 0, width: 400, height: 400 } });
      emitFrame(makeFrame(200, 50));
      const canvas = canvasEl();
      expect([canvas.width, canvas.height]).toEqual([50, 50]);
    });
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

  describe("accessibility: name, focus ring and disclosed release chord (#4328)", () => {
    function liveRegionText(): string {
      return (
        container.querySelector('[data-testid="remote-desktop-capture-announcer"]')?.textContent ??
        ""
      );
    }

    it("is an application with an accessible name naming the session", () => {
      render({ label: "office-pc" });
      const canvas = canvasEl();
      expect(canvas.getAttribute("role")).toBe("application");
      expect(canvas.getAttribute("aria-label")).toBe("Remote desktop: office-pc");
    });

    it("falls back to a generic name without a label", () => {
      render();
      expect(canvasEl().getAttribute("aria-label")).toBe("Remote desktop");
    });

    it("has a description that discloses the release chord", () => {
      render({ label: "office-pc" });
      const id = canvasEl().getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      const description = document.getElementById(id as string);
      expect(description?.textContent).toContain("Ctrl+Shift+Alt");
      expect(description?.textContent).toMatch(/return focus to termiHub/i);
    });

    it("applies the captured focus-ring class only while focused", () => {
      render();
      expect(canvasEl().classList.contains("rd-canvas__surface--captured")).toBe(false);
      act(() => canvasEl().focus());
      expect(canvasEl().classList.contains("rd-canvas__surface--captured")).toBe(true);
      expect(container.querySelector('[data-testid="remote-desktop-capture-hint"]')).not.toBeNull();
      act(() => canvasEl().blur());
      expect(canvasEl().classList.contains("rd-canvas__surface--captured")).toBe(false);
      expect(container.querySelector('[data-testid="remote-desktop-capture-hint"]')).toBeNull();
    });

    it("the chord returns focus to the app", () => {
      render();
      act(() => canvasEl().focus());
      expect(document.activeElement).toBe(canvasEl());
      act(() => {
        canvasEl().dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            code: "AltLeft",
            ctrlKey: true,
            altKey: true,
            shiftKey: true,
          })
        );
      });
      expect(document.activeElement).not.toBe(canvasEl());
      expect(canvasEl().classList.contains("rd-canvas__surface--captured")).toBe(false);
    });

    it("announces capture and release through a polite live region", () => {
      render();
      const region = container.querySelector('[data-testid="remote-desktop-capture-announcer"]');
      expect(region?.getAttribute("aria-live")).toBe("polite");
      expect(liveRegionText()).toBe("");
      act(() => canvasEl().focus());
      expect(liveRegionText()).toBe("Keyboard captured — press Ctrl+Shift+Alt to release");
      act(() => canvasEl().blur());
      expect(liveRegionText()).toBe("Keyboard released to termiHub");
    });
  });

  describe("rebound release chord (#4524)", () => {
    afterEach(() => clearOverrides());

    function pressChord(init: KeyboardEventInit): void {
      act(() => {
        canvasEl().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      });
    }

    it("releases focus on the custom chord", () => {
      setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, meta: true });
      render();
      act(() => canvasEl().focus());
      pressChord({ code: "MetaLeft", ctrlKey: true, metaKey: true });
      expect(document.activeElement).not.toBe(canvasEl());
    });

    it("forwards the old default chord to the remote once rebound", () => {
      setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, meta: true });
      const { onInput } = render();
      act(() => canvasEl().focus());
      pressChord({ code: "ShiftLeft", ctrlKey: true, altKey: true, shiftKey: true });
      expect(document.activeElement).toBe(canvasEl());
      expect(onInput).toHaveBeenCalledWith({ kind: "key", code: "ShiftLeft", pressed: true });
    });

    it("discloses the custom chord in the description and on-focus hint", () => {
      setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
      render();
      const id = canvasEl().getAttribute("aria-describedby");
      expect(document.getElementById(id as string)?.textContent).toContain("Press Ctrl+Alt to");
      act(() => canvasEl().focus());
      const hint = container.querySelector('[data-testid="remote-desktop-capture-hint"]');
      expect(hint?.querySelector("kbd")?.textContent).toBe("Ctrl+Alt");
    });
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

  it("closes a channel that opens only after the canvas unmounted", async () => {
    render();
    // Unmount before the subscribe promise settles.
    act(() => root.unmount());
    await flushAsync();
    expect(frameUnsubscribe).toHaveBeenCalledOnce();
    expect(remoteDesktopRequestFullFrame).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("closes the frame channel on unmount", async () => {
    render();
    // Let the subscription promise settle so the unsubscribe is registered.
    await flushAsync();
    act(() => root.unmount());
    expect(frameUnsubscribe).toHaveBeenCalledOnce();
    // Re-mount so afterEach's unmount call remains valid.
    root = createRoot(container);
  });
});
