import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  subscribeRemoteDesktopFrames,
  type BinaryCursorShape,
  type DecodedCursor,
  type DecodedFrame,
  type RemoteDesktopFrameSubscription,
} from "@/services/remoteDesktopFrames";
import { remoteDesktopRequestFullFrame } from "@/services/api";
import { frontendError, frontendLog, frontendWarn } from "@/utils/frontendLog";
import {
  createFramePaintQueue,
  notifyWireMismatch,
  paintReadyRects,
  type ReadyRect,
} from "./framePaintQueue";
import type { RemoteDesktopInput, ScaleMode } from "@/types/remoteDesktop";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { isCursorShapeValid, isFramebufferSizeValid } from "./frameBounds";
import type { Viewport } from "./monitorLayout";
import { errorMessage } from "@/utils/errorMessage";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { isReleaseChord, useReleaseChordLabel } from "./releaseChord";

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
  // Whether the draw geometry / visible canvas size must be recomputed before
  // the next repaint (container, scale mode, viewport or framebuffer changed).
  const layoutDirtyRef = useRef(true);
  // The pending coalesced repaint's requestAnimationFrame id (PERF2-005).
  const rafRef = useRef<number | null>(null);
  // Pressed pointer-button bitmask (DOM MouseEvent.buttons convention).
  const buttonsRef = useRef(0);
  // Held modifier keys, released on focus loss to avoid stuck keys.
  const heldKeysRef = useRef<Set<string>>(new Set());
  // Whether the canvas holds keyboard focus (#4328): drives the focus ring, the
  // on-canvas release hint and the capture/release announcement.
  const [captured, setCaptured] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const descriptionId = useId();
  const chord = useReleaseChordLabel();

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

  /**
   * Recompute the draw geometry for the current container size, scale mode and
   * viewport, and size the visible canvas to it. Assigning `canvas.width` /
   * `height` resets the 2D context and clears (possibly reallocates) its
   * backing store, so it only happens when the target size really changed — and
   * this only runs when the layout is dirty, never on a plain repaint
   * (PERF2-005).
   */
  const applyLayout = useCallback(
    (canvas: HTMLCanvasElement, container: HTMLDivElement, fb: HTMLCanvasElement) => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      // The shown region: the whole framebuffer, or one monitor of it (#3696).
      const {
        x: srcX,
        y: srcY,
        width: fbW,
        height: fbH,
      } = sourceRegion(viewport, fb.width, fb.height);
      let width = cw;
      let height = ch;
      let geom: Geometry;
      if (scaleMode === "pixel") {
        // Native 1:1; the canvas is the region size and the container scrolls.
        width = fbW;
        height = fbH;
        geom = { srcX, srcY, fbW, fbH, drawX: 0, drawY: 0, scaleX: 1, scaleY: 1 };
      } else if (scaleMode === "match") {
        // Stretch to fill; a debounced resize request keeps the remote in step.
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
        const s = Math.min(cw / fbW, ch / fbH);
        geom = {
          srcX,
          srcY,
          fbW,
          fbH,
          drawX: (cw - fbW * s) / 2,
          drawY: (ch - fbH * s) / 2,
          scaleX: s,
          scaleY: s,
        };
      }
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      geometryRef.current = geom;
    },
    [scaleMode, viewport]
  );

  /** Repaint the visible canvas from the offscreen framebuffer. */
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const fb = fbRef.current;
    if (!canvas || !container || !fb || fb.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (layoutDirtyRef.current) {
      layoutDirtyRef.current = false;
      applyLayout(canvas, container, fb);
    }
    const geom = geometryRef.current;
    const { srcX, srcY, fbW, fbH } = geom;

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
  }, [applyLayout]);
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;

  /**
   * Coalesce repaints into one per animation frame (PERF2-005): a burst of
   * small updates in one frame is already applied to the offscreen framebuffer
   * in arrival order, so only the final blit is deferred and no rect is lost.
   */
  const scheduleRepaint = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      repaintRef.current();
      // First frame painted: clear the cross-window reconnecting placeholder.
      if (!firstFramePaintedRef.current) {
        firstFramePaintedRef.current = true;
        onFirstFrameRef.current?.();
      }
    });
  }, []);

  // Drop a pending animation-frame repaint on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    []
  );

  // Subscribe to this session's binary frame + cursor channel (#4291).
  useEffect(() => {
    let disposed = false;
    let subscription: RemoteDesktopFrameSubscription | null = null;
    // A fresh (re)attach has painted nothing yet.
    firstFramePaintedRef.current = false;

    const requestFullFrame = (why: string): void => {
      void remoteDesktopRequestFullFrame(sessionId).catch((err) =>
        frontendLog("remote_desktop", `request_full_frame ${why} failed: ${errorMessage(err)}`)
      );
    };

    // Paint one frame, in server order, with its JPEG rects already decoded.
    const paint = (frame: DecodedFrame, rects: ReadyRect[]): void => {
      if (disposed) return;
      // Never size the offscreen canvas from an untrusted, absurd size (MOCK-011).
      if (!isFramebufferSizeValid(frame.width, frame.height)) return;
      const prev = fbRef.current;
      const changed = !prev || prev.width !== frame.width || prev.height !== frame.height;
      const fb = ensureFramebuffer(frame.width, frame.height);
      if (changed) {
        // A new remote resolution changes the draw geometry.
        layoutDirtyRef.current = true;
        onDimensionsRef.current?.(frame.width, frame.height);
      }
      const ctx = fb.getContext("2d");
      if (!ctx) return;
      paintReadyRects(ctx, fb.width, fb.height, rects);
      scheduleRepaint();
    };

    // Switch this channel to RGBA, then repaint everything a skipped JPEG rect
    // left stale (#4424). Deferred until the subscription exists.
    let fallbackPending = false;
    const fallBackToRgba = (sub: RemoteDesktopFrameSubscription): void => {
      void sub
        .disableJpeg()
        .catch((err) =>
          frontendLog("remote_desktop", `disable jpeg frames failed: ${errorMessage(err)}`)
        )
        .finally(() => {
          if (!disposed) requestFullFrame("after jpeg fallback");
        });
    };

    // JPEG rects decode asynchronously; the queue keeps server paint order (#4424).
    const queue = createFramePaintQueue({
      paint,
      onDecodeFailure: (reason) => {
        frontendWarn("remote_desktop", `${reason}; falling back to RGBA frames`);
        if (disposed) return;
        if (subscription) fallBackToRgba(subscription);
        else fallbackPending = true;
      },
    });

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

    const onWireMismatch = (backendVersion: number | null): void => {
      if (!disposed) notifyWireMismatch(backendVersion);
    };

    void subscribeRemoteDesktopFrames(sessionId, {
      onFrame: (frame) => {
        if (!disposed) queue.push(frame);
      },
      onCursor,
      onWireMismatch,
    }).then(
      (sub) => {
        if (disposed) {
          sub.unsubscribe();
          return;
        }
        subscription = sub;
        // The backend streams frames from the moment the connect returns, before
        // this channel existed, and a static desktop never resends them: ask for
        // a full frame now that nothing can be missed (#4017).
        if (fallbackPending) fallBackToRgba(sub);
        else requestFullFrame("on subscribe");
      },
      (err) => {
        frontendError("remote_desktop", `frame channel subscribe failed: ${errorMessage(err)}`);
        // A refused wire version is a build skew the user must hear about.
        if (/wire version mismatch/.test(errorMessage(err))) onWireMismatch(null);
      }
    );

    return () => {
      disposed = true;
      queue.dispose();
      subscription?.unsubscribe();
    };
  }, [sessionId, ensureFramebuffer, scheduleRepaint]);

  // Re-lay out + repaint now when the scale mode or viewport changes (a new
  // `repaint`), and on every container resize; for Match Window also request a
  // resolution change. Only these (and a new framebuffer size) resize the
  // visible canvas (PERF2-005).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    layoutDirtyRef.current = true;
    repaint();
    const observer = new ResizeObserver(() => {
      layoutDirtyRef.current = true;
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
      // Escape hatch: the release chord (default Ctrl+Alt+Shift, rebindable,
      // #4524) releases focus back to termiHub so global shortcuts and tab
      // switching work again. Read live from the keybinding service, and
      // disclosed in the canvas's description, the on-focus hint and the
      // toolbar (#4328).
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
