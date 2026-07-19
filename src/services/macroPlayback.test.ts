/**
 * Tests for the macro playback scheduler (#1675).
 *
 * Pins the timing-mode math ({@link computeStepDelay}) and the async scheduler
 * ({@link runMacroPlayback}): step ordering, per-mode delays, delay clamping,
 * cancellation (before and mid-delay), and the error path when injection fails.
 * The injector is mocked so no terminal or session is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeStepDelay,
  runMacroPlayback,
  DEFAULT_FIXED_DELAY_MS,
  MAX_STEP_DELAY_MS,
  registerTerminalInputInjector,
  getTerminalInputInjector,
  type MacroPlaybackOptions,
} from "./macroPlayback";
import type { MacroStep } from "@/types/macro";

const steps = (delays: number[]): MacroStep[] =>
  delays.map((delayMs, i) => ({ data: `s${i}`, delayMs }));

describe("computeStepDelay", () => {
  const step = (delayMs: number): MacroStep => ({ data: "x", delayMs });

  it("plays the first step immediately in every mode", () => {
    for (const timingMode of ["real-time", "fixed", "instant"] as const) {
      expect(computeStepDelay(step(999), 0, { timingMode })).toBe(0);
    }
  });

  it("real-time honours the recorded delay", () => {
    expect(computeStepDelay(step(250), 3, { timingMode: "real-time" })).toBe(250);
  });

  it("real-time clamps oversized recorded delays to maxDelayMs", () => {
    expect(computeStepDelay(step(600_000), 1, { timingMode: "real-time" })).toBe(MAX_STEP_DELAY_MS);
    expect(computeStepDelay(step(600_000), 1, { timingMode: "real-time", maxDelayMs: 100 })).toBe(
      100
    );
  });

  it("real-time floors negative delays at zero", () => {
    expect(computeStepDelay(step(-50), 2, { timingMode: "real-time" })).toBe(0);
  });

  it("fixed uses a constant per-step delay regardless of recorded timing", () => {
    expect(computeStepDelay(step(9999), 2, { timingMode: "fixed" })).toBe(DEFAULT_FIXED_DELAY_MS);
    expect(computeStepDelay(step(9999), 2, { timingMode: "fixed", fixedDelayMs: 100 })).toBe(100);
  });

  it("instant never delays", () => {
    expect(computeStepDelay(step(9999), 5, { timingMode: "instant" })).toBe(0);
  });
});

describe("runMacroPlayback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects every step in order for instant mode", async () => {
    const inject = vi.fn(async (_data: string) => true);
    const handle = runMacroPlayback(steps([0, 100, 200]), inject, { timingMode: "instant" });
    const result = await handle.done;

    expect(result).toEqual({ status: "completed", stepsPlayed: 3 });
    expect(inject.mock.calls.map((c) => c[0])).toEqual(["s0", "s1", "s2"]);
  });

  it("waits the recorded delay between steps in real-time mode", async () => {
    const inject = vi.fn(async () => true);
    const opts: MacroPlaybackOptions = { timingMode: "real-time" };
    const handle = runMacroPlayback(steps([0, 500]), inject, opts);

    // First step fires immediately (delay 0).
    await vi.advanceTimersByTimeAsync(0);
    expect(inject).toHaveBeenCalledTimes(1);

    // Second step waits 500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(inject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(inject).toHaveBeenCalledTimes(2);

    expect(await handle.done).toEqual({ status: "completed", stepsPlayed: 2 });
  });

  it("reports progress after each injected step", async () => {
    const inject = vi.fn(async () => true);
    const onProgress = vi.fn();
    const handle = runMacroPlayback(
      steps([0, 0, 0]),
      inject,
      { timingMode: "instant" },
      {
        onProgress,
      }
    );
    await handle.done;

    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("stops promptly when cancelled during a delay", async () => {
    const inject = vi.fn(async () => true);
    const handle = runMacroPlayback(steps([0, 10_000]), inject, { timingMode: "real-time" });

    await vi.advanceTimersByTimeAsync(0);
    expect(inject).toHaveBeenCalledTimes(1);

    handle.cancel();
    const result = await handle.done;

    expect(result).toEqual({ status: "cancelled", stepsPlayed: 1 });
    // No further injection despite the 10s delay never elapsing.
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("does not inject anything when cancelled before it starts", async () => {
    const inject = vi.fn(async () => true);
    const handle = runMacroPlayback(steps([0, 0]), inject, { timingMode: "instant" });
    handle.cancel();
    const result = await handle.done;

    expect(result.status).toBe("cancelled");
    expect(inject).not.toHaveBeenCalled();
  });

  it("aborts with an error when injection reports failure", async () => {
    const inject = vi
      .fn<(data: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handle = runMacroPlayback(steps([0, 0, 0]), inject, { timingMode: "instant" });
    const result = await handle.done;

    expect(result).toEqual({ status: "error", stepsPlayed: 1 });
    // The third step is never attempted after the second fails.
    expect(inject).toHaveBeenCalledTimes(2);
  });
});

describe("terminal input injector registry", () => {
  afterEach(() => {
    registerTerminalInputInjector(null);
  });

  it("stores and clears the registered injector", async () => {
    expect(getTerminalInputInjector()).toBeNull();

    const fn = vi.fn(async () => true);
    registerTerminalInputInjector(fn);
    expect(getTerminalInputInjector()).toBe(fn);

    registerTerminalInputInjector(null);
    expect(getTerminalInputInjector()).toBeNull();
  });
});
