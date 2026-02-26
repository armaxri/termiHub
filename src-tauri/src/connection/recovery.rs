use serde::Serialize;

/// A warning generated during file recovery.
#[derive(Debug, Clone, Serialize)]
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
