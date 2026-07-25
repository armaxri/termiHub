import { useCallback, useEffect, useRef } from "react";
import { onRemoteDesktopFrame, onRemoteDesktopCursor } from "@/services/events";
import type { RemoteDesktopInput, ScaleMode } from "@/types/remoteDesktop";

interface RemoteDesktopCanvasProps {
  /** Backend graphical session id; the canvas filters events by it. */
  sessionId: string;
  /** How the framebuffer fills the tab. */
  scaleMode: ScaleMode;
  /** When true, input is not forwarded (view-only). */
  viewOnly: boolean;
  /** Send a protocol-agnostic input event (already view-only-gated upstream). */
  onInput: (event: RemoteDesktopInput) => void;
  /** Request a new pixel resolution (used by Match Window mode). */
  onResize: (width: number, height: number) => void;
  /** Notified when the remote framebuffer resolution changes. */
  onDimensions?: (width: number, height: number) => void;
  /**
   * Fired once, on the first frame this canvas paints. Used to clear the
   * "reconnecting view…" placeholder after a cross-window tab move (#1904).
   */
  onFirstFrame?: () => void;
}

/** Draw geometry mapping framebuffer pixels ↔ on-screen pixels. */
interface Geometry {
  fbW: number;
  fbH: number;
  drawX: number;
  drawY: number;
  scaleX: number;
  scaleY: number;
}

/** Debounce interval for Match Window resize requests. */
const RESIZE_DEBOUNCE_MS = 300;

/**
 * The one shared canvas surface for graphical remote-desktop sessions (#1680).
 *
 * Protocol-blind: it paints `remote-desktop-frame` dirty-rects into an offscreen
 * framebuffer and blits it to the visible `<canvas>` under the active scale mode,
 * tracks the synthetic cursor, and captures keyboard/mouse/wheel input —
 * reverse-scaling pointer coordinates to framebuffer pixels through one shared
 * helper before handing them up via `onInput`.
 */
