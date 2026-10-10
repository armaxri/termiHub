import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REATTACH_FIT_TIME_BOUND_MS,
  REATTACH_FRAME_FALLBACK_MS,
  waitForUsableDimensions,
} from "./waitForUsableDimensions";

/** A fake xterm + FitAddon pair: `fit()` applies whatever is currently proposed. */
function fakeTerminal(initial: { cols: number; rows: number } | undefined) {
  let proposed = initial;
  const xterm = { cols: 2 };
  const fitAddon = {
    proposeDimensions: vi.fn(() => proposed),
    fit: vi.fn(() => {
      if (proposed) xterm.cols = proposed.cols;
    }),
  };
  return {
    xterm,
    fitAddon,
    setProposed: (dims: { cols: number; rows: number } | undefined) => {
      proposed = dims;
    },
  };
}

describe("waitForUsableDimensions (#4381, WA-FE2-008)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A hidden / occluded window: requestAnimationFrame is registered but never fires.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1)
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ends at the wall-clock bound when rAF never fires (occluded window)", async () => {
    const { xterm, fitAddon } = fakeTerminal({ cols: 2, rows: 1 });
    const onDone = vi.fn();
    void waitForUsableDimensions(xterm, fitAddon, () => false).then(onDone);

    await vi.advanceTimersByTimeAsync(REATTACH_FIT_TIME_BOUND_MS - REATTACH_FRAME_FALLBACK_MS);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * REATTACH_FRAME_FALLBACK_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps advancing under rAF throttling and returns once the slot becomes usable", async () => {
    const t = fakeTerminal({ cols: 2, rows: 1 });
    const onDone = vi.fn();
    void waitForUsableDimensions(t.xterm, t.fitAddon, () => false).then(onDone);

    await vi.advanceTimersByTimeAsync(REATTACH_FRAME_FALLBACK_MS * 3);
    expect(onDone).not.toHaveBeenCalled();
    // The slot remounts into a real container mid-wait.
    t.setProposed({ cols: 120, rows: 40 });
    await vi.advanceTimersByTimeAsync(REATTACH_FRAME_FALLBACK_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(t.xterm.cols).toBe(120);
  });

  it("never fits against a degenerate proposal (gated on isProposedFitSafe)", async () => {
    // A narrow transitional container: full height, ~0 width → cols=2.
    const t = fakeTerminal({ cols: 2, rows: 36 });
    void waitForUsableDimensions(t.xterm, t.fitAddon, () => false);
    await vi.advanceTimersByTimeAsync(REATTACH_FIT_TIME_BOUND_MS + 500);
    expect(t.fitAddon.proposeDimensions).toHaveBeenCalled();
    expect(t.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("does not fit when the container cannot be measured", async () => {
    const t = fakeTerminal(undefined);
    void waitForUsableDimensions(t.xterm, t.fitAddon, () => false);
    await vi.advanceTimersByTimeAsync(REATTACH_FIT_TIME_BOUND_MS + 500);
    expect(t.fitAddon.fit).not.toHaveBeenCalled();
  });

  it("returns immediately when the slot is already usable", async () => {
    const t = fakeTerminal({ cols: 80, rows: 24 });
    await waitForUsableDimensions(t.xterm, t.fitAddon, () => false);
    expect(t.fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(t.xterm.cols).toBe(80);
  });

  it("stops promptly once canceled", async () => {
    const t = fakeTerminal({ cols: 2, rows: 1 });
    let canceled = false;
    const onDone = vi.fn();
    void waitForUsableDimensions(t.xterm, t.fitAddon, () => canceled).then(onDone);
    await vi.advanceTimersByTimeAsync(REATTACH_FRAME_FALLBACK_MS);
    canceled = true;
    await vi.advanceTimersByTimeAsync(REATTACH_FRAME_FALLBACK_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("still advances on rAF when frames do fire", async () => {
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        rafCb = cb;
        return 7;
      })
    );
    const t = fakeTerminal({ cols: 2, rows: 1 });
    const onDone = vi.fn();
    void waitForUsableDimensions(t.xterm, t.fitAddon, () => false).then(onDone);
    t.setProposed({ cols: 90, rows: 30 });
    (rafCb as FrameRequestCallback | null)?.(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
