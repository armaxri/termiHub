/**
 * TypeScript types for built-in network diagnostic tools.
 *
 * The wire DTOs are generated via ts-rs (audit DUP-030, #3802) from their Rust
 * sources of truth: `core/src/network/types.rs` (tool results),
 * `core/src/monitoring/http_monitor.rs` (HTTP monitor) and
 * `src-tauri/src/network/tool_history.rs` (run history). Only frontend-only
 * types stay hand-written here.
 */

export type { PortState } from "./generated/PortState";
export type { PortScanResult } from "./generated/PortScanResult";
export type { PortScanSummary } from "./generated/PortScanSummary";
export type { PingResult } from "./generated/PingResult";
export type { PingStats } from "./generated/PingStats";
export type { PingSweepResult } from "./generated/PingSweepResult";
export type { PingSweepSummary } from "./generated/PingSweepSummary";
export type { DnsRecordType } from "./generated/DnsRecordType";
export type { DnsRecord } from "./generated/DnsRecord";
export type { DnsResult } from "./generated/DnsResult";
export type { TracerouteHop } from "./generated/TracerouteHop";
export type { PortProtocol } from "./generated/PortProtocol";
export type { OpenPort } from "./generated/OpenPort";
export type { WolDevice } from "./generated/WolDevice";
export type { HttpMonitorConfig } from "./generated/HttpMonitorConfig";
export type { HttpCheckResult } from "./generated/HttpCheckResult";
export type { HttpMonitorState } from "./generated/HttpMonitorState";
export type { NetworkHistoryTool } from "./generated/NetworkHistoryTool";
export type { NetworkRunStatus } from "./generated/NetworkRunStatus";
export type { NetworkRunResult } from "./generated/NetworkRunResult";
export type { NetworkToolRun } from "./generated/NetworkToolRun";

// ── Tool states (frontend-only) ───────────────────────────────────────────────

export type DiagnosticStatus = "idle" | "running" | "completed" | "canceled" | "error";

/** A plain CSV-cell value stored in a recorded result table. */
export type NetworkRunCell = string | number | boolean | null;
