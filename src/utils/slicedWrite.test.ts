import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { WRITE_SLICE_BYTES, writeAllSliced, writeSliced } from "./slicedWrite";
import { TerminalOutputFlow } from "./terminalFlowControl";

describe("writeSliced", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    try {
      await new Promise<void>((resolve) => {
        writeSliced(xterm, batch, (n, last) => {
          parsed.push(n);
          if (last) resolve();
        });
      });
    } finally {
      running = false;
    }
    expect(parsed.reduce((a, b) => a + b, 0)).toBe(batch.length);
    // As one chunk xterm parses it all in a single turn.
    expect(turns).toBeGreaterThan(2);
    xterm.dispose();
  });

  it("writes a hidden document's batch as one chunk, and slices again once shown", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const t = target();
    const onParsed = vi.fn();
    const batch = bytes(3 * WRITE_SLICE_BYTES);
    writeSliced(t, batch, onParsed);
    expect(t.writes).toEqual([batch]);
    t.callbacks[0]();
    expect(onParsed.mock.calls).toEqual([[batch.length, true]]);

    hidden.mockReturnValue(false);
    writeSliced(t, batch, onParsed);
    expect(t.writes).toHaveLength(4);
  });

  it("writes a whole scrollback in slices and says once when all of it is parsed (#6087)", () => {
    const t = target();
    const done = vi.fn();
    writeAllSliced(t, bytes(2 * WRITE_SLICE_BYTES), done);
    expect(t.writes.map((w) => w.length)).toEqual([WRITE_SLICE_BYTES, WRITE_SLICE_BYTES]);
    t.callbacks[0]();
    expect(done).not.toHaveBeenCalled();
    t.callbacks[1]();
    expect(done).toHaveBeenCalledOnce();
    writeAllSliced(t, new Uint8Array(), done);
    expect(done).toHaveBeenCalledTimes(1);
    t.callbacks[2]();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("slices a text scrollback, never inside a character (#6087)", async () => {
    const xterm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const writes: string[] = [];
    const target = {
      write: (data: Uint8Array | string, done?: () => void) => {
        writes.push(data as string);
        xterm.write(data, done);
      },
    };
    const text = "ab\ud83d\ude00cd";
    await new Promise<void>((resolve) => writeAllSliced(target, text, resolve, 3));
    expect(writes).toEqual(["ab", "\ud83d\ude00c", "d"]);
    expect(xterm.buffer.active.getLine(0)!.translateToString(true)).toBe(text);
    xterm.dispose();
  });

  it("throws what the terminal refused a scrollback with, as one write did (#6087)", () => {
    expect(() => writeAllSliced(target(1), bytes(2 * WRITE_SLICE_BYTES), () => {})).toThrow("full");
  });

  it("keeps a multibyte character that a slice boundary splits", async () => {
    const xterm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const text = "a\u00e9\u65e5\ud83d\ude00z";
    await new Promise<void>((resolve) => {
      writeSliced(xterm, new TextEncoder().encode(text), (_n, last) => last && resolve(), 1);
    });
    expect(xterm.buffer.active.getLine(0)!.translateToString(true)).toBe(text);
    xterm.dispose();
  });

  it("calls who waits for the output only once every slice of it is parsed", async () => {
    const xterm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const flow = new TerminalOutputFlow({ onPausedChange: () => {} });
    flow.push(new TextEncoder().encode("0123456789"));
    const screen = () => xterm.buffer.active.getLine(0)!.translateToString(true);
    const seen: string[] = [];
    flow.whenShown(() => seen.push(screen()));
    flow.push(new TextEncoder().encode("later"));
    const write = () =>
      new Promise<void>((resolve) => {
        writeSliced(
          xterm,
          flow.takeBatch()!,
          (n, last) => {
            flow.written(n);
            if (last) resolve();
          },
          3
        );
      });
    await write();
    expect(seen).toEqual(["0123456789"]);
    await write();
    expect(screen()).toBe("0123456789later");
    expect(seen).toHaveLength(1);
    xterm.dispose();
  });
});
