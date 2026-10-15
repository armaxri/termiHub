import {
  WIRE_VERSION,
  type BinaryDirtyRect,
  type DecodedFrame,
  type JpegDirtyRect,
} from "@/services/remoteDesktopFrames";
import { toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { isDirtyRectValid, isRectInBounds } from "./frameBounds";

/**
 * Decodes one JPEG rect's bytes to a bitmap. The default uses
 * `createImageBitmap`; tests inject their own.
 */
export type JpegDecoder = (bytes: Uint8Array) => Promise<ImageBitmap>;

/**
 * A rect ready to paint: RGBA as-is, or a JPEG rect with its decoded bitmap.
 * A JPEG rect whose decode failed never reaches the painter, so the screen
 * keeps its previous pixels there rather than showing garbage.
 */
export type ReadyRect = BinaryDirtyRect | (JpegDirtyRect & { bitmap: ImageBitmap });

/** Options for {@link createFramePaintQueue}. */
export interface FramePaintQueueOptions {
  /** Paint one frame, in arrival order, with every JPEG rect decoded. */
  paint: (frame: DecodedFrame, rects: ReadyRect[]) => void;
  /**
   * A JPEG rect could not be decoded (decode error, no `createImageBitmap`, or
   * a bitmap of the wrong size). Called once per queue; the caller falls back
   * to RGBA and requests a full frame to repaint what was skipped.
   */
  onDecodeFailure: (reason: string) => void;
  /** JPEG decoder; defaults to {@link decodeJpegWithImageBitmap}. */
  decode?: JpegDecoder;
}

/** The ordered paint queue for one frame channel. */
export interface FramePaintQueue {
  /** Queue a decoded frame; it paints after every frame pushed before it. */
  push: (frame: DecodedFrame) => void;
  /** Drop queued frames and release their bitmaps; later decodes are ignored. */
  dispose: () => void;
}

/** Decode JPEG bytes with the webview's own decoder (#4424). */
export const decodeJpegWithImageBitmap: JpegDecoder = (bytes) => {
  if (typeof createImageBitmap !== "function") {
    return Promise.reject(new Error("createImageBitmap is unavailable"));
  }
  // Copy into a fresh ArrayBuffer-backed view: a Blob part must not be a view
  // onto a SharedArrayBuffer, and the IPC buffer is not ours to keep alive.
  return createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
};

interface Entry {
  frame: DecodedFrame;
  /** One slot per rect; `undefined` while a JPEG decode is pending. */
  ready: Array<ReadyRect | null | undefined>;
  pending: number;
}

/**
 * Paint frames strictly in the order the server sent them (#4424).
 *
 * `createImageBitmap` is asynchronous, so a JPEG rect cannot be drawn when its
 * frame arrives. Each frame's JPEG rects start decoding immediately (in
 * parallel), but a frame paints only once every frame before it has painted and
 * its own decodes have settled; raw RGBA frames queue behind a pending decode
 * instead of overtaking it. With nothing pending, a frame without JPEG rects
 * paints synchronously, exactly as before.
 */
export function createFramePaintQueue(options: FramePaintQueueOptions): FramePaintQueue {
  const decode = options.decode ?? decodeJpegWithImageBitmap;
  const queue: Entry[] = [];
  let disposed = false;
  let failureReported = false;

  const fail = (reason: string): void => {
    if (failureReported) return;
    failureReported = true;
    options.onDecodeFailure(reason);
  };

  const drain = (): void => {
    while (!disposed && queue.length > 0 && queue[0].pending === 0) {
      const entry = queue.shift() as Entry;
      const rects = entry.ready.filter((r): r is ReadyRect => r != null);
      options.paint(entry.frame, rects);
    }
  };

  const startDecode = (entry: Entry, index: number, rect: JpegDirtyRect): void => {
    entry.pending += 1;
    const settle = (ready: ReadyRect | null): void => {
      entry.ready[index] = ready;
      entry.pending -= 1;
      drain();
    };
    let decoding: Promise<ImageBitmap>;
    try {
      decoding = decode(rect.data);
    } catch (err) {
      decoding = Promise.reject(err);
    }
    decoding.then(
      (bitmap) => {
        if (disposed) {
          bitmap.close();
          return;
        }
        if (bitmap.width !== rect.width || bitmap.height !== rect.height) {
          bitmap.close();
          fail(
            `jpeg rect decoded to ${bitmap.width}x${bitmap.height}, expected ` +
              `${rect.width}x${rect.height}`
          );
          settle(null);
          return;
        }
        settle({ ...rect, bitmap });
      },
      (err: unknown) => {
        if (disposed) return;
        fail(`jpeg rect decode failed: ${errorMessage(err)}`);
        settle(null);
      }
    );
  };

  return {
    push: (frame) => {
      if (disposed) return;
      const entry: Entry = { frame, ready: [], pending: 0 };
      frame.rects.forEach((rect, i) => {
        if (rect.encoding === "jpeg") {
          entry.ready.push(undefined);
          startDecode(entry, i, rect);
        } else {
          entry.ready.push(rect);
        }
      });
      queue.push(entry);
      drain();
    },
    dispose: () => {
      disposed = true;
      for (const entry of queue.splice(0)) {
        for (const r of entry.ready) {
          if (r?.encoding === "jpeg") r.bitmap.close();
        }
      }
    },
  };
}

/**
 * Blit ready rects into the offscreen framebuffer's context, in order. Invalid
 * RGBA rects and out-of-bounds JPEG rects are skipped; every bitmap is closed.
 * Returns how many JPEG rects were drawn.
 */
export function paintReadyRects(
  ctx: CanvasRenderingContext2D,
  fbWidth: number,
  fbHeight: number,
  rects: ReadyRect[]
): number {
  let jpegDrawn = 0;
  for (const rect of rects) {
    if (rect.encoding === "jpeg") {
      // The queue checked the bitmap is exactly the rect's size.
      if (isRectInBounds(rect, fbWidth, fbHeight)) {
        ctx.drawImage(rect.bitmap, rect.x, rect.y);
        jpegDrawn += 1;
      }
      rect.bitmap.close();
      continue;
    }
    if (!isDirtyRectValid(rect, fbWidth, fbHeight)) continue;
    // `rect.data` is already a Uint8ClampedArray view onto the IPC buffer.
    ctx.putImageData(new ImageData(rect.data, rect.width, rect.height), rect.x, rect.y);
  }
  return jpegDrawn;
}

/**
 * Tell the user a frontend/backend frame-format skew keeps the desktop from
 * showing. `backendVersion` is null when the backend refused our version.
 */
export function notifyWireMismatch(backendVersion: number | null): void {
  const versions =
    backendVersion === null
      ? `the backend refused frontend v${WIRE_VERSION}`
      : `backend v${backendVersion}, frontend v${WIRE_VERSION}`;
  toast.error("Remote desktop display can't be shown", {
    description:
      `This termiHub build's frontend and backend disagree on the frame format ` +
      `(${versions}). Restart or reinstall termiHub.`,
  });
}
