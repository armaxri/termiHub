// The monitoring DTOs are generated from their Rust source of truth via ts-rs
// (audit DUP-030, ts-rs rollout #3088): `SystemStats`, `MonitorStatus`,
// `MonitorStatusReason`, `ProcessInfo` and `KillSignal` from core
// `core/src/monitoring/`, and `MonitoringEntry` from the projection record in
// `src-tauri/src/system_monitor_projection/store.rs`.
export type { MonitorStatus } from "./generated/MonitorStatus";
export type { MonitorStatusReason } from "./generated/MonitorStatusReason";
export type { MonitoringEntry } from "./generated/MonitoringEntry";
export type { SystemStats } from "./generated/SystemStats";
export type { ProcessInfo } from "./generated/ProcessInfo";
export type { KillSignal } from "./generated/KillSignal";

/** Selectable monitoring refresh intervals, in milliseconds (#1233). */
export const MONITORING_INTERVAL_OPTIONS = [1000, 2000, 5000, 10000] as const;

/** Default monitoring refresh interval in milliseconds (#1233). */
export const DEFAULT_MONITORING_INTERVAL_MS = 2000;
