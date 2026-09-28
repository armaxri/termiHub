use serde::Serialize;

/// A warning generated during file recovery.
///
/// The TypeScript DTO is generated from this struct via ts-rs (audit DUP-030).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RecoveryWarning {
    /// The file that was recovered (e.g. "connections.json").
    pub file_name: String,
    /// Human-readable summary of what happened.
    pub message: String,
    /// Optional technical details (e.g. the serde parse error).
    pub details: Option<String>,
}

/// Result of loading a file with recovery.
pub struct RecoveryResult<T> {
    pub data: T,
    pub warnings: Vec<RecoveryWarning>,
}
