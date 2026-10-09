/**
 * Binary remote-desktop frame channel (#4291).
 *
 * Frame and cursor updates for a graphical session arrive over a Tauri IPC
 * `Channel` as `ArrayBuffer`s instead of JSON events whose pixel data was an
 * array with one number per byte (PERF2-001). This module opens that channel
 * and decodes its messages; the encoder is
 * `src-tauri/src/session/remote_desktop_frames.rs` — keep the two in step.
 *
 * Wire format (version 1, little-endian `u32`s): a 4-byte header
 * `[kind, version, flags, reserved]`, then
 * - frame (`kind = 1`): `width, height, rectCount`, then per rect
 *   `x, y, width, height` followed by `width * height * 4` RGBA bytes;
 * - cursor (`kind = 2`, flags bit 0 = visible, bit 1 = has shape): `x, y`,
 *   then, with a shape, `width, height, hotspotX, hotspotY` followed by
 *   `width * height * 4` RGBA bytes.
 *
 * Decoded pixel data is a `Uint8ClampedArray` view onto the received buffer,
 * so it goes straight into `ImageData` without a copy.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { fireAndForget } from "@/utils/frontendLog";

export const KIND_FRAME = 1;
export const KIND_CURSOR = 2;
export const WIRE_VERSION = 1;
const FRAME_HEADER_LEN = 16;
const RECT_HEADER_LEN = 16;
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
  data: Uint8ClampedArray;
}

/** A decoded framebuffer update. */
export interface DecodedFrame {
  kind: "frame";
  width: number;
  height: number;
  rects: BinaryDirtyRect[];
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

export type DecodedRemoteDesktopMessage = DecodedFrame | DecodedCursor;

/** `width * height * 4`, or `null` when the bytes cannot be in the buffer. */
function rgbaLen(width: number, height: number, remaining: number): number | null {
  const len = width * height * 4;
  return Number.isSafeInteger(len) && len <= remaining ? len : null;
}

function decodeFrame(view: DataView, buf: ArrayBuffer, base: number): DecodedFrame | null {
  if (view.byteLength < FRAME_HEADER_LEN) return null;
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const rects: BinaryDirtyRect[] = [];
  let offset = FRAME_HEADER_LEN;
  for (let i = 0; i < count; i++) {
    if (offset + RECT_HEADER_LEN > view.byteLength) return null;
    const x = view.getUint32(offset, true);
    const y = view.getUint32(offset + 4, true);
    const w = view.getUint32(offset + 8, true);
    const h = view.getUint32(offset + 12, true);
    offset += RECT_HEADER_LEN;
    const len = rgbaLen(w, h, view.byteLength - offset);
    if (len === null) return null;
    rects.push({ x, y, width: w, height: h, data: new Uint8ClampedArray(buf, base + offset, len) });
    offset += len;
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
 * or version, or a truncated message, so a bad message is dropped whole rather
 * than painted from misaligned bytes.
 */
export function decodeRemoteDesktopMessage(
  message: ArrayBuffer | ArrayBufferView
): DecodedRemoteDesktopMessage | null {
  const buf = ArrayBuffer.isView(message) ? (message.buffer as ArrayBuffer) : message;
  const base = ArrayBuffer.isView(message) ? message.byteOffset : 0;
  const length = message.byteLength;
  if (length < 4) return null;
  const view = new DataView(buf, base, length);
  if (view.getUint8(1) !== WIRE_VERSION) return null;
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
}

/**
 * Open the binary frame channel for one session in this window. Resolves with
 * an unsubscribe function once the backend has registered the channel, so a
 * caller can request a full frame knowing nothing will be missed.
 */
export async function subscribeRemoteDesktopFrames(
  sessionId: string,
  handlers: RemoteDesktopFrameHandlers
): Promise<() => void> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    const decoded = decodeRemoteDesktopMessage(message);
    if (decoded?.kind === "frame") handlers.onFrame(decoded);
    else if (decoded?.kind === "cursor") handlers.onCursor(decoded);
  };
  const subscriptionId = await invoke<number>("remote_desktop_subscribe_frames", {
    sessionId,
    channel,
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    // The session or window may already be gone; nothing is left to drop.
    fireAndForget(
      invoke("remote_desktop_unsubscribe_frames", { sessionId, subscriptionId }),
      `unsubscribe remote-desktop frames ${subscriptionId}`
    );
  };
}
