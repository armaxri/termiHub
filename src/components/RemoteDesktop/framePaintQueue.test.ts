import { describe, it, expect, vi } from "vitest";
import type { DecodedFrame, FrameRect } from "@/services/remoteDesktopFrames";
import {
  createFramePaintQueue,
  decodeJpegWithImageBitmap,
  type ReadyRect,
} from "./framePaintQueue";

/** A settle-on-demand JPEG decode, so a test controls completion order. */
interface Deferred {
  bytes: Uint8Array;
  resolve: (bitmap: ImageBitmap) => void;
  reject: (err: Error) => void;
}

function controllableDecoder() {
  const calls: Deferred[] = [];
  const decode = vi.fn(
    (bytes: Uint8Array) =>
      new Promise<ImageBitmap>((resolve, reject) => calls.push({ bytes, resolve, reject }))
  );
  return { decode, calls };
}

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function raw(tag: number): FrameRect {
  return { x: tag, y: 0, width: 1, height: 1, data: new Uint8ClampedArray(4).fill(tag) };
}

function jpeg(tag: number, width = 2, height = 2): FrameRect {
  return { x: tag, y: 0, width, height, encoding: "jpeg", data: Uint8Array.of(0xff, tag) };
}

function frame(...rects: FrameRect[]): DecodedFrame {
  return { kind: "frame", width: 64, height: 64, rects };
}

/** Flush the promise callbacks a settled decode queued. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The painted rect tags (their `x`), one array per painted frame. */
function recorder() {
  const painted: number[][] = [];
  const paint = vi.fn((_f: DecodedFrame, rects: ReadyRect[]) => {
    painted.push(rects.map((r) => r.x));
  });
  return { painted, paint };
}

