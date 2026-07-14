import { describe, it, expect } from "vitest";
import {
  transferEntryFromProgress,
  stateFromPhase,
  isTerminalTransferState,
  formatThroughput,
  type TransferEntry,
} from "./transfer";
import type { TransferProgress } from "@/services/api";

function progress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    transferred: 0,
    total: 100,
    phase: "transferring",
    ...overrides,
  };
}

describe("stateFromPhase", () => {
  it("maps legacy phases to queue states", () => {
    expect(stateFromPhase("transferring")).toBe("active");
    expect(stateFromPhase("done")).toBe("completed");
    expect(stateFromPhase("cancelled")).toBe("cancelled");
    expect(stateFromPhase("error")).toBe("failed");
  });
});

describe("isTerminalTransferState", () => {
  it("is true for completed/failed/cancelled and false for the rest", () => {
    expect(isTerminalTransferState("completed")).toBe(true);
    expect(isTerminalTransferState("failed")).toBe(true);
    expect(isTerminalTransferState("cancelled")).toBe(true);
    expect(isTerminalTransferState("active")).toBe(false);
    expect(isTerminalTransferState("queued")).toBe(false);
    expect(isTerminalTransferState("paused")).toBe(false);
  });
});

describe("transferEntryFromProgress", () => {
  it("derives an active entry from a legacy transferring event", () => {
    const entry = transferEntryFromProgress(progress({ transferred: 45 }), undefined, 1000);
    expect(entry).toMatchObject({
      id: "t1",
      sessionId: "sess-a",
      direction: "download",
      name: "file.txt",
      state: "active",
      transferred: 45,
      totalBytes: 100,
      percent: 45,
      updatedAt: 1000,
    });
  });

  it("prefers the #1336 rich `state` field over the legacy phase", () => {
    const entry = transferEntryFromProgress(
      progress({ phase: "transferring", state: "paused", transferred: 31 }),
      undefined,
      0
    );
    expect(entry.state).toBe("paused");
  });

  it("forces 100% and clears speed for a completed transfer", () => {
    const prev: TransferEntry = transferEntryFromProgress(
      progress({ transferred: 90 }),
      undefined,
      0
    );
    const entry = transferEntryFromProgress(
      progress({ phase: "done", transferred: 100 }),
      prev,
      2000
    );
    expect(entry.state).toBe("completed");
    expect(entry.percent).toBe(100);
    expect(entry.speedBytesPerSec).toBeNull();
  });

  it("marks indeterminate size as null total and null percent", () => {
    const entry = transferEntryFromProgress(progress({ total: 0, transferred: 10 }), undefined, 0);
    expect(entry.totalBytes).toBeNull();
    expect(entry.percent).toBeNull();
  });

  it("carries the error message on a failed transfer", () => {
    const entry = transferEntryFromProgress(
      progress({ phase: "error", message: "connection reset" }),
      undefined,
      0
    );
    expect(entry.state).toBe("failed");
    expect(entry.error).toBe("connection reset");
  });

  it("uses the backend-measured speed when present", () => {
    const entry = transferEntryFromProgress(
      progress({ state: "active", speed: 4096, transferred: 50 }),
      undefined,
      0
    );
    expect(entry.speedBytesPerSec).toBe(4096);
  });

  it("computes throughput from the byte/time delta when no backend speed is given", () => {
    const prev = transferEntryFromProgress(progress({ transferred: 0 }), undefined, 1000);
    // 1024 more bytes over 1000ms → 1024 B/s
    const entry = transferEntryFromProgress(progress({ transferred: 1024 }), prev, 2000);
    expect(entry.speedBytesPerSec).toBe(1024);
  });

  it("preserves retry counters and path across updates", () => {
    const prev: TransferEntry = {
      ...transferEntryFromProgress(progress(), undefined, 0),
      path: "/uploads/file.txt",
    };
    const entry = transferEntryFromProgress(
      progress({ phase: "error", attempt: 2, maxAttempts: 3 }),
      prev,
      0
    );
    expect(entry.path).toBe("/uploads/file.txt");
    expect(entry.attempt).toBe(2);
    expect(entry.maxAttempts).toBe(3);
  });
});

describe("formatThroughput", () => {
  it("formats bytes/sec into compact units", () => {
    expect(formatThroughput(512)).toBe("512 B/s");
    expect(formatThroughput(1024)).toBe("1 KB/s");
    expect(formatThroughput(23 * 1024)).toBe("23 KB/s");
    expect(formatThroughput(2 * 1024 * 1024)).toBe("2 MB/s");
  });

  it("returns empty string for null or non-positive rates", () => {
    expect(formatThroughput(null)).toBe("");
    expect(formatThroughput(0)).toBe("");
  });
});
