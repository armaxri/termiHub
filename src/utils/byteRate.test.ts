import { describe, it, expect } from "vitest";
import {
  blendRate,
  etaFromRate,
  sampleRate,
  MIN_RATE_SAMPLE_MS,
  RATE_TAU_MS,
  type RateEstimate,
} from "./byteRate";

describe("blendRate (PROD-038)", () => {
  it("seeds with the instantaneous rate when there is no previous rate", () => {
    expect(blendRate(null, 1000, 1000)).toBe(1000);
  });

  it("weights a sample by its elapsed time", () => {
    // Δt = τ → alpha = 1 - 1/e ≈ 0.632.
    const r = blendRate(1000, 3 * RATE_TAU_MS, RATE_TAU_MS) as number;
    const alpha = 1 - Math.exp(-1);
    expect(r).toBeCloseTo(alpha * 3000 + (1 - alpha) * 1000, 6);
  });

  it("damps a burst of bytes arriving in a few milliseconds", () => {
    // 500 bytes in 5 ms is an instantaneous 100 000 B/s, but barely moves 1000 B/s.
    const r = blendRate(1000, 500, 5) as number;
    expect(r).toBeGreaterThan(1000);
    expect(r).toBeLessThan(1200);
  });

  it("decays toward zero over a long zero-progress stall", () => {
    expect(blendRate(5000, 0, 60_000)).toBe(0);
    const partial = blendRate(5000, 0, 1000) as number;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(5000);
  });

  it("ignores a zero/negative interval or a negative delta", () => {
    expect(blendRate(700, 100, 0)).toBe(700);
    expect(blendRate(700, 100, -5)).toBe(700);
    expect(blendRate(700, -100, 1000)).toBe(700);
    expect(blendRate(null, 100, 0)).toBeNull();
  });
});

describe("sampleRate (PROD-038)", () => {
  it("needs two samples before reporting a rate", () => {
    const first = sampleRate(null, 0, 0);
    expect(first.rate).toBeNull();
    const second = sampleRate(first, 2000, 1000);
    expect(second.rate).toBe(2000);
  });

  it("coalesces samples closer together than the minimum interval", () => {
    let est: RateEstimate = sampleRate(null, 0, 0);
    est = sampleRate(est, 1000, 1000);
    const before = est;
    // A burst of updates within MIN_RATE_SAMPLE_MS is folded into the next sample.
    est = sampleRate(est, 1500, 1000 + MIN_RATE_SAMPLE_MS - 1);
    expect(est).toBe(before);
    est = sampleRate(est, 2000, 2000);
    // The coalesced bytes land in the accepted delta: 1000 B over 1 s.
    expect(est.lastBytes).toBe(2000);
    expect(est.rate).toBeCloseTo(1000, 6);
  });

  it("reports zero-progress samples as a falling rate", () => {
    let est: RateEstimate = sampleRate(null, 0, 0);
    est = sampleRate(est, 4000, 1000);
    est = sampleRate(est, 4000, 2000);
    expect(est.rate).toBeGreaterThan(0);
    expect(est.rate).toBeLessThan(4000);
  });

  it("reseeds when the counter goes backwards (source restarted)", () => {
    let est: RateEstimate = sampleRate(null, 0, 0);
    est = sampleRate(est, 9000, 1000);
    est = sampleRate(est, 10, 2000);
    expect(est).toEqual({ lastBytes: 10, lastAt: 2000, rate: null });
  });

  it("reseeds when the clock goes backwards", () => {
    const est = sampleRate(sampleRate(null, 0, 5000), 100, 1000);
    expect(est.rate).toBeNull();
  });

  it("ignores non-finite input", () => {
    expect(sampleRate(null, Number.NaN, 0)).toEqual({ lastBytes: 0, lastAt: 0, rate: null });
  });
});

describe("etaFromRate (PROD-038)", () => {
  it("divides the remaining bytes by the rate, rounding up", () => {
    expect(etaFromRate(1000, 300)).toBe(4);
  });

  it("is zero when nothing remains", () => {
    expect(etaFromRate(0, 100)).toBe(0);
  });

  it("is unknown for an unknown total or a zero/unknown rate", () => {
    expect(etaFromRate(null, 100)).toBeNull();
    expect(etaFromRate(1000, 0)).toBeNull();
    expect(etaFromRate(1000, null)).toBeNull();
  });
});
