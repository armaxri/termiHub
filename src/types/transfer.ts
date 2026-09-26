import type { TransferProgress, TransferQueueState, TransferSnapshot } from "@/services/api";
import { formatRate } from "@/utils/formatters";
import { blendRate, etaFromRate } from "@/utils/byteRate";

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
  /** Remote path, when the backend supplies one (SFTP and FTP events now do, #1531). */
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
  /**
   * Estimated time remaining in whole seconds (UX-019), or `null` when it cannot
   * be known — the row is not actively moving, the total size is unknown
   * (indeterminate), the throughput is zero/unknown, or no bytes remain.
   */
  etaSeconds: number | null;
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
 * The minimal description of a transfer known at **registration time** — before
 * any `transfer-progress` event has been delivered (#1632).
 *
 * A transfer command (`sftp_download` / `sftp_upload`) returns its `transferId`
 * synchronously over the reliable request/response IPC channel, whereas live
 * progress arrives as best-effort fan-out events that can be dropped or delayed
 * when the webview is starved (e.g. under memory pressure / jetsam). Seeding the
 * queue from this snapshot at registration makes the Transfer Queue panel open
 * as soon as a transfer is known, independent of whether any progress event is
 * ever observed — a later event simply upserts the row.
 */
export interface TransferSeed {
  /** The backend `transferId` returned by the start command. */
  id: string;
  /** Owning SFTP/FTP session id. */
  sessionId: string;
  /** Upload or download. */
  direction: TransferDirection;
  /** Display name (file name). */
  name: string;
  /** Remote path, when known. */
  path?: string;
  /** Total bytes when already known (uploads), else `null`/omitted. */
  totalBytes?: number | null;
}

/**
 * EMA weight applied to a fresh, delta-derived ETA sample when blending it with
 * the previous row's ETA. The delta-derived `speedBytesPerSec` is instantaneous
 * and jumpy, so a raw bytes-remaining / speed estimate flickers second-to-second;
 * a light exponential moving average (UX-019) keeps the readout steady while
 * still tracking real changes. Lower = smoother/laggier.
 */
export const ETA_SMOOTHING_ALPHA = 0.4;

/** Inputs to {@link computeEtaSeconds}. */
export interface EtaInput {
  /** Derived lifecycle state — ETA is only meaningful while `active`. */
  state: TransferQueueState;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes, or `null` when the size is unknown (indeterminate). */
  totalBytes: number | null;
  /** Current throughput in bytes/sec, or `null` when not moving/unknown. */
  speedBytesPerSec: number | null;
  /**
   * Backend-measured seconds-remaining (`etaSecs`, #1336), authoritative when
   * `> 0` — used verbatim (already smoothed backend-side) in preference to the
   * local byte/speed estimate.
   */
  backendEtaSeconds?: number | null;
  /** The previous row's ETA, for EMA smoothing of the local estimate. */
  prevEtaSeconds?: number | null;
}

/**
 * Estimate the time remaining for a transfer, in whole seconds (UX-019).
 *
 * Returns `null` whenever a meaningful estimate cannot be produced: the transfer
 * is not actively moving, the total size is unknown, the throughput is
 * zero/unknown, or no bytes remain. A backend-supplied ETA is preferred when
 * present; otherwise the estimate is `bytes-remaining / speed`, lightly
 * EMA-smoothed against {@link EtaInput.prevEtaSeconds} (see
 * {@link ETA_SMOOTHING_ALPHA}) so a jumpy instantaneous speed does not make the
 * readout flicker. The result is clamped to at least `1` second while a transfer
 * is still moving, so an active row never shows `0s remaining`.
 */
export function computeEtaSeconds(input: EtaInput): number | null {
  const { state, transferred, totalBytes, speedBytesPerSec, backendEtaSeconds, prevEtaSeconds } =
    input;
  if (state !== "active") return null;
  if (backendEtaSeconds != null && backendEtaSeconds > 0) {
    return Math.max(1, Math.round(backendEtaSeconds));
  }
  if (totalBytes == null || totalBytes <= 0) return null;
  if (speedBytesPerSec == null || speedBytesPerSec <= 0) return null;
  const remaining = totalBytes - transferred;
  if (remaining <= 0) return null;
  const raw = remaining / speedBytesPerSec;
  const smoothed =
    prevEtaSeconds != null && prevEtaSeconds > 0
      ? ETA_SMOOTHING_ALPHA * raw + (1 - ETA_SMOOTHING_ALPHA) * prevEtaSeconds
      : raw;
  return Math.max(1, Math.round(smoothed));
}

/**
 * Build a `queued` {@link TransferEntry} from a {@link TransferSeed}, for the
 * pre-event registration seed (#1632). Progress/throughput are unknown until the
 * first `transfer-progress` event folds over this row.
 */
export function transferEntryFromSeed(seed: TransferSeed, now: number): TransferEntry {
  const totalBytes = seed.totalBytes && seed.totalBytes > 0 ? seed.totalBytes : null;
  return {
    id: seed.id,
    sessionId: seed.sessionId,
    direction: seed.direction,
    name: seed.name,
    path: seed.path,
    state: "queued",
    transferred: 0,
    totalBytes,
    percent: null,
    speedBytesPerSec: null,
    etaSeconds: null,
    updatedAt: now,
  };
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
 * delta and preserves fields a given event may omit — the remote `path` is
 * taken from the event when present (#1531) and otherwise carried over from
 * `prev`. `now` is the current wall-clock ms (injected for deterministic tests).
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
      // Delta-derived fallback, blended into the previous rate with a
      // time-weighted EMA (PROD-038) so bursty events don't make it jump. A
      // non-`active` prev (paused / retried) restarts the estimate.
      const blended = blendRate(
        prev.speedBytesPerSec,
        progress.transferred - prev.transferred,
        now - prev.updatedAt
      );
      speedBytesPerSec = blended == null ? null : Math.round(blended);
    }
  }

  const etaSeconds = computeEtaSeconds({
    state,
    transferred: progress.transferred,
    totalBytes,
    speedBytesPerSec,
    backendEtaSeconds: progress.etaSecs,
    prevEtaSeconds: prev?.state === "active" ? prev.etaSeconds : null,
  });

  return {
    id: progress.transferId,
    sessionId: progress.sessionId,
    direction: progress.direction,
    name: progress.fileName,
    path: progress.path ?? prev?.path,
    state,
    transferred: progress.transferred,
    totalBytes,
    percent,
    speedBytesPerSec,
    etaSeconds,
    error: state === "failed" ? (progress.message ?? "Transfer failed") : undefined,
    attempt: progress.attempt ?? prev?.attempt,
    maxAttempts: progress.maxAttempts ?? prev?.maxAttempts,
    updatedAt: now,
  };
}

