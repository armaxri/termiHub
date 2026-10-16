/**
 * Binary remote-desktop frame channel (#4291).
 *
 * Frame and cursor updates for a graphical session arrive over a Tauri IPC
 * `Channel` as `ArrayBuffer`s instead of JSON events whose pixel data was an
 * array with one number per byte (PERF2-001). This module opens that channel
 * and decodes its messages; the encoder is
 * `src-tauri/src/session/remote_desktop_frames.rs` — keep the two in step.
 *
 * Wire format (version 2, little-endian `u32`s): a 4-byte header
 * `[kind, version, flags, reserved]`, then
 * - frame (`kind = 1`): `width, height, rectCount`, then per rect
 *   `x, y, width, height, encoding, byteLen` followed by `byteLen` payload
 *   bytes zero-padded to a multiple of 4. `encoding` 0 is RGBA (exactly
 *   `width * height * 4` bytes); 1 is a baseline JPEG decoding to
 *   `width x height` (#4424), sent only when this webview opted in;
 * - cursor (`kind = 2`, flags bit 0 = visible, bit 1 = has shape): `x, y`,
 *   then, with a shape, `width, height, hotspotX, hotspotY` followed by
 *   `width * height * 4` RGBA bytes.
 *
 * Decoded payloads are views onto the received buffer (RGBA as a
 * `Uint8ClampedArray`, so it goes straight into `ImageData` without a copy).
 *
 * A message carrying another wire version is a frontend/backend build skew:
 * it is reported loudly (LogViewer error + `onWireMismatch`) rather than
 * dropped silently, and the backend refuses a subscription whose
 * `wireVersion` it does not speak.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { fireAndForget, frontendError } from "@/utils/frontendLog";

export const KIND_FRAME = 1;
export const KIND_CURSOR = 2;
export const WIRE_VERSION = 2;
export const RECT_ENCODING_RGBA = 0;
export const RECT_ENCODING_JPEG = 1;
const FRAME_HEADER_LEN = 16;
const RECT_HEADER_LEN = 24;
const CURSOR_HEADER_LEN = 12;
const SHAPE_HEADER_LEN = 16;
const CURSOR_FLAG_VISIBLE = 0b01;
const CURSOR_FLAG_SHAPE = 0b10;

/** One dirty rect of a decoded frame; `data` is tightly packed RGBA. */
export interface BinaryDirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absent or `"rgba"`: `data` is `width * height * 4` RGBA bytes. */
  encoding?: "rgba";
  data: Uint8ClampedArray;
}

/**
 * A dirty rect sent as its compressed JPEG source (#4424); the webview decodes
 * it (`createImageBitmap`) and must check the result is `width x height`.
 */
export interface JpegDirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: "jpeg";
  data: Uint8Array;
}

/** Any rect of a decoded frame. */
export type FrameRect = BinaryDirtyRect | JpegDirtyRect;

/** A decoded framebuffer update. */
export interface DecodedFrame {
  kind: "frame";
  width: number;
  height: number;
  rects: FrameRect[];
}

/** A decoded cursor bitmap with its hotspot. */
export interface BinaryCursorShape {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  data: Uint8ClampedArray;
}

/** A decoded cursor update. `shape` is absent for a position-only update. */
export interface DecodedCursor {
  kind: "cursor";
  x: number;
  y: number;
  visible: boolean;
  shape?: BinaryCursorShape;
}

/** A message in a wire version this build does not decode (a build skew). */
export interface DecodedWireMismatch {
  kind: "wire-mismatch";
  version: number;
}

export type DecodedRemoteDesktopMessage = DecodedFrame | DecodedCursor | DecodedWireMismatch;

/** `width * height * 4`, or `null` when the bytes cannot be in the buffer. */
function rgbaLen(width: number, height: number, remaining: number): number | null {
  const len = width * height * 4;
  return Number.isSafeInteger(len) && len <= remaining ? len : null;
}

/** One rect's payload, or `null` when it is malformed or truncated. */
function decodeRectPayload(
  geometry: { x: number; y: number; width: number; height: number },
  encoding: number,
  bytes: Uint8Array
): FrameRect | null {
  if (encoding === RECT_ENCODING_JPEG) return { ...geometry, encoding: "jpeg", data: bytes };
  if (encoding !== RECT_ENCODING_RGBA) return null;
  if (bytes.length !== rgbaLen(geometry.width, geometry.height, bytes.length)) return null;
  const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length);
  return { ...geometry, data };
}

function decodeFrame(view: DataView, buf: ArrayBuffer, base: number): DecodedFrame | null {
  if (view.byteLength < FRAME_HEADER_LEN) return null;
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const rects: FrameRect[] = [];
  let offset = FRAME_HEADER_LEN;
  for (let i = 0; i < count; i++) {
    if (offset + RECT_HEADER_LEN > view.byteLength) return null;
    const geometry = {
      x: view.getUint32(offset, true),
      y: view.getUint32(offset + 4, true),
      width: view.getUint32(offset + 8, true),
      height: view.getUint32(offset + 12, true),
    };
    const encoding = view.getUint32(offset + 16, true);
    const len = view.getUint32(offset + 20, true);
    offset += RECT_HEADER_LEN;
    // The padded payload must fit; the last rect's padding is always sent.
    const padded = Math.ceil(len / 4) * 4;
    if (offset + padded > view.byteLength) return null;
    const rect = decodeRectPayload(geometry, encoding, new Uint8Array(buf, base + offset, len));
    if (rect === null) return null;
    rects.push(rect);
    offset += padded;
  }
  return { kind: "frame", width, height, rects };
}

