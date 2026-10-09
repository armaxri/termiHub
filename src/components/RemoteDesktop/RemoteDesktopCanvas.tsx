import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  subscribeRemoteDesktopFrames,
  type BinaryCursorShape,
  type DecodedCursor,
  type DecodedFrame,
} from "@/services/remoteDesktopFrames";
import { remoteDesktopRequestFullFrame } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import type { RemoteDesktopInput, ScaleMode } from "@/types/remoteDesktop";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { isCursorShapeValid, isDirtyRectValid, isFramebufferSizeValid } from "./frameBounds";
import type { Viewport } from "./monitorLayout";
import { errorMessage } from "@/utils/errorMessage";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { isReleaseChord, releaseChordLabel } from "./releaseChord";

/** The part of a `width x height` framebuffer to show: `viewport`, clamped. */
function sourceRegion(viewport: Viewport | null | undefined, width: number, height: number) {
  if (!viewport) return { x: 0, y: 0, width, height };
  const x = Math.min(Math.max(0, viewport.x), width - 1);
  const y = Math.min(Math.max(0, viewport.y), height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(viewport.width, width - x)),
    height: Math.max(1, Math.min(viewport.height, height - y)),
  };
}

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
  /**
   * Ask the backend to release every key / mouse button it holds on the remote
   * (#3402). Called on canvas blur, window blur and when the document is
   * hidden. Without it, the canvas falls back to sending its own key-ups.
   */
  onReleaseAll?: () => void;
  /**
   * The framebuffer region to show (#3696): one monitor of a multi-monitor
   * session. `null` / absent shows the whole (combined) framebuffer.
   */
  viewport?: Viewport | null;
  /**
   * The session's name for assistive tech (#4328): the canvas is announced as
   * "Remote desktop: <label>". Absent, it is just "Remote desktop".
   */
  label?: string;
}

/**
 * Draw geometry mapping framebuffer pixels ↔ on-screen pixels. `srcX`/`srcY`
 * are the shown region's origin in the framebuffer; `fbW`/`fbH` its size.
 */
