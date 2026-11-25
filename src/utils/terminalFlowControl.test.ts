import { describe, it, expect, vi } from "vitest";
import type { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";
import { TerminalOutputFlow, createFlowSignal } from "./terminalFlowControl";

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

function makeFlow(overrides: Partial<ConstructorParameters<typeof TerminalOutputFlow>[0]> = {}) {
  const pausedChanges: boolean[] = [];
  const overflows: number[] = [];
  const flow = new TerminalOutputFlow({
    highWatermark: 100,
    lowWatermark: 20,
    maxStagedBytes: 1000,
    onPausedChange: (p) => pausedChanges.push(p),
    onOverflow: (n) => overflows.push(n),
    ...overrides,
  });
  return { flow, pausedChanges, overflows };
}

describe("TerminalOutputFlow watermarks (PERF2-002)", () => {
  it("passes small output straight through without pausing", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(10));
    const batch = flow.takeBatch();
    expect(batch?.length).toBe(10);
    flow.written(10);
    expect(pausedChanges).toEqual([]);
    expect(flow.paused).toBe(false);
  });

  it("pauses once unparsed bytes exceed the high watermark", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(60));
    expect(flow.paused).toBe(false);
    flow.push(bytes(60));
    expect(flow.paused).toBe(true);
    expect(pausedChanges).toEqual([true]);
    // Further output while paused does not re-signal.
    flow.push(bytes(10));
    expect(pausedChanges).toEqual([true]);
  });

  it("counts bytes handed to xterm until their write callback fires", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(80));
    const first = flow.takeBatch();
    expect(first?.length).toBe(80);
    expect(flow.inflightBytes).toBe(80);
    // Still not parsed: 80 in flight + 40 staged > 100.
    flow.push(bytes(40));
    expect(pausedChanges).toEqual([true]);
  });

  it("resumes only once xterm drains below the low watermark", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(120));
    const batch = flow.takeBatch() as Uint8Array;
    expect(flow.paused).toBe(true);
    // A partial drain to 50 (> low 20) keeps it paused.
    flow.written(70);
    expect(flow.paused).toBe(true);
    flow.written(batch.length - 70);
    expect(flow.paused).toBe(false);
    expect(pausedChanges).toEqual([true, false]);
  });

  it("holds staged output while xterm's backlog is at the high watermark", () => {
    const { flow } = makeFlow();
    flow.push(bytes(100));
    expect(flow.takeBatch()?.length).toBe(100);
    flow.push(bytes(5));
    expect(flow.takeBatch()).toBeNull();
    expect(flow.hasStaged).toBe(true);
    flow.written(100);
    expect(flow.takeBatch()?.length).toBe(5);
  });

  it("force-takes staged output past the backlog limit for a final drain", () => {
    const { flow } = makeFlow();
    flow.push(bytes(100));
    flow.takeBatch();
    flow.push(bytes(5));
    expect(flow.takeBatch(true)?.length).toBe(5);
  });

  it("merges staged chunks into one batch in arrival order", () => {
    const { flow } = makeFlow();
    flow.push(new Uint8Array([1, 2]));
    flow.push(new Uint8Array([3]));
    flow.push(new Uint8Array([4, 5]));
    expect(Array.from(flow.takeBatch() as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    expect(flow.hasStaged).toBe(false);
  });

  it("puts a batch back in front when xterm refuses the write", () => {
    const { flow } = makeFlow();
    flow.push(new Uint8Array([1, 2]));
    const batch = flow.takeBatch() as Uint8Array;
    flow.push(new Uint8Array([3]));
    flow.restore(batch);
    expect(flow.inflightBytes).toBe(0);
    expect(Array.from(flow.takeBatch() as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("drops staged output and resumes the backend it had paused", () => {
    const { flow, pausedChanges } = makeFlow();
    for (let i = 0; i < 10; i++) flow.push(bytes(50, i));
    expect(flow.paused).toBe(true);
    flow.discardStaged();
    expect(flow.hasStaged).toBe(false);
    expect(flow.stagedBytes).toBe(0);
    expect(flow.paused).toBe(false);
    expect(pausedChanges).toEqual([true, false]);
  });

  it("stays paused after dropping staged output while xterm is behind", () => {
    const { flow } = makeFlow();
    for (let i = 0; i < 10; i++) flow.push(bytes(50, i));
    const batch = flow.takeBatch() as Uint8Array;
    flow.push(bytes(50));
    flow.discardStaged();
    expect(flow.paused).toBe(true);
    flow.written(batch.length);
    expect(flow.paused).toBe(false);
  });

  it("bounds the staged buffer under a flood whose producer ignores pause", () => {
    const { flow, overflows } = makeFlow();
    // Nothing is ever written to xterm: a pure flood of 100 x 50 bytes.
    for (let i = 0; i < 100; i++) flow.push(bytes(50, i));
    expect(flow.stagedBytes).toBeLessThanOrEqual(1000);
    expect(overflows.reduce((a, b) => a + b, 0)).toBe(100 * 50 - flow.stagedBytes);
    // The newest output is what is kept.
    const batch = flow.takeBatch() as Uint8Array;
    expect(batch[batch.length - 1]).toBe(99);
  });

  it("never drops output when the producer honours pause", () => {
    const { flow, overflows } = makeFlow();
    let sent = 0;
    let received = 0;
    // A producer that stops once paused, and a consumer that drains a batch
    // per tick: everything produced arrives.
    for (let tick = 0; tick < 200; tick++) {
      if (!flow.paused && sent < 5000) {
        flow.push(bytes(30));
        sent += 30;
      }
      const batch = flow.takeBatch();
      if (batch) {
        received += batch.length;
        flow.written(batch.length);
      }
    }
    expect(overflows).toEqual([]);
    expect(received).toBe(sent);
    expect(flow.stagedBytes + flow.inflightBytes).toBe(0);
  });

  it("resumes the backend on dispose when still paused", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(200));
    flow.dispose();
    expect(pausedChanges).toEqual([true, false]);
  });

  it("does not signal on dispose when not paused", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.dispose();
    expect(pausedChanges).toEqual([]);
  });
});

describe("who waits for the output received so far (#6070)", () => {
  it("is called at once when nothing is on its way", () => {
    const { flow } = makeFlow();
    const then = vi.fn();
    flow.whenShown(then);
    expect(then).toHaveBeenCalledOnce();
  });

  it("is called between that output and what came later", () => {
    const { flow } = makeFlow();
    flow.push(bytes(3));
    flow.push(bytes(2));
    const first = vi.fn();
    flow.whenShown(first);
    flow.push(bytes(4));
    const second = vi.fn();
    flow.whenShown(second);
    flow.push(bytes(1));
    expect(flow.takeBatch()?.length).toBe(5);
    expect(flow.takeBatch()?.length).toBe(4);
    expect(flow.takeBatch()?.length).toBe(1);
    flow.written(5);
    expect([first, second].map((f) => f.mock.calls.length)).toEqual([1, 0]);
    flow.written(4);
    expect([first, second].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it("waits on when xterm refuses the write", () => {
    const { flow } = makeFlow();
    flow.push(bytes(5));
    const then = vi.fn();
    flow.whenShown(then);
    flow.restore(flow.takeBatch()!);
    expect(then).not.toHaveBeenCalled();
    flow.written(flow.takeBatch()!.length);
    expect(then).toHaveBeenCalledOnce();
  });

  it("waits for the repaint that shows what was dropped for it", () => {
    const { flow, pausedChanges } = makeFlow();
    flow.push(bytes(5));
    const then = vi.fn();
    flow.whenShown(then);
    flow.discardStaged();
    const done = flow.repainting(500);
    const later = vi.fn();
    flow.whenShown(later);
    expect(then).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    done();
    expect(then).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(pausedChanges).toEqual([]);
  });

  it("counts a repaint that is not there yet behind output that came after it", () => {
    const { flow } = makeFlow();
    const done = flow.repainting(10);
    flow.push(bytes(5));
    const then = vi.fn();
    flow.whenShown(then);
    flow.written(flow.takeBatch()!.length);
    expect(then).not.toHaveBeenCalled();
    done();
    expect(then).toHaveBeenCalledOnce();
  });

  it("is never called when some of it was lost", () => {
    const { flow, overflows } = makeFlow();
    flow.push(bytes(600));
    const then = vi.fn();
    flow.whenShown(then);
    flow.push(bytes(600));
    expect(overflows).toEqual([600]);
    flow.written(flow.takeBatch()!.length);
    expect(then).not.toHaveBeenCalled();
  });

  it("does not hold back the final drain", () => {
    const { flow } = makeFlow();
    flow.push(bytes(5));
    flow.whenShown(() => {});
    flow.push(bytes(4));
    expect(flow.takeBatch(true)?.length).toBe(9);
  });
});

describe("createFlowSignal", () => {
  it("delivers pause/resume in order, one IPC call at a time", async () => {
    const calls: boolean[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const send = vi.fn(async (paused: boolean) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, paused ? 5 : 0));
      calls.push(paused);
      inFlight--;
    });
    const signal = createFlowSignal(send);
    signal(true);
    signal(false);
    signal(true);
    await signal.settled();
    expect(calls).toEqual([true, false, true]);
    expect(maxInFlight).toBe(1);
  });

  it("swallows a failing send and keeps later signals flowing", async () => {
    const calls: boolean[] = [];
    const send = vi.fn((paused: boolean) => {
      if (paused) throw new Error("session gone");
      calls.push(paused);
      return Promise.resolve();
    });
    const entries: LogEntry[] = [];
    const unsubscribe = onFrontendLog((e) => entries.push(e));
    const signal = createFlowSignal(send);
    signal(true);
    signal(false);
    await signal.settled();
    unsubscribe();
    expect(calls).toEqual([false]);
    // The failure is traced, not dropped (#4520).
    expect(entries.map((e) => e.message)).toContain("pause signal failed: session gone");
  });

  it("reports a failing send through onError and keeps the chain alive", async () => {
    const onError = vi.fn();
    const send = vi.fn((paused: boolean) =>
      paused ? Promise.reject(new Error("gone")) : Promise.resolve()
    );
    const signal = createFlowSignal(send, onError);
    signal(true);
    signal(false);
    await signal.settled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(true, new Error("gone"));
    expect(send).toHaveBeenCalledTimes(2);
  });
});