function decodeCursor(view: DataView, buf: ArrayBuffer, base: number): DecodedCursor | null {
  if (view.byteLength < CURSOR_HEADER_LEN) return null;
  const flags = view.getUint8(2);
  const cursor: DecodedCursor = {
    kind: "cursor",
    x: view.getUint32(4, true),
    y: view.getUint32(8, true),
    visible: (flags & CURSOR_FLAG_VISIBLE) !== 0,
  };
  if ((flags & CURSOR_FLAG_SHAPE) === 0) return cursor;
  const s = CURSOR_HEADER_LEN;
  if (s + SHAPE_HEADER_LEN > view.byteLength) return null;
  const width = view.getUint32(s, true);
  const height = view.getUint32(s + 4, true);
  const dataStart = s + SHAPE_HEADER_LEN;
  const len = rgbaLen(width, height, view.byteLength - dataStart);
  if (len === null) return null;
  cursor.shape = {
    width,
    height,
    hotspotX: view.getUint32(s + 8, true),
    hotspotY: view.getUint32(s + 12, true),
    data: new Uint8ClampedArray(buf, base + dataStart, len),
  };
  return cursor;
}

/**
 * Decode one binary frame-channel message. Returns `null` for an unknown kind
 * or a truncated / malformed message, so a bad message is dropped whole rather
 * than painted from misaligned bytes, and a `wire-mismatch` for a message in
 * another wire version.
 */
export function decodeRemoteDesktopMessage(
  message: ArrayBuffer | ArrayBufferView
): DecodedRemoteDesktopMessage | null {
  const buf = ArrayBuffer.isView(message) ? (message.buffer as ArrayBuffer) : message;
  const base = ArrayBuffer.isView(message) ? message.byteOffset : 0;
  const length = message.byteLength;
  if (length < 4) return null;
  const view = new DataView(buf, base, length);
  const version = view.getUint8(1);
  if (version !== WIRE_VERSION) return { kind: "wire-mismatch", version };
  switch (view.getUint8(0)) {
    case KIND_FRAME:
      return decodeFrame(view, buf, base);
    case KIND_CURSOR:
      return decodeCursor(view, buf, base);
    default:
      return null;
  }
}

/** Callbacks for {@link subscribeRemoteDesktopFrames}. */
export interface RemoteDesktopFrameHandlers {
  onFrame: (frame: DecodedFrame) => void;
  onCursor: (cursor: DecodedCursor) => void;
  /**
   * The backend sends another wire version (a frontend/backend build skew).
   * Called once per subscription; every such message is dropped.
   */
  onWireMismatch?: (backendVersion: number) => void;
}

/** An open frame channel, from {@link subscribeRemoteDesktopFrames}. */
export interface RemoteDesktopFrameSubscription {
  /** Close the channel. Idempotent. */
  unsubscribe: () => void;
  /** Whether the backend was asked to pass JPEG rects through (#4424). */
  acceptsJpeg: boolean;
  /**
   * Ask the backend to send RGBA from now on (the JPEG decode fallback). The
   * caller then requests a full frame, which arrives as RGBA.
   */
  disableJpeg: () => Promise<void>;
}

/** Whether this webview can decode JPEG rects (`createImageBitmap` + `Blob`). */
export function canDecodeJpegRects(): boolean {
  return typeof createImageBitmap === "function" && typeof Blob === "function";
}

/**
 * Open the binary frame channel for one session in this window. Resolves once
 * the backend has registered the channel, so a caller can request a full frame
 * knowing nothing will be missed. JPEG pass-through is requested only when the
 * webview can decode it ({@link canDecodeJpegRects}).
 */
export async function subscribeRemoteDesktopFrames(
  sessionId: string,
  handlers: RemoteDesktopFrameHandlers
): Promise<RemoteDesktopFrameSubscription> {
  const channel = new Channel<ArrayBuffer>();
  let mismatchReported = false;
  channel.onmessage = (message) => {
    const decoded = decodeRemoteDesktopMessage(message);
    if (decoded?.kind === "frame") handlers.onFrame(decoded);
    else if (decoded?.kind === "cursor") handlers.onCursor(decoded);
    else if (decoded?.kind === "wire-mismatch" && !mismatchReported) {
      mismatchReported = true;
      frontendError(
        "remote_desktop",
        `frame wire version mismatch: backend sends ${decoded.version}, webview decodes ` +
          `${WIRE_VERSION}; frontend and backend builds differ — frames are dropped`
      );
      handlers.onWireMismatch?.(decoded.version);
    }
  };
  const acceptsJpeg = canDecodeJpegRects();
  const subscriptionId = await invoke<number>("remote_desktop_subscribe_frames", {
    sessionId,
    channel,
    wireVersion: WIRE_VERSION,
    acceptJpeg: acceptsJpeg,
  });
  let active = true;
  return {
    acceptsJpeg,
    unsubscribe: () => {
      if (!active) return;
      active = false;
      // The session or window may already be gone; nothing is left to drop.
      fireAndForget(
        invoke("remote_desktop_unsubscribe_frames", { sessionId, subscriptionId }),
        `unsubscribe remote-desktop frames ${subscriptionId}`
      );
    },
    disableJpeg: async () => {
      await invoke("remote_desktop_set_frame_jpeg", {
        sessionId,
        subscriptionId,
        acceptJpeg: false,
      });
    },
  };
}
