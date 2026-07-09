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
 * Since the legacy pull path was retired (#1232), every monitor — desktop-direct
 * SSH and remote-session alike — routes through the unified session-based
 * `MonitoringProvider` push path, so `MonitorKey` is always the id of the
 * terminal session that owns the monitor.
 */
export interface MonitoringEntry {
  /** Stable key identifying this monitor (the owning terminal session id). */
  key: string;
  /** Human-readable host label shown in the UI. */
  host: string | null;
  /**
   * Backend session id used for the close RPC. Equals {@link key} once the
   * provider subscription is live; `null` until the backend connection is
   * established (or after a failed open), which the UI reads as "not yet
   * connected".
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
}

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
