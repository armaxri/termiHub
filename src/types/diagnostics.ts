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
