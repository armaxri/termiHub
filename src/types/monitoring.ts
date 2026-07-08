/**
 * Observable lifecycle state of a monitoring collector loop.
 *
 * Mirrors the Rust `MonitorStatus` enum (camelCase). A mid-stream transport
 * drop moves the loop to `stale` so the UI stops rendering frozen stats as
 * live (#1229, audit gap G1). `reconnecting`, `offline`, and `paused` are
 * reserved for later stages of the lifecycle redesign.
 */
export type MonitorStatus = "connecting" | "live" | "stale" | "reconnecting" | "offline" | "paused";

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
