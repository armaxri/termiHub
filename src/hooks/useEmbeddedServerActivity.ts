import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearEmbeddedServerActivity,
  getEmbeddedServerActivity,
} from "@/services/embeddedServerApi";
import type { AccessLogEntry, DetailedServerStats, ServerActivity } from "@/types/embeddedServer";
import { errorMessage } from "@/utils/errorMessage";

/** How often the access log is polled while the server is running. */
export const ACTIVITY_POLL_INTERVAL_MS = 1500;

/** Client-side view of a server's access log, accumulated across polls. */
export interface ActivityView {
  /** Buffered entries, oldest first, bounded by the server's log capacity. */
  entries: AccessLogEntry[];
  /** Cursor for the next incremental read. */
  cursor: number;
  /** Epoch of the buffered entries (a change means the log was cleared). */
  epoch: number;
  dropped: number;
  stats: DetailedServerStats | null;
}

/** The empty view before the first read. */
export const EMPTY_ACTIVITY: ActivityView = {
  entries: [],
  cursor: 0,
  epoch: 0,
  dropped: 0,
  stats: null,
};

/**
 * Fold an incremental backend read into the buffered view.
 *
 * New entries are appended and the buffer is capped at the log's capacity
 * (dropping the oldest). When the log was cleared (epoch changed) or the
 * backend's sequence went backwards (a re-created server), the buffer is
 * replaced instead of appended to.
 */
export function mergeActivity(prev: ActivityView, next: ServerActivity): ActivityView {
  const reset = next.epoch !== prev.epoch || next.latestSeq < prev.cursor;
  const base = reset ? [] : prev.entries;
  const merged = [...base, ...next.entries];
  const capped = merged.length > next.capacity ? merged.slice(-next.capacity) : merged;
  return {
    entries: capped,
    cursor: next.latestSeq,
    epoch: next.epoch,
    dropped: next.dropped,
    stats: next.stats,
  };
}

/** Result of {@link useEmbeddedServerActivity}. */
export interface EmbeddedServerActivityState {
  view: ActivityView;
  /**
   * False when the backend has no log for the server (never started, or hosted
   * on an agent that predates the access-log RPC).
   */
  available: boolean;
  /** Last read error, if any. */
  error: string | null;
  /** Clear the server's log (and the local buffer). */
  clear: () => Promise<void>;
}

/**
 * Keep an incrementally-polled copy of one server's access log and detailed
 * stats (PROD-034/036). Reads once on mount and then every
 * {@link ACTIVITY_POLL_INTERVAL_MS} while `live` (the server is running).
 */
export function useEmbeddedServerActivity(
  serverId: string,
  live: boolean
): EmbeddedServerActivityState {
  const [view, setView] = useState<ActivityView>(EMPTY_ACTIVITY);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<ActivityView>(EMPTY_ACTIVITY);

  const refresh = useCallback(async () => {
    try {
      const next = await getEmbeddedServerActivity(serverId, viewRef.current.cursor);
      if (next === null) {
        setAvailable(false);
        return;
      }
      const merged = mergeActivity(viewRef.current, next);
      viewRef.current = merged;
      setAvailable(true);
      setError(null);
      setView(merged);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
    if (!live) return;
    const interval = window.setInterval(() => void refresh(), ACTIVITY_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [live, refresh]);

  const clear = useCallback(async () => {
    await clearEmbeddedServerActivity(serverId);
    viewRef.current = { ...viewRef.current, entries: [], dropped: 0 };
    setView(viewRef.current);
    await refresh();
  }, [serverId, refresh]);

  return { view, available, error, clear };
}
