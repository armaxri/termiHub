import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { frontendError } from "@/utils/frontendLog";
import {
  canDecodeJpegRects,
  decodeRemoteDesktopMessage,
  subscribeRemoteDesktopFrames,
  KIND_CURSOR,
  KIND_FRAME,
  RECT_ENCODING_JPEG,
  RECT_ENCODING_RGBA,
  WIRE_VERSION,
  type DecodedCursor,
  type DecodedFrame,
  type FrameRect,
  type JpegDirtyRect,
} from "./remoteDesktopFrames";

vi.mock("@/utils/frontendLog", () => ({
  fireAndForget: vi.fn((p: Promise<unknown>) => void p.catch(() => {})),
  frontendError: vi.fn(),
}));

// A minimal stand-in for the Tauri `Channel`: records itself so a test can push
// messages into its `onmessage` like the IPC layer would.
const channels: Array<{ onmessage: (m: ArrayBuffer) => void }> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (m: ArrayBuffer) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));

/** Little-endian writer mirroring the Rust encoder in remote_desktop_frames.rs. */
function message(bytes: number[], words: number[], tail: Uint8Array[] = []): ArrayBuffer {
  const tailLen = tail.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(bytes.length + words.length * 4 + tailLen);
  out.set(bytes);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(bytes.length + i * 4, w, true));
  let offset = bytes.length + words.length * 4;
  for (const t of tail) {
    out.set(t, offset);
    offset += t.length;
  }
  return out.buffer;
}

function rgba(n: number, fill: (i: number) => number = () => 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => fill(i));
}