interface Geometry {
  srcX: number;
  srcY: number;
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
 * Protocol-blind: it paints binary frame-channel dirty-rects into an offscreen
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
  onReleaseAll,
  viewport,
  label,
}: RemoteDesktopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Offscreen framebuffer at the remote's native resolution.
  const fbRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef<Geometry>({
    srcX: 0,
    srcY: 0,
    fbW: 0,
    fbH: 0,
    drawX: 0,
    drawY: 0,
    scaleX: 1,
    scaleY: 1,
  });
  // `shape` is the last *validated* cursor bitmap (#3333). The renderer still
  // draws a synthetic marker; the shape is kept only once it passed the shared
  // bound so a future bitmap renderer never sizes an image from untrusted dims.
  const cursorRef = useRef<{ x: number; y: number; visible: boolean; shape?: BinaryCursorShape }>({
    x: 0,
    y: 0,
    visible: false,
  });
  // Debounce (Match Window) resolution-change requests through the shared hook
  // (LIBFE-003), preserving the prior 300ms hand-rolled debounce. The callback
  // reads the container's *current* dimensions when it fires and always calls the
  // latest `onResize`; the pending request is dropped on unmount / mode change.
  const debouncedResize = useDebouncedCallback(() => {
    const container = containerRef.current;
    if (container) onResize(container.clientWidth, container.clientHeight);
  }, RESIZE_DEBOUNCE_MS);
  // Whether this canvas has painted a frame yet (per session), so the first
  // repaint can clear the cross-window "reconnecting view…" placeholder (#1904).
  const firstFramePaintedRef = useRef(false);
  // Latest onFirstFrame / onDimensions, held in refs so a parent re-render (the
  // tab passes inline callbacks) never re-subscribes the frame feed: frames sent
  // while it re-subscribed were lost, leaving a static desktop half painted (#4017).
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  const onDimensionsRef = useRef(onDimensions);
  onDimensionsRef.current = onDimensions;
  // Pressed pointer-button bitmask (DOM MouseEvent.buttons convention).
  const buttonsRef = useRef(0);
  // Held modifier keys, released on focus loss to avoid stuck keys.
  const heldKeysRef = useRef<Set<string>>(new Set());
  // Whether the canvas holds keyboard focus (#4328): drives the focus ring, the
  // on-canvas release hint and the capture/release announcement.
  const [captured, setCaptured] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const descriptionId = useId();
  const chord = releaseChordLabel();

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
    // The shown region: the whole framebuffer, or one monitor of it (#3696).
    const src = sourceRegion(viewport, fb.width, fb.height);
    const { x: srcX, y: srcY, width: fbW, height: fbH } = src;

    let geom: Geometry;
    if (scaleMode === "pixel") {
      // Native 1:1; the canvas is the region size and the container scrolls.
      canvas.width = fbW;
      canvas.height = fbH;
      geom = { srcX, srcY, fbW, fbH, drawX: 0, drawY: 0, scaleX: 1, scaleY: 1 };
    } else if (scaleMode === "match") {
      // Stretch to fill; a debounced resize request keeps the remote in step.
      canvas.width = cw;
      canvas.height = ch;
      geom = {
        srcX,
        srcY,
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
        srcX,
        srcY,
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
    ctx.drawImage(
      fb,
      srcX,
      srcY,
      fbW,
      fbH,
      geom.drawX,
      geom.drawY,
      fbW * geom.scaleX,
      fbH * geom.scaleY
    );

    // Draw the synthetic cursor marker, if visible.
    const cur = cursorRef.current;
    if (cur.visible) {
      const sx = geom.drawX + (cur.x - srcX) * geom.scaleX;
      const sy = geom.drawY + (cur.y - srcY) * geom.scaleY;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [scaleMode, viewport]);
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;

  // Subscribe to this session's binary frame + cursor channel (#4291).
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    // A fresh (re)attach has painted nothing yet.
    firstFramePaintedRef.current = false;

    const onFrame = (frame: DecodedFrame): void => {
      if (disposed) return;
      // Never size the offscreen canvas from an untrusted, absurd size (MOCK-011).
      if (!isFramebufferSizeValid(frame.width, frame.height)) return;
      const prev = fbRef.current;
      const changed = !prev || prev.width !== frame.width || prev.height !== frame.height;
      const fb = ensureFramebuffer(frame.width, frame.height);
      if (changed) onDimensionsRef.current?.(frame.width, frame.height);
      const ctx = fb.getContext("2d");
      if (!ctx) return;
      for (const rect of frame.rects) {
        if (!isDirtyRectValid(rect, fb.width, fb.height)) continue;
        // `rect.data` is already a Uint8ClampedArray view onto the IPC buffer.
        ctx.putImageData(new ImageData(rect.data, rect.width, rect.height), rect.x, rect.y);
      }
      repaintRef.current();
      // First frame painted: clear the cross-window reconnecting placeholder.
      if (!firstFramePaintedRef.current) {
        firstFramePaintedRef.current = true;
        onFirstFrameRef.current?.();
      }
    };

    const onCursor = (cursor: DecodedCursor): void => {
      if (disposed) return;
      // Defensive re-check (the backend cursor pump already enforces this):
      // ignore a non-integral / negative position outright, and never keep a
      // shape outside the shared bound — an absent or invalid shape keeps the
      // current cursor image.
      if (![cursor.x, cursor.y].every((v) => Number.isInteger(v) && v >= 0)) return;
      const prev = cursorRef.current.shape;
      const shape = cursor.shape && isCursorShapeValid(cursor.shape) ? cursor.shape : prev;
      cursorRef.current = { x: cursor.x, y: cursor.y, visible: cursor.visible, shape };
    };

    void subscribeRemoteDesktopFrames(sessionId, { onFrame, onCursor }).then(
      (un) => {
        if (disposed) {
          un();
          return;
        }
        unsubscribe = un;
        // The backend streams frames from the moment the connect returns, before
        // this channel existed, and a static desktop never resends them: ask for
        // a full frame now that nothing can be missed (#4017).
        void remoteDesktopRequestFullFrame(sessionId).catch((err) =>
          frontendLog(
            "remote_desktop",
            `request_full_frame on subscribe failed: ${errorMessage(err)}`
          )
        );
      },
      (err) => frontendLog("remote_desktop", `frame channel subscribe failed: ${errorMessage(err)}`)
    );

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [sessionId, ensureFramebuffer]);

  // Repaint + (for Match Window) request a resolution change on container resize.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      repaint();
      if (scaleMode === "match") {
        debouncedResize();
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      debouncedResize.cancel();
    };
  }, [scaleMode, repaint, debouncedResize]);

  /** Reverse-scale a client pointer position to framebuffer pixels. */
  const toFramebuffer = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const geom = geometryRef.current;
    if (!canvas || geom.scaleX === 0 || geom.scaleY === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - geom.drawX) / geom.scaleX;
    const y = (clientY - rect.top - geom.drawY) / geom.scaleY;
    if (x < 0 || y < 0 || x >= geom.fbW || y >= geom.fbH) return null;
    // Back to full-framebuffer coordinates (a monitor viewport is offset, #3696).
    return { x: Math.floor(x) + geom.srcX, y: Math.floor(y) + geom.srcY };
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
    const held = heldKeysRef.current;
    heldKeysRef.current = new Set();
    buttonsRef.current = 0;
    // View-only / evicted: this window cannot send; on a takeover the backend
    // releases what this window held (#3402).
    if (viewOnly) return;
    if (onReleaseAll) {
      // The backend is authoritative for what is held (keys *and* buttons,
      // including any key-up this canvas never saw) (#3402).
      onReleaseAll();
      return;
    }
    for (const code of held) {
      onInput({ kind: "key", code, pressed: false });
    }
  }, [viewOnly, onInput, onReleaseAll]);

  // Window blur / document hidden (#3402): the canvas may not see the key-up or
  // button-up of a gesture that ends outside the window, so release on the
  // remote while this window still controls the session. Only a canvas that is
  // focused or holds something releases, so idle tabs send nothing.
  const releaseHeldKeysRef = useRef(releaseHeldKeys);
  releaseHeldKeysRef.current = releaseHeldKeys;
  useEffect(() => {
    const releaseIfEngaged = () => {
      const engaged =
        document.activeElement === canvasRef.current ||
        heldKeysRef.current.size > 0 ||
        buttonsRef.current !== 0;
      if (engaged) releaseHeldKeysRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseIfEngaged();
    };
    window.addEventListener("blur", releaseIfEngaged);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", releaseIfEngaged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const handleKey = useCallback(
    (e: React.KeyboardEvent, pressed: boolean) => {
      // Escape hatch: Ctrl+Alt+Shift releases focus back to termiHub so global
      // shortcuts and tab switching work again. Disclosed in the canvas's
      // description, the on-focus hint and the toolbar (#4328).
      if (pressed && isReleaseChord(e)) {
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

  const handleFocus = useCallback(() => {
    setCaptured(true);
    setAnnouncement(`Keyboard captured — press ${chord} to release`);
  }, [chord]);

  const handleBlur = useCallback(() => {
    releaseHeldKeys();
    setCaptured(false);
    setAnnouncement("Keyboard released to termiHub");
  }, [releaseHeldKeys]);

  return (
    <div ref={containerRef} className={`rd-canvas rd-canvas--${scaleMode}`}>
      <canvas
        ref={canvasRef}
        className={`rd-canvas__surface${captured ? " rd-canvas__surface--captured" : ""}`}
        tabIndex={0}
        role="application"
        aria-label={label ? `Remote desktop: ${label}` : "Remote desktop"}
        aria-describedby={descriptionId}
        data-testid="remote-desktop-canvas"
        onMouseDown={(e) => handlePointer(e, e.buttons)}
        onMouseUp={(e) => handlePointer(e, e.buttons)}
        onMouseMove={(e) => {
          if (e.buttons !== buttonsRef.current || e.buttons !== 0) handlePointer(e, e.buttons);
        }}
        onWheel={handleWheel}
        onKeyDown={(e) => handleKey(e, true)}
        onKeyUp={(e) => handleKey(e, false)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      <span id={descriptionId} className="ui-visually-hidden">
        Keyboard input goes to the remote machine. Press {chord} to return focus to termiHub.
      </span>
      {captured && (
        <div
          className="rd-canvas__hint"
          aria-hidden="true"
          data-testid="remote-desktop-capture-hint"
        >
          Keyboard captured · <kbd>{chord}</kbd> to release
        </div>
      )}
      <LiveRegion message={announcement} data-testid="remote-desktop-capture-announcer" />
    </div>
  );
}
