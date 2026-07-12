import { describe, it, expect } from "vitest";
import type { PingResult } from "@/types/network";
import { deriveLivePingStats } from "./pingStats";

function reply(seq: number, latencyMs: number | undefined, timedOut = false): PingResult {
  return { seq, latencyMs, timedOut, tcpFallback: false };
}

describe("deriveLivePingStats", () => {
  it("returns null with no replies", () => {
    expect(deriveLivePingStats([])).toBeNull();
  });

  it("computes loss %, min/avg/max RTT from streamed replies", () => {
    const stats = deriveLivePingStats([reply(1, 10), reply(2, 20), reply(3, 30)]);
    expect(stats).not.toBeNull();
    expect(stats!.sent).toBe(3);
    expect(stats!.received).toBe(3);
    expect(stats!.lossPercent).toBe(0);
    expect(stats!.minMs).toBe(10);
    expect(stats!.maxMs).toBe(30);
    expect(stats!.avgMs).toBe(20);
  });

  it("counts timed-out replies as loss but not received", () => {
    const stats = deriveLivePingStats([
      reply(1, 10),
      reply(2, undefined, true),
      reply(3, 30),
      reply(4, undefined, true),
    ]);
    expect(stats!.sent).toBe(4);
    expect(stats!.received).toBe(2);
    expect(stats!.lossPercent).toBe(50);
    expect(stats!.minMs).toBe(10);
    expect(stats!.maxMs).toBe(30);
    expect(stats!.avgMs).toBe(20);
  });

  it("reports 100% loss without dividing by zero when all replies time out", () => {
    const stats = deriveLivePingStats([reply(1, undefined, true), reply(2, undefined, true)]);
    expect(stats!.sent).toBe(2);
    expect(stats!.received).toBe(0);
    expect(stats!.lossPercent).toBe(100);
    expect(stats!.avgMs).toBe(0);
    expect(Number.isNaN(stats!.avgMs)).toBe(false);
  });

  it("computes jitter as the mean absolute consecutive RTT difference", () => {
    // diffs: |20-10|=10, |15-20|=5 → mean 7.5
    const stats = deriveLivePingStats([reply(1, 10), reply(2, 20), reply(3, 15)]);
    expect(stats!.jitterMs).toBeCloseTo(7.5);
  });
});
