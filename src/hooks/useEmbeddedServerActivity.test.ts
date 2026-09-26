import { describe, it, expect } from "vitest";
import { EMPTY_ACTIVITY, mergeActivity } from "./useEmbeddedServerActivity";
import type { AccessLogEntry, ServerActivity } from "@/types/embeddedServer";

function entry(seq: number): AccessLogEntry {
  return {
    seq,
    timestamp: "2026-09-26T10:00:00.000Z",
    method: "GET",
    path: `/f${seq}`,
    status: "200",
    success: true,
    bytes: 1,
  };
}

function read(seqs: number[], opts: Partial<ServerActivity> = {}): ServerActivity {
  return {
    entries: seqs.map(entry),
    latestSeq: seqs.length ? seqs[seqs.length - 1] : 0,
    epoch: 0,
    dropped: 0,
    capacity: 1000,
    stats: {
      activeConnections: 0,
      totalConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      totalRequests: seqs.length,
      errors: 0,
      topPaths: [],
      topClients: [],
      currentTransfers: [],
    },
    ...opts,
  };
}

describe("mergeActivity", () => {
  it("appends incremental reads and advances the cursor", () => {
    const first = mergeActivity(EMPTY_ACTIVITY, read([1, 2]));
    expect(first.cursor).toBe(2);
    const second = mergeActivity(first, read([3]));
    expect(second.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(second.cursor).toBe(3);
  });

  it("keeps an empty delta as a no-op on the buffer", () => {
    const first = mergeActivity(EMPTY_ACTIVITY, read([1, 2]));
    const next = mergeActivity(first, { ...read([]), latestSeq: 2 });
    expect(next.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("caps the buffer at the log capacity, dropping the oldest", () => {
    const first = mergeActivity(EMPTY_ACTIVITY, read([1, 2, 3], { capacity: 3 }));
    const next = mergeActivity(first, read([4, 5], { capacity: 3 }));
    expect(next.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("replaces the buffer after a clear (epoch change)", () => {
    const first = mergeActivity(EMPTY_ACTIVITY, read([1, 2]));
    const next = mergeActivity(first, read([3], { epoch: 1 }));
    expect(next.entries.map((e) => e.seq)).toEqual([3]);
    expect(next.epoch).toBe(1);
  });

  it("replaces the buffer when the backend sequence goes backwards", () => {
    const first = mergeActivity(EMPTY_ACTIVITY, read([7, 8]));
    const next = mergeActivity(first, read([1]));
    expect(next.entries.map((e) => e.seq)).toEqual([1]);
    expect(next.cursor).toBe(1);
  });
});
