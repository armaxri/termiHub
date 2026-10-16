import { describe, expect, it, vi } from "vitest";
import { createOrderedResize } from "./orderedResize";

/** A send whose invokes settle only when the test resolves them, in any order. */
function deferredSend() {
  const calls: {
    args: [string, number, number];
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  const send = vi.fn(
    (sessionId: string, cols: number, rows: number) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ args: [sessionId, cols, rows], resolve, reject });
      })
  );
  return { send, calls };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createOrderedResize", () => {
  it("sends a lone resize immediately", () => {
    const { send } = deferredSend();
    const resize = createOrderedResize(send, vi.fn());
    resize("s1", 85, 37);
    expect(send).toHaveBeenCalledExactlyOnceWith("s1", 85, 37);
  });

  it("never has two resizes in flight, so the backend cannot apply them reversed (#4841)", async () => {
    const { send, calls } = deferredSend();
    const resize = createOrderedResize(send, vi.fn());

    // The degenerate fit, then the real one, back to back.
    resize("s1", 2, 1);
    resize("s1", 85, 37);
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0].args).toEqual(["s1", 2, 1]);

    // Only once the first is applied does the real size go out, last.
    calls[0].resolve();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1].args).toEqual(["s1", 85, 37]);
  });

  it("coalesces resizes queued behind an in-flight one to the latest size", async () => {
    const { send, calls } = deferredSend();
    const resize = createOrderedResize(send, vi.fn());

    resize("s1", 80, 24);
    resize("s1", 2, 1);
    resize("s1", 100, 30);
    resize("s1", 117, 42);

    calls[0].resolve();
    await flush();
    expect(send.mock.calls).toEqual([
      ["s1", 80, 24],
      ["s1", 117, 42],
    ]);
    calls[1].resolve();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps delivering after a failed send and reports the failure", async () => {
    const { send, calls } = deferredSend();
    const onError = vi.fn();
    const resize = createOrderedResize(send, onError);

    resize("s1", 80, 24);
    resize("s1", 117, 42);
    const err = new Error("session gone");
    calls[0].reject(err);
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith(err, { sessionId: "s1", cols: 80, rows: 24 });
    expect(calls[1].args).toEqual(["s1", 117, 42]);
  });

  it("sends immediately again once the queue has drained", async () => {
    const { send, calls } = deferredSend();
    const resize = createOrderedResize(send, vi.fn());

    resize("s1", 80, 24);
    calls[0].resolve();
    await flush();

    resize("s2", 90, 30);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1].args).toEqual(["s2", 90, 30]);
  });
});