/**
 * Fold a backend {@link TransferSnapshot} (from `transfer_list`) into a
 * {@link TransferEntry}, for the reconcile backstop (#1645).
 *
 * Unlike a `transfer-progress` event, a snapshot carries the rich `state`
 * directly. This is used only to **settle a stuck non-terminal row** to its true
 * terminal state when the terminal event was dropped — it is never used to move
 * a live row's progress (events own that), so it cannot regress an
 * event-advanced row. `prev` is the existing row being settled; its `path` /
 * retry counters / error are preserved where the snapshot does not supply them.
 */
export function transferEntryFromSnapshot(
  snapshot: TransferSnapshot,
  prev: TransferEntry | undefined,
  now: number
): TransferEntry {
  const totalRaw = snapshot.total;
  const totalBytes = totalRaw && totalRaw > 0 ? totalRaw : (prev?.totalBytes ?? null);
  const state = snapshot.state;

  let percent: number | null;
  if (state === "completed") {
    percent = 100;
  } else if (totalBytes && totalBytes > 0) {
    percent = Math.min(100, Math.max(0, Math.round((snapshot.transferred / totalBytes) * 100)));
  } else {
    percent = null;
  }

  const speedBytesPerSec = snapshot.speed > 0 ? snapshot.speed : null;
  const etaSeconds = computeEtaSeconds({
    state,
    transferred: snapshot.transferred,
    totalBytes,
    speedBytesPerSec,
  });

  return {
    id: snapshot.transferId,
    sessionId: snapshot.sessionId,
    direction: snapshot.direction,
    name: snapshot.fileName,
    path: snapshot.path ?? prev?.path,
    state,
    transferred: snapshot.transferred,
    totalBytes,
    percent,
    speedBytesPerSec,
    etaSeconds,
    error: state === "failed" ? (prev?.error ?? "Transfer failed") : undefined,
    attempt: snapshot.attempt || prev?.attempt,
    maxAttempts: snapshot.maxAttempts || prev?.maxAttempts,
    updatedAt: now,
  };
}

/** Aggregate throughput + ETA across the whole queue (PROD-038 footer). */
export interface QueueThroughput {
  /** Number of rows currently moving (`active`). */
  activeCount: number;
  /** Summed throughput of the active rows in bytes/sec, or `null` when idle. */
  bytesPerSec: number | null;
  /**
   * Whole seconds until every pending (active + queued) row finishes at the
   * current aggregate rate, or `null` when it cannot be known: nothing is
   * moving (e.g. all paused), the rate is zero/unknown, or any pending row has
   * an unknown total size.
   */
  etaSeconds: number | null;
}

/**
 * Summarize the queue's overall throughput and ETA (PROD-038). Paused and
 * terminal rows are excluded from the rate; queued rows count toward the
 * remaining bytes (they will run after the active ones), so the ETA covers the
 * whole pending batch.
 */
export function summarizeQueueThroughput(entries: readonly TransferEntry[]): QueueThroughput {
  const active = entries.filter((e) => e.state === "active");
  const pending = entries.filter((e) => e.state === "active" || e.state === "queued");
  const rateSum = active.reduce((sum, e) => sum + (e.speedBytesPerSec ?? 0), 0);
  const bytesPerSec = rateSum > 0 ? rateSum : null;
  let etaSeconds: number | null = null;
  if (bytesPerSec != null && pending.every((e) => e.totalBytes != null)) {
    const remaining = pending.reduce(
      (sum, e) => sum + Math.max(0, (e.totalBytes ?? 0) - e.transferred),
      0
    );
    const eta = etaFromRate(remaining, bytesPerSec);
    etaSeconds = eta != null && eta > 0 ? eta : null;
  }
  return { activeCount: active.length, bytesPerSec, etaSeconds };
}

/**
 * Format a byte/sec throughput as a compact human-readable rate (e.g. `112 KB/s`).
 *
 * Thin wrapper over the shared, locale-aware {@link formatRate} so the transfer
 * queue and every other byte-rate readout share one implementation (LIBFE-002).
 */
export function formatThroughput(bytesPerSec: number | null): string {
  return formatRate(bytesPerSec);
}
