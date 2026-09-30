/**
 * Local crash-report and diagnostics-export types (OBS-010), generated from
 * their Rust source of truth via ts-rs (audit DUP-030, #3088):
 * `src-tauri/src/commands/diagnostics.rs`,
 * `src-tauri/src/utils/diagnostics_bundle.rs`,
 * `src-tauri/src/utils/agent_crash_reports.rs` and the agent protocol's
 * `CrashReportSummary` (`core/src/protocol/methods.rs`).
 */

/** The newest crash report the user has not yet been told about. */
export type { CrashReportNotice } from "./generated/CrashReportNotice";

/** One file a diagnostics export would include (Rust `BundleEntryInfo`). */
export type { DiagnosticsBundleEntry } from "./generated/DiagnosticsBundleEntry";

/** Result of writing a diagnostics bundle. */
export type { DiagnosticsExportResult } from "./generated/DiagnosticsExportResult";

/** A connected agent's crash reports, for the export preview (#3574). */
export type { AgentCrashReports } from "./generated/AgentCrashReports";

/** A remote agent crash report the user chose to include in the export. */
export type { AgentCrashReportRef } from "./generated/AgentCrashReportRef";

/**
 * A remote agent that crashed since it was last connected (#3593): its newest
 * new crash report. Generated from `AgentCrashNotice` in
 * `src-tauri/src/utils/agent_crash_notice.rs` via ts-rs (#3088).
 */
export type { AgentCrashNotice } from "./generated/AgentCrashNotice";
