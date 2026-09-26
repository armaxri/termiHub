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
 * Why a monitoring collector loop left `live` (#3301).
 *
 * Mirrors the Rust `MonitorStatusReason` enum (camelCase):
 * - `transport` — the connection failed (collect timeout / exec error, or the
 *   reconnect budget ran out);
 * - `parse` — the remote answered, but its output could not be read;
 * - `silent` — an agent-hosted monitor's agent stopped sending data while the
 *   connection to it stayed up.
 */
export type MonitorStatusReason = "transport" | "parse" | "silent";

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
   * Why the loop left `live` — the failure kind behind a `stale` /
   * `reconnecting` / `offline` status, or `null` while healthy (#3301). Always
   * present on a projected entry; optional so hand-built fixtures may omit it.
   */
  statusReason?: MonitorStatusReason | null;
  /**
   * Number of stats samples received on this connection. The remote collectors
   * report CPU 0% on the first sample (no prior delta), so the UI treats sample
   * #1 as "priming" for the CPU field (audit gap G10).
   */
  sampleCount: number;
  /**
   * True while the user has paused collection (#1233). The transport stays open;
   * the backend loop simply stops collecting. A paused monitor shows a neutral
   * badge and dimmed stats.
   */
  paused: boolean;
  /**
   * Per-entry refresh interval in milliseconds (#1233). Drives the backend
   * session monitoring loop cadence, replacing the previously hardcoded interval.
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
  /**
   * Total swap space in kB. `0` when the host has no swap or the metric is
   * unavailable (older agents / non-Linux SSH remotes) — never absent.
   */
  swapTotalKb: number;
  /** Used swap space in kB. `0` when unavailable (see {@link swapTotalKb}). */
  swapUsedKb: number;
  /** Percentage of swap in use (0–100). `0` when unavailable. */
  swapUsedPercent: number;
  /**
   * Network receive throughput in bytes/sec over the last collection interval.
   * `0` on the first sample (no prior delta) or when unavailable.
   */
  netRxBytesPerSec: number;
  /** Network transmit throughput in bytes/sec (see {@link netRxBytesPerSec}). */
  netTxBytesPerSec: number;
  /**
   * Per-logical-core CPU usage percentage (0–100), one entry per core in core
   * order. Empty when unavailable — a non-Linux SSH remote (only `/proc/stat`
   * supplies per-core lines) or an older agent that never sends the field. `0`
   * for every core on the first sample (no prior delta).
   */
  perCoreCpuPercent: number[];
}

/**
 * A single process in the process table (PROD-0028). Mirrors the Rust
 * `ProcessInfo` struct (serde camelCase).
 */
export interface ProcessInfo {
  /** Numeric process id — the exact, only target a kill ever uses. */
  pid: number;
  /** Process/command name. */
  name: string;
  /** Owning user name; empty string when the source cannot resolve it. */
  user: string;
  /** CPU usage percentage; may exceed 100 on multi-core hosts. */
  cpuPercent: number;
  /** Resident memory as a percentage of total RAM. */
  memoryPercent: number;
  /**
   * Resident memory in kB when the source reports it (local `sysinfo`), or
   * `null` for `ps`-sourced remotes (SSH/Docker/WSL) which report only `pmem`.
   */
  memoryKb: number | null;
}

/**
 * Termination signal offered by the process table (PROD-0028). Deliberately
 * limited to the two safe, portable signals; a fuller menu is a follow-up.
 * Mirrors the Rust `KillSignal` enum (serde camelCase).
 */
export type KillSignal = "term" | "kill";
