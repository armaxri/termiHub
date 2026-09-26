/**
 * Local crash-report and diagnostics-export types (OBS-010). Mirrors the Rust
 * structs in `src-tauri/src/commands/diagnostics.rs` and
 * `src-tauri/src/utils/diagnostics_bundle.rs`.
 */

/** The newest crash report the user has not yet been told about. */
export interface CrashReportNotice {
  /** Report file name, passed back to `readCrashReport`. */
  name: string;
  /** Absolute path of the report on disk. */
  path: string;
  /** Number of crash reports currently kept. */
  total: number;
}

/** One file a diagnostics export would include. */
export interface DiagnosticsBundleEntry {
  /** Path inside the zip, e.g. `logs/termihub.log`. */
  name: string;
  /** Size of the source before redaction, in bytes. */
  size: number;
  /** Short human description. */
  description: string;
}

/** Result of writing a diagnostics bundle. */
export interface DiagnosticsExportResult {
  /** Where the bundle was written. */
  path: string;
  /** Number of files in the bundle. */
  fileCount: number;
}

/** One crash report on a remote agent (`CrashReportSummary`, #3574). */
export interface AgentCrashReportSummary {
  /** Report file name on the agent. */
  name: string;
  /** Size on the agent, in bytes. */
  size: number;
}

/** A connected agent's crash reports, for the export preview (#3574). */
export interface AgentCrashReports {
  /** The agent's id. */
  agentId: string;
  /** `false` when the agent is too old to share crash reports. */
  supported: boolean;
  /** The agent's crash reports, newest first. */
  reports: AgentCrashReportSummary[];
  /** Why listing failed, when it did. */
  error?: string;
}

/** A remote agent crash report the user chose to include in the export. */
export interface AgentCrashReportRef {
  agentId: string;
  name: string;
}

/**
 * A remote agent that crashed since it was last connected (#3593): its newest
 * new crash report. Mirrors `AgentCrashNotice` in
 * `src-tauri/src/utils/agent_crash_notice.rs`.
 */
export interface AgentCrashNotice {
  /** The agent's id. */
  agentId: string;
  /** Newest new report on the agent, passed to `readAgentCrashReport`. */
  name: string;
  /** How many reports are new since the last acknowledgement. */
  newCount: number;
}
