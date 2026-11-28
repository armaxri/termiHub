/**
 * Dwell-to-switch timing (tab-groups concept, #6201): hovering a dragged tab
 * over another group's chip for 500 ms switches to that group.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDwellTimer, GROUP_DWELL_MS } from "./dwellTimer";

describe("createDwellTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is 500 ms, as the concept says", () => {
    expect(GROUP_DWELL_MS).toBe(500);
  });

  it("fires once the pointer has stayed over one target for the dwell", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    vi.advanceTimersByTime(499);
    expect(onDwell).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDwell).toHaveBeenCalledExactlyOnceWith("g2");
  });

  it("keeps the timer running while the pointer moves within the same target", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    vi.advanceTimersByTime(300);
    dwell.hover("g2"); // another drag-move over the same chip
    vi.advanceTimersByTime(200);
    expect(onDwell).toHaveBeenCalledExactlyOnceWith("g2");
  });

  it("switches nothing when the pointer leaves before the dwell", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    vi.advanceTimersByTime(400);
    dwell.hover(null);
    vi.advanceTimersByTime(1000);
    expect(onDwell).not.toHaveBeenCalled();
  });

  it("restarts the dwell for a different target", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    vi.advanceTimersByTime(400);
    dwell.hover("g3");
    vi.advanceTimersByTime(400);
    expect(onDwell).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onDwell).toHaveBeenCalledExactlyOnceWith("g3");
  });

  it("fires once per stay, not again while the pointer rests", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    vi.advanceTimersByTime(500);
    dwell.hover("g2");
    vi.advanceTimersByTime(2000);
    expect(onDwell).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a pending switch (the drag ended)", () => {
    const onDwell = vi.fn();
    const dwell = createDwellTimer(GROUP_DWELL_MS, onDwell);
    dwell.hover("g2");
    dwell.cancel();
    vi.advanceTimersByTime(1000);
    expect(onDwell).not.toHaveBeenCalled();
  });
});