describe("createFramePaintQueue", () => {
  it("paints a raw-only frame synchronously when nothing is pending", () => {
    const { painted, paint } = recorder();
    const queue = createFramePaintQueue({ paint, onDecodeFailure: vi.fn() });
    queue.push(frame(raw(1), raw(2)));
    expect(painted).toEqual([[1, 2]]);
  });

  it("keeps server order across mixed async JPEG and raw rects", async () => {
    const { decode, calls } = controllableDecoder();
    const { painted, paint } = recorder();
    const queue = createFramePaintQueue({ paint, onDecodeFailure: vi.fn(), decode });

    queue.push(frame(jpeg(10)));
    queue.push(frame(raw(20)));
    queue.push(frame(jpeg(30), raw(31), jpeg(32)));
    queue.push(frame(raw(40)));
    // Decodes all start at once, but nothing overtakes the first JPEG.
    expect(calls).toHaveLength(3);
    expect(painted).toEqual([]);

    // The *later* decodes finish first: still nothing paints out of order.
    calls[2].resolve(bitmap(2, 2));
    calls[1].resolve(bitmap(2, 2));
    await tick();
    expect(painted).toEqual([]);

    // The first decode settles: everything queued behind it drains in order,
    // with each frame's rects in their own order too.
    calls[0].resolve(bitmap(2, 2));
    await tick();
    expect(painted).toEqual([[10], [20], [30, 31, 32], [40]]);

    // With the queue empty, a raw frame is synchronous again.
    queue.push(frame(raw(50)));
    expect(painted[painted.length - 1]).toEqual([50]);
  });

  it("hands each JPEG rect its decoded bitmap", async () => {
    const { decode, calls } = controllableDecoder();
    const paint = vi.fn();
    const queue = createFramePaintQueue({ paint, onDecodeFailure: vi.fn(), decode });
    queue.push(frame(jpeg(7)));
    expect(Array.from(calls[0].bytes)).toEqual([0xff, 7]);
    const bmp = bitmap(2, 2);
    calls[0].resolve(bmp);
    await tick();
    expect(paint.mock.calls[0][1][0]).toMatchObject({ x: 7, encoding: "jpeg", bitmap: bmp });
  });

  it("skips a rect whose decode fails, reports it once, and keeps painting in order", async () => {
    const { decode, calls } = controllableDecoder();
    const { painted, paint } = recorder();
    const onDecodeFailure = vi.fn();
    const queue = createFramePaintQueue({ paint, onDecodeFailure, decode });

    queue.push(frame(raw(1), jpeg(2)));
    queue.push(frame(jpeg(3)));
    queue.push(frame(raw(4)));
    calls[0].reject(new Error("corrupt"));
    calls[1].reject(new Error("corrupt"));
    await tick();

    // The failed JPEG rects are never drawn (no garbage); the rest still are.
    expect(painted).toEqual([[1], [], [4]]);
    expect(onDecodeFailure).toHaveBeenCalledOnce();
    expect(onDecodeFailure.mock.calls[0][0]).toMatch(/corrupt/);
  });

  it("treats a bitmap of the wrong size as a decode failure", async () => {
    const { decode, calls } = controllableDecoder();
    const { painted, paint } = recorder();
    const onDecodeFailure = vi.fn();
    const queue = createFramePaintQueue({ paint, onDecodeFailure, decode });
    queue.push(frame(jpeg(1, 4, 4)));
    const wrong = bitmap(8, 8);
    calls[0].resolve(wrong);
    await tick();
    expect(painted).toEqual([[]]);
    expect(wrong.close).toHaveBeenCalled();
    expect(onDecodeFailure.mock.calls[0][0]).toMatch(/8x8, expected 4x4/);
  });

  it("treats a decoder that throws synchronously as a decode failure", async () => {
    const { painted, paint } = recorder();
    const onDecodeFailure = vi.fn();
    const decode = () => {
      throw new Error("boom");
    };
    const queue = createFramePaintQueue({ paint, onDecodeFailure, decode });
    queue.push(frame(jpeg(1), raw(2)));
    await tick();
    expect(painted).toEqual([[2]]);
    expect(onDecodeFailure).toHaveBeenCalledOnce();
  });

  it("drops queued frames on dispose and closes late bitmaps", async () => {
    const { decode, calls } = controllableDecoder();
    const { painted, paint } = recorder();
    const onDecodeFailure = vi.fn();
    const queue = createFramePaintQueue({ paint, onDecodeFailure, decode });
    queue.push(frame(jpeg(1)));
    queue.push(frame(raw(2)));
    queue.dispose();
    const late = bitmap(2, 2);
    calls[0].resolve(late);
    await tick();
    queue.push(frame(raw(3)));
    expect(painted).toEqual([]);
    expect(late.close).toHaveBeenCalled();
    expect(onDecodeFailure).not.toHaveBeenCalled();
  });
});

describe("decodeJpegWithImageBitmap", () => {
  it("rejects when createImageBitmap is unavailable", async () => {
    const original = globalThis.createImageBitmap;
    // @ts-expect-error -- simulate a webview without createImageBitmap
    delete globalThis.createImageBitmap;
    try {
      await expect(decodeJpegWithImageBitmap(Uint8Array.of(1))).rejects.toThrow(
        /createImageBitmap is unavailable/
      );
    } finally {
      globalThis.createImageBitmap = original;
    }
  });

  it("decodes the bytes as an image/jpeg blob", async () => {
    const original = globalThis.createImageBitmap;
    const bmp = bitmap(1, 1);
    const spy = vi.fn(() => Promise.resolve(bmp));
    globalThis.createImageBitmap = spy as unknown as typeof createImageBitmap;
    try {
      await expect(decodeJpegWithImageBitmap(Uint8Array.of(0xff, 0xd8))).resolves.toBe(bmp);
      const blob = (spy.mock.calls[0] as unknown as [Blob])[0];
      expect(blob.type).toBe("image/jpeg");
      expect(blob.size).toBe(2);
    } finally {
      globalThis.createImageBitmap = original;
    }
  });
});
