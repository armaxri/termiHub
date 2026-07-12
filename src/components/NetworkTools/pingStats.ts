import type { PingResult, PingStats } from "@/types/network";

/**
 * Derive live ping statistics from the streamed replies received so far.
 *
 * The backend emits an authoritative {@link PingStats} in its closing
 * `network-ping-complete` event, but until then the panel would otherwise show
 * nothing. This computes the same shape from the replies streamed so far so the
 * loss %, RTT min/avg/max and jitter can update live while the ping is running.
 *
 * A timed-out reply counts towards `sent` but not `received`. `jitterMs` is the
 * mean absolute difference between consecutive successful round-trip times.
 *
 * @param results the replies streamed so far.
 * @returns live stats, or `null` when no replies have arrived yet.
 */
export function deriveLivePingStats(results: PingResult[]): PingStats | null {
  if (results.length === 0) return null;

  const sent = results.length;
  const latencies = results
    .filter((r) => !r.timedOut && r.latencyMs != null)
    .map((r) => r.latencyMs as number);
  const received = latencies.length;
  const lossPercent = ((sent - received) / sent) * 100;

  if (received === 0) {
    return { sent, received, lossPercent, minMs: 0, avgMs: 0, maxMs: 0, jitterMs: 0 };
  }

  const minMs = Math.min(...latencies);
  const maxMs = Math.max(...latencies);
  const avgMs = latencies.reduce((a, b) => a + b, 0) / received;

  let jitterMs = 0;
  if (latencies.length > 1) {
    let diffSum = 0;
    for (let i = 1; i < latencies.length; i++) {
      diffSum += Math.abs(latencies[i] - latencies[i - 1]);
    }
    jitterMs = diffSum / (latencies.length - 1);
  }

  return { sent, received, lossPercent, minMs, avgMs, maxMs, jitterMs };
}