describe("decodeRemoteDesktopMessage — frames", () => {
  it("reconstructs the framebuffer size, each rect and its pixels", () => {
    // Same bytes as the Rust `frame_encodes_header_then_each_rect_and_its_payload`.
    const buf = new Uint8Array([
      ...new Uint8Array(message([KIND_FRAME, WIRE_VERSION, 0, 0], [640, 480, 2])),
      ...new Uint8Array(message([], [10, 20, 2, 1, RECT_ENCODING_RGBA, 8])),
      ...rgba(8, () => 0xab),
      ...new Uint8Array(message([], [0, 0, 1, 1, RECT_ENCODING_RGBA, 4])),
      ...rgba(4, () => 0x07),
    ]).buffer;

    const frame = decodeRemoteDesktopMessage(buf) as DecodedFrame;
    expect(frame.kind).toBe("frame");
    expect([frame.width, frame.height]).toEqual([640, 480]);
    expect(frame.rects).toHaveLength(2);
    const [a, b] = frame.rects;
    expect([a.x, a.y, a.width, a.height]).toEqual([10, 20, 2, 1]);
    expect(Array.from(a.data)).toEqual(new Array(8).fill(0xab));
    expect([b.x, b.y, b.width, b.height]).toEqual([0, 0, 1, 1]);
    expect(Array.from(b.data)).toEqual([7, 7, 7, 7]);
  });

  it("hands pixels over as a Uint8ClampedArray view, not a copy or a number array", () => {
    const buf = message(
      [KIND_FRAME, WIRE_VERSION, 0, 0],
      [4, 4, 1, 1, 2, 2, 1, RECT_ENCODING_RGBA, 8],
      [rgba(8, (i) => i)]
    );
    const rect = (decodeRemoteDesktopMessage(buf) as DecodedFrame).rects[0];
    expect(rect.data).toBeInstanceOf(Uint8ClampedArray);
    expect(rect.data.buffer).toBe(buf);
    expect(rect.data.byteOffset).toBe(40);
    expect(Array.from(rect.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("decodes a full 1080p frame at ~1x its RGBA size", () => {
    const pixels = 1920 * 1080 * 4;
    const buf = message(
      [KIND_FRAME, WIRE_VERSION, 0, 0],
      [1920, 1080, 1, 0, 0, 1920, 1080, RECT_ENCODING_RGBA, pixels],
      [new Uint8Array(pixels).fill(200)]
    );
    expect(buf.byteLength).toBe(pixels + 40);
    expect(buf.byteLength / pixels).toBeLessThan(1.001);
    const rect = (decodeRemoteDesktopMessage(buf) as DecodedFrame).rects[0];
    expect(rect.data.length).toBe(pixels);
    expect(rect.data[pixels - 1]).toBe(200);
  });

  it("decodes an empty keep-alive frame", () => {
    const frame = decodeRemoteDesktopMessage(
      message([KIND_FRAME, WIRE_VERSION, 0, 0], [8, 8, 0])
    ) as DecodedFrame;
    expect(frame.rects).toEqual([]);
  });

  it("drops a truncated frame whole instead of painting misaligned bytes", () => {
    const head = [KIND_FRAME, WIRE_VERSION, 0, 0];
    const short = message(head, [4, 4, 1, 0, 0, 2, 2, RECT_ENCODING_RGBA, 16], [rgba(15)]);
    expect(decodeRemoteDesktopMessage(short)).toBeNull();
    const missingRect = message(head, [4, 4, 2, 0, 0, 1, 1, RECT_ENCODING_RGBA, 4], [rgba(4)]);
    expect(decodeRemoteDesktopMessage(missingRect)).toBeNull();
    expect(decodeRemoteDesktopMessage(message(head, [4]))).toBeNull();
    // A JPEG payload whose zero padding is missing is truncated too.
    const unpadded = message(head, [4, 4, 1, 0, 0, 1, 1, RECT_ENCODING_JPEG, 5], [rgba(5)]);
    expect(decodeRemoteDesktopMessage(unpadded)).toBeNull();
  });

  it("drops an RGBA rect whose length does not match its size, and an unknown encoding", () => {
    const head = [KIND_FRAME, WIRE_VERSION, 0, 0];
    const wrongLen = message(head, [4, 4, 1, 0, 0, 2, 2, RECT_ENCODING_RGBA, 4], [rgba(4)]);
    expect(decodeRemoteDesktopMessage(wrongLen)).toBeNull();
    const unknown = message(head, [4, 4, 1, 0, 0, 1, 1, 7, 4], [rgba(4)]);
    expect(decodeRemoteDesktopMessage(unknown)).toBeNull();
  });

  it("decodes a JPEG rect as a view onto its bytes and skips its padding", () => {
    // Same bytes as the Rust `jpeg_rect_is_sent_compressed_and_zero_padded_when_allowed`.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0x03]);
    const buf = new Uint8Array([
      ...new Uint8Array(message([KIND_FRAME, WIRE_VERSION, 0, 0], [64, 64, 2])),
      ...new Uint8Array(message([], [1, 2, 3, 4, RECT_ENCODING_JPEG, 5])),
      ...jpeg,
      0,
      0,
      0,
      ...new Uint8Array(message([], [0, 0, 1, 1, RECT_ENCODING_RGBA, 4])),
      ...rgba(4, () => 0x07),
    ]).buffer;
    const frame = decodeRemoteDesktopMessage(buf) as DecodedFrame;
    expect(frame.rects).toHaveLength(2);
    const [a, b] = frame.rects as [JpegDirtyRect, FrameRect];
    expect(a).toMatchObject({ x: 1, y: 2, width: 3, height: 4, encoding: "jpeg" });
    expect(a.data).toBeInstanceOf(Uint8Array);
    expect(a.data.buffer).toBe(buf);
    expect(Array.from(a.data)).toEqual(Array.from(jpeg));
    expect(b.encoding).toBeUndefined();
    expect(Array.from(b.data)).toEqual([7, 7, 7, 7]);
  });

  it("rejects an unknown kind and a message shorter than its header", () => {
    expect(decodeRemoteDesktopMessage(message([9, WIRE_VERSION, 0, 0], [1, 1, 0]))).toBeNull();
    expect(decodeRemoteDesktopMessage(new Uint8Array([KIND_FRAME]).buffer)).toBeNull();
  });

  it("reports another wire version as a mismatch instead of decoding it", () => {
    // A version-1 frame (the pre-#4424 16-byte rect header).
    const v1 = message([KIND_FRAME, 1, 0, 0], [1, 1, 1, 0, 0, 1, 1], [rgba(4)]);
    expect(decodeRemoteDesktopMessage(v1)).toEqual({ kind: "wire-mismatch", version: 1 });
    const future = message([KIND_CURSOR, WIRE_VERSION + 1, 0, 0], [0, 0]);
    expect(decodeRemoteDesktopMessage(future)).toEqual({
      kind: "wire-mismatch",
      version: WIRE_VERSION + 1,
    });
  });
});

describe("decodeRemoteDesktopMessage — cursor", () => {
  it("reconstructs position, visibility, hotspot and shape pixels", () => {
    const buf = message(
      [KIND_CURSOR, WIRE_VERSION, 0b11, 0],
      [100, 200, 2, 2, 1, 0],
      [rgba(16, (i) => i)]
    );
    const cursor = decodeRemoteDesktopMessage(buf) as DecodedCursor;
    expect(cursor).toMatchObject({ kind: "cursor", x: 100, y: 200, visible: true });
    expect(cursor.shape).toMatchObject({ width: 2, height: 2, hotspotX: 1, hotspotY: 0 });
    expect(cursor.shape?.data).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(cursor.shape?.data ?? [])).toEqual(Array.from(rgba(16, (i) => i)));
  });

  it("decodes a position-only hidden cursor without a shape", () => {
    const cursor = decodeRemoteDesktopMessage(
      message([KIND_CURSOR, WIRE_VERSION, 0, 0], [3, 4])
    ) as DecodedCursor;
    expect(cursor).toEqual({ kind: "cursor", x: 3, y: 4, visible: false });
  });

  it("drops a cursor whose shape is truncated", () => {
    const buf = message([KIND_CURSOR, WIRE_VERSION, 0b11, 0], [0, 0, 4, 4, 0, 0], [rgba(10)]);
    expect(decodeRemoteDesktopMessage(buf)).toBeNull();
  });
});

describe("subscribeRemoteDesktopFrames", () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  beforeEach(() => {
    channels.length = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(frontendError).mockReset();
    globalThis.createImageBitmap = vi.fn() as unknown as typeof createImageBitmap;
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  });

  it("opens a channel for the session and routes decoded frames and cursors", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(7);
    const onFrame = vi.fn();
    const onCursor = vi.fn();
    const sub = await subscribeRemoteDesktopFrames("sess-1", { onFrame, onCursor });

    expect(invoke).toHaveBeenCalledWith("remote_desktop_subscribe_frames", {
      sessionId: "sess-1",
      channel: channels[0],
      wireVersion: WIRE_VERSION,
      acceptJpeg: true,
    });
    expect(sub.acceptsJpeg).toBe(true);
    channels[0].onmessage(message([KIND_FRAME, WIRE_VERSION, 0, 0], [2, 2, 0]));
    channels[0].onmessage(message([KIND_CURSOR, WIRE_VERSION, 1, 0], [1, 1]));
    channels[0].onmessage(message([42, WIRE_VERSION, 0, 0], [0]));
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0][0]).toMatchObject({ width: 2, height: 2 });
    expect(onCursor).toHaveBeenCalledOnce();

    vi.mocked(invoke).mockResolvedValue(undefined);
    sub.unsubscribe();
    sub.unsubscribe();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("remote_desktop_unsubscribe_frames", {
      sessionId: "sess-1",
      subscriptionId: 7,
    });
  });

  it("does not ask for JPEG rects when createImageBitmap is unavailable", async () => {
    // @ts-expect-error -- simulate a webview without createImageBitmap
    delete globalThis.createImageBitmap;
    expect(canDecodeJpegRects()).toBe(false);
    vi.mocked(invoke).mockResolvedValueOnce(3);
    const sub = await subscribeRemoteDesktopFrames("s", { onFrame: vi.fn(), onCursor: vi.fn() });
    expect(sub.acceptsJpeg).toBe(false);
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ acceptJpeg: false });
  });

  it("switches the subscription to RGBA on disableJpeg", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(9);
    const sub = await subscribeRemoteDesktopFrames("s", { onFrame: vi.fn(), onCursor: vi.fn() });
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await sub.disableJpeg();
    expect(invoke).toHaveBeenLastCalledWith("remote_desktop_set_frame_jpeg", {
      sessionId: "s",
      subscriptionId: 9,
      acceptJpeg: false,
    });
  });

  it("reports a wire-version mismatch loudly, once, and drops those messages", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(1);
    const onFrame = vi.fn();
    const onWireMismatch = vi.fn();
    await subscribeRemoteDesktopFrames("s", { onFrame, onCursor: vi.fn(), onWireMismatch });
    const v1 = message([KIND_FRAME, 1, 0, 0], [2, 2, 0]);
    channels[0].onmessage(v1);
    channels[0].onmessage(v1);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onWireMismatch).toHaveBeenCalledOnce();
    expect(onWireMismatch).toHaveBeenCalledWith(1);
    expect(frontendError).toHaveBeenCalledOnce();
    expect(vi.mocked(frontendError).mock.calls[0][1]).toMatch(/wire version mismatch/);
  });
});
