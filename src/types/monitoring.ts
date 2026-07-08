/**
 * Observable lifecycle state of a monitoring collector loop.
 *
 * Mirrors the Rust `MonitorStatus` enum (camelCase). A mid-stream transport
 * drop moves the loop to `stale` so the UI stops rendering frozen stats as
 * live (#1229, audit gap G1). `reconnecting`, `offline`, and `paused` are
 * reserved for later stages of the lifecycle redesign.
 */
export type MonitorStatus = "connecting" | "live" | "stale" | "reconnecting" | "offline" | "paused";

/**
 * One monitored host/session, keyed by a stable {@link MonitorKey} in the store
 * (`monitors: Record<MonitorKey, MonitoringEntry>`). Replaces the former global
 * singleton so multiple hosts can be monitored simultaneously (#1231, audit gap
 * G6). The status bar renders the entry for the active tab; Open Connections
 * iterates every entry.
 *
 * `MonitorKey` is the session id for session-based (`remote-session`) tabs and
 * the `user@host:port` host key for desktop-direct SSH monitoring — matching the
 * keying that `monitoringStatsCache` already used.
 */
export interface MonitoringEntry {
  /** Stable key identifying this monitor (sessionId or `user@host:port`). */
  key: string;
  /** Human-readable host label shown in the UI. */
  host: string | null;
  /** True for push-based session monitoring; false for desktop-direct SSH polling. */
  sessionBased: boolean;
  /**
   * Backend session id used for close/refresh RPCs. Equals `key` for
   * session-based monitors; for SSH it is the id returned by `monitoringOpen`.
   * `null` until the backend connection is established (or after a failed open),
   * which the UI reads as "not yet connected".
   */
  monitorSessionId: string | null;
  /** Last-known stats for this host, or `null` before the first sample. */
  stats: SystemStats | null;
  /** True while the initial connect (or a cache-primed reconnect) is in flight. */
  loading: boolean;
  /** Last error message for this host, or `null`. */
  error: string | null;
  /** Observable collector-loop status (`live`/`stale`/…), or `null` when idle. */
  status: MonitorStatus | null;
  /**
   * Number of stats samples received on this connection. The remote collectors
   * report CPU 0% on the first sample (no prior delta), so the UI treats sample
   * #1 as "priming" for the CPU field (audit gap G10).
   */
  sampleCount: number;
  /**
   * True when auto-connect was aborted because the user cancelled the password
   * prompt. The status bar renders a "Monitoring not connected" affordance with a
   * reachable Retry instead of failing silently (audit gap G8).
   */
  cancelled: boolean;
  /**
   * True while the user has paused collection (#1233). The transport stays open;
   * the loop simply stops collecting. A paused monitor shows a neutral badge and,
   * for SSH polling, suspends the frontend refresh timer.
   */
  paused: boolean;
  /**
   * Per-entry refresh interval in milliseconds (#1233). Drives the frontend poll
   * cadence for SSH monitors and the backend loop cadence for session monitors,
   * replacing the previously hardcoded intervals.
   */
  intervalMs: number;
}

/** Selectable monitoring refresh intervals, in milliseconds (#1233). */
export const MONITORING_INTERVAL_OPTIONS = [1000, 2000, 5000, 10000] as const;

/** Default monitoring refresh interval in milliseconds (#1233). */
export const DEFAULT_MONITORING_INTERVAL_MS = 2000;

/** System statistics retrieved from a remote Linux host. */
export interface SystemStats {
  hostname: string;
  uptimeSeconds: number;
  loadAverage: [number, number, number];
  cpuUsagePercent: number;
  memoryTotalKb: number;
  memoryAvailableKb: number;
  memoryUsedPercent: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskUsedPercent: number;
  osInfo: string;
}
