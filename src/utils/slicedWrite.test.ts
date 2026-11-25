import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { WRITE_SLICE_BYTES, writeSliced } from "./slicedWrite";

describe("writeSliced", () => {
  function target(refuseFrom = Infinity) {
    const writes: Uint8Array[] = [];
    const callbacks: (() => void)[] = [];
    return {
      writes,
      callbacks,
      write(data: Uint8Array, callback?: () => void) {
        if (writes.length >= refuseFrom) throw new Error("full");
        writes.push(data);
        if (callback) callbacks.push(callback);
      },
    };
  }
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
  const joined = (parts: Uint8Array[]) => parts.flatMap((p) => Array.from(p));

  it("writes everything in order, no slice above the limit", () => {
    const t = target();
    const batch = bytes(2 * WRITE_SLICE_BYTES + 7);
    expect(writeSliced(t, batch, () => {})).toBeNull();
    expect(t.writes.map((w) => w.length)).toEqual([WRITE_SLICE_BYTES, WRITE_SLICE_BYTES, 7]);
    expect(joined(t.writes)).toEqual(Array.from(batch));
  });

  it("reports each parsed slice and marks only the last one", () => {
    const t = target();
    const onParsed = vi.fn();
    writeSliced(t, bytes(8), onParsed, 4);
    expect(onParsed).not.toHaveBeenCalled();
    t.callbacks.forEach((cb) => cb());
    expect(onParsed.mock.calls).toEqual([
      [4, false],
      [4, true],
    ]);
  });

  it("hands back only what the terminal refused", () => {
    const t = target(1);
    const batch = bytes(10);
    const rest = writeSliced(t, batch, () => {}, 4);
    expect(Array.from(rest!.refused)).toEqual(Array.from(batch.subarray(4)));
    expect(rest!.error).toBeInstanceOf(Error);
  });

  it("lets other work run between the slices of a flood in a real xterm", async () => {
    const xterm = new Terminal({ cols: 80, rows: 24 });
    const batch = new TextEncoder().encode("y\r\n".repeat(400_000));
    let turns = 0;
    let running = true;
    const tick = () => {
      turns += 1;
      if (running) setTimeout(tick);
    };
    setTimeout(tick);
    const parsed: number[] = [];
    await new Promise<void>((resolve) => {
      writeSliced(xterm, batch, (n, last) => {
        parsed.push(n);
        if (last) resolve();
      });
    });
    running = false;
    expect(parsed.reduce((a, b) => a + b, 0)).toBe(batch.length);
    // As one chunk xterm parses it all in a single turn.
    expect(turns).toBeGreaterThan(2);
    xterm.dispose();
  });
});