export function RemoteDesktopCanvas({
  sessionId,
  scaleMode,
  viewOnly,
  onInput,
  onResize,
  onDimensions,
  onFirstFrame,
}: RemoteDesktopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Offscreen framebuffer at the remote's native resolution.
  const fbRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef<Geometry>({
    fbW: 0,
    fbH: 0,
    drawX: 0,
    drawY: 0,
    scaleX: 1,
    scaleY: 1,
  });
  const cursorRef = useRef<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });
  const resizeTimerRef = useRef<number | null>(null);
  // Whether this canvas has painted a frame yet (per session), so the first
  // repaint can clear the cross-window "reconnecting view…" placeholder (#1904).
  const firstFramePaintedRef = useRef(false);
  // Latest onFirstFrame, held in a ref so it never re-subscribes the frame feed.
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  // Pressed pointer-button bitmask (DOM MouseEvent.buttons convention).
  const buttonsRef = useRef(0);
  // Held modifier keys, released on focus loss to avoid stuck keys.
  const heldKeysRef = useRef<Set<string>>(new Set());

  /** Ensure the offscreen framebuffer canvas exists at the given size. */
  const ensureFramebuffer = useCallback((w: number, h: number) => {
    let fb = fbRef.current;
    if (!fb) {
      fb = document.createElement("canvas");
      fbRef.current = fb;
    }
    if (fb.width !== w || fb.height !== h) {
      fb.width = w;
      fb.height = h;
    }
    return fb;
  }, []);

  /** Repaint the visible canvas from the offscreen framebuffer. */
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const fb = fbRef.current;
    if (!canvas || !container || !fb || fb.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const { width: fbW, height: fbH } = fb;

    let geom: Geometry;
    if (scaleMode === "pixel") {
      // Native 1:1; the canvas is the framebuffer size and the container scrolls.
      canvas.width = fbW;
      canvas.height = fbH;
      geom = { fbW, fbH, drawX: 0, drawY: 0, scaleX: 1, scaleY: 1 };
    } else if (scaleMode === "match") {
      // Stretch to fill; a debounced resize request keeps the remote in step.
      canvas.width = cw;
      canvas.height = ch;
      geom = {
        fbW,
        fbH,
        drawX: 0,
        drawY: 0,
        scaleX: cw / fbW,
        scaleY: ch / fbH,
      };
    } else {
      // Fit to Tab: uniform scale, letterboxed and centered.
      canvas.width = cw;
      canvas.height = ch;
      const s = Math.min(cw / fbW, ch / fbH);
      const drawW = fbW * s;
      const drawH = fbH * s;
      geom = {
        fbW,
        fbH,
        drawX: (cw - drawW) / 2,
        drawY: (ch - drawH) / 2,
        scaleX: s,
        scaleY: s,
      };
    }
    geometryRef.current = geom;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(fb, 0, 0, fbW, fbH, geom.drawX, geom.drawY, fbW * geom.scaleX, fbH * geom.scaleY);

    // Draw the synthetic cursor marker, if visible.
    const cur = cursorRef.current;
    if (cur.visible) {
      const sx = geom.drawX + cur.x * geom.scaleX;
      const sy = geom.drawY + cur.y * geom.scaleY;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [scaleMode]);

  // Subscribe to frame + cursor events for this session.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    // A fresh (re)attach has painted nothing yet.
    firstFramePaintedRef.current = false;

    void onRemoteDesktopFrame((payload) => {
      if (disposed || payload.session_id !== sessionId) return;
      const prev = fbRef.current;
      const changed = !prev || prev.width !== payload.width || prev.height !== payload.height;
      const fb = ensureFramebuffer(payload.width, payload.height);
      if (changed) onDimensions?.(payload.width, payload.height);
      const ctx = fb.getContext("2d");
      if (!ctx) return;
      for (const rect of payload.rects) {
        const expected = rect.width * rect.height * 4;
        if (rect.data.length !== expected) continue;
        const img = new ImageData(new Uint8ClampedArray(rect.data), rect.width, rect.height);
        ctx.putImageData(img, rect.x, rect.y);
      }
      repaint();
      // First frame painted: clear the cross-window reconnecting placeholder.
      if (!firstFramePaintedRef.current) {
        firstFramePaintedRef.current = true;
        onFirstFrameRef.current?.();
      }
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    void onRemoteDesktopCursor((payload) => {
      if (disposed || payload.session_id !== sessionId) return;
      cursorRef.current = { x: payload.x, y: payload.y, visible: payload.visible };
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [sessionId, ensureFramebuffer, repaint, onDimensions]);

  // Repaint + (for Match Window) request a resolution change on container resize.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      repaint();
      if (scaleMode === "match") {
        if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = window.setTimeout(() => {
          resizeTimerRef.current = null;
          onResize(container.clientWidth, container.clientHeight);
        }, RESIZE_DEBOUNCE_MS);
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
    };
  }, [scaleMode, repaint, onResize]);

  /** Reverse-scale a client pointer position to framebuffer pixels. */
  const toFramebuffer = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const geom = geometryRef.current;
    if (!canvas || geom.scaleX === 0 || geom.scaleY === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - geom.drawX) / geom.scaleX;
    const y = (clientY - rect.top - geom.drawY) / geom.scaleY;
    if (x < 0 || y < 0 || x >= geom.fbW || y >= geom.fbH) return null;
    return { x: Math.floor(x), y: Math.floor(y) };
  }, []);

  const handlePointer = useCallback(
    (e: React.MouseEvent, buttons: number) => {
      if (viewOnly) return;
      buttonsRef.current = buttons;
      const pos = toFramebuffer(e.clientX, e.clientY);
      if (!pos) return;
      onInput({ kind: "pointer", x: pos.x, y: pos.y, buttons });
    },
    [viewOnly, toFramebuffer, onInput]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (viewOnly) return;
      const pos = toFramebuffer(e.clientX, e.clientY);
      if (!pos) return;
      onInput({ kind: "wheel", x: pos.x, y: pos.y, deltaX: e.deltaX, deltaY: e.deltaY });
    },
    [viewOnly, toFramebuffer, onInput]
  );

  const releaseHeldKeys = useCallback(() => {
    if (viewOnly) {
      heldKeysRef.current.clear();
      return;
    }
    for (const code of heldKeysRef.current) {
      onInput({ kind: "key", code, pressed: false });
    }
    heldKeysRef.current.clear();
  }, [viewOnly, onInput]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent, pressed: boolean) => {
      // Escape hatch: Ctrl+Alt+Shift releases focus back to termiHub so global
      // shortcuts and tab switching work again.
      if (pressed && e.ctrlKey && e.altKey && e.shiftKey) {
        releaseHeldKeys();
        canvasRef.current?.blur();
        return;
      }
      // Suppress termiHub's own shortcuts while the canvas is focused.
      e.preventDefault();
      e.stopPropagation();
      if (viewOnly) return;
      if (pressed) heldKeysRef.current.add(e.code);
      else heldKeysRef.current.delete(e.code);
      onInput({ kind: "key", code: e.code, pressed });
    },
    [viewOnly, releaseHeldKeys, onInput]
  );

  return (
    <div ref={containerRef} className={`rd-canvas rd-canvas--${scaleMode}`}>
      <canvas
        ref={canvasRef}
        className="rd-canvas__surface"
        tabIndex={0}
        data-testid="remote-desktop-canvas"
        onMouseDown={(e) => handlePointer(e, e.buttons)}
        onMouseUp={(e) => handlePointer(e, e.buttons)}
        onMouseMove={(e) => {
          if (e.buttons !== buttonsRef.current || e.buttons !== 0) handlePointer(e, e.buttons);
        }}
        onWheel={handleWheel}
        onKeyDown={(e) => handleKey(e, true)}
        onKeyUp={(e) => handleKey(e, false)}
        onBlur={releaseHeldKeys}
      />
    </div>
  );
}
