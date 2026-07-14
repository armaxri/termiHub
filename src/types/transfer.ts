import type { TransferProgress, TransferQueueState } from "@/services/api";

/**
 * The connection-type-agnostic state space of a queued file transfer, as shown
 * in the Transfer Queue panel (concept `ftp-client.html`, Epic #1331, #1337).
 *
 * Re-exported from the API layer (#1336) so the queue UI has a single source of
 * truth for the six states: `queued`, `active`, `paused`, `completed`,
 * `failed`, `cancelled`.
 */
export type { TransferQueueState };

/** Direction of a transfer, driving the up/down icon and verb in the UI. */
export type TransferDirection = "download" | "upload";

/** The terminal states — a transfer in one of these will not move on its own. */
export const TERMINAL_TRANSFER_STATES: readonly TransferQueueState[] = [
  "completed",
  "failed",
  "cancelled",
];

/** Whether a transfer state is terminal (finished, one way or another). */
export function isTerminalTransferState(state: TransferQueueState): boolean {
  return TERMINAL_TRANSFER_STATES.includes(state);
}

/**
 * A single row in the Transfer Queue panel (#1337).
 *
 * Richer than the transient {@link TransferProgress} event payload: it carries a
 * derived {@link TransferQueueState}, a computed throughput, a nullable total
 * (unknown size), and — for failed rows — the error message and retry attempt
 * counters. Persisted in the store's `transferQueue` slice keyed by {@link id};
 * unlike the transient `transfers` map (#1247), terminal rows are retained until
 * the user clears or removes them.
 */
export interface TransferEntry {
  /** Stable per-transfer id (the backend `transferId`). */
  id: string;
  /** Owning session id (SFTP/FTP session), used for grouping and cancel-all. */
  sessionId: string;
  /** Upload or download. */
  direction: TransferDirection;
  /** Display name (file name). */
  name: string;
  /** Remote path, when the backend supplies one (SFTP events currently do not). */
  path?: string;
  /** Derived lifecycle state. */
  state: TransferQueueState;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes, or `null` when the size is unknown (indeterminate). */
  totalBytes: number | null;
  /** Completion percentage (0–100), or `null` when indeterminate. */
  percent: number | null;
  /** Instantaneous throughput in bytes/sec, or `null` when not moving/unknown. */
  speedBytesPerSec: number | null;
  /** Human-readable error, only populated for the `failed` state. */
  error?: string;
  /** Current retry attempt (SI-5 / #1336), when reported. */
  attempt?: number;
  /** Maximum retry attempts (SI-5 / #1336), when reported. */
  maxAttempts?: number;
  /** Wall-clock ms of the last update, used to compute throughput deltas. */
  updatedAt: number;
}

/**
 * Map a backend {@link TransferProgress} legacy `phase` to a queue
 * {@link TransferQueueState}, for events that predate the #1336 `state` field.
 */
export function stateFromPhase(phase: TransferProgress["phase"]): TransferQueueState {
  switch (phase) {
    case "transferring":
      return "active";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

/**
 * Fold a `transfer-progress` event into a {@link TransferEntry}, deriving state,
 * percent, and throughput.
 *
 * The #1336 rich fields (`state`, `speed`, `totalBytes`, `attempt`,
 * `maxAttempts`) are preferred when present; otherwise the legacy #1245 fields
 * (`phase`, `total`) drive the mapping and throughput is computed from the
 * byte/time delta against `prev` while the transfer is `active`.
 *
 * `prev` is the existing entry for this id (if any); it seeds the throughput
 * delta and preserves fields the event does not carry (`path`). `now` is the
 * current wall-clock ms (injected for deterministic tests).
 */
export function transferEntryFromProgress(
  progress: TransferProgress,
  prev: TransferEntry | undefined,
  now: number
): TransferEntry {
  const state = progress.state ?? stateFromPhase(progress.phase);
  const totalRaw = progress.totalBytes ?? progress.total;
  const totalBytes = totalRaw && totalRaw > 0 ? totalRaw : null;

  let percent: number | null;
  if (state === "completed") {
    percent = 100;
  } else if (totalBytes && totalBytes > 0) {
    percent = Math.min(100, Math.max(0, Math.round((progress.transferred / totalBytes) * 100)));
  } else {
    percent = null;
  }

  let speedBytesPerSec: number | null = null;
  if (state === "active") {
    if (progress.speed != null && progress.speed > 0) {
      // Backend-measured throughput (#1336) is authoritative when supplied.
      speedBytesPerSec = progress.speed;
    } else if (prev && prev.state === "active") {
      const deltaBytes = progress.transferred - prev.transferred;
      const deltaMs = now - prev.updatedAt;
      speedBytesPerSec =
        deltaBytes >= 0 && deltaMs > 0
          ? Math.round((deltaBytes / deltaMs) * 1000)
          : prev.speedBytesPerSec;
    }
  }

  return {
    id: progress.transferId,
    sessionId: progress.sessionId,
    direction: progress.direction,
    name: progress.fileName,
    path: prev?.path,
    state,
    transferred: progress.transferred,
    totalBytes,
    percent,
    speedBytesPerSec,
    error: state === "failed" ? (progress.message ?? "Transfer failed") : undefined,
    attempt: progress.attempt ?? prev?.attempt,
    maxAttempts: progress.maxAttempts ?? prev?.maxAttempts,
    updatedAt: now,
  };
}

/** Format a byte/sec throughput as a compact human-readable rate (e.g. `112 KB/s`). */
export function formatThroughput(bytesPerSec: number | null): string {
  if (bytesPerSec == null || bytesPerSec <= 0) return "";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
