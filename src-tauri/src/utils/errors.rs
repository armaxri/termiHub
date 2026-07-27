use thiserror::Error;

/// Errors that can occur in terminal operations.
#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Failed to spawn terminal: {0}")]
    SpawnFailed(String),

    #[error("Failed to write to terminal: {0}")]
    WriteFailed(String),

    #[error("Failed to resize terminal: {0}")]
    ResizeFailed(String),

    #[allow(dead_code)]
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[allow(dead_code)]
    #[error("Serial port error: {0}")]
    SerialError(String),

    #[error("SSH error: {0}")]
    SshError(String),

    #[error("SFTP error: {0}")]
    SftpError(String),

    #[allow(dead_code)]
    #[error("Telnet error: {0}")]
    TelnetError(String),

    #[allow(dead_code)]
    #[error("Docker error: {0}")]
    DockerError(String),

    #[error("Editor error: {0}")]
    EditorError(String),

    #[error("Remote agent error: {0}")]
    RemoteError(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("SFTP session not found: {0}")]
    SftpSessionNotFound(String),

    #[error("Tunnel error: {0}")]
    TunnelError(String),

    #[error("Workspace error: {0}")]
    WorkspaceError(String),

    #[error("Macro error: {0}")]
    MacroError(String),

    #[error("Session history error: {0}")]
    SessionHistoryError(String),

    #[error("Workflow error: {0}")]
    WorkflowError(String),

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Internal error: {0}")]
    InternalError(String),

    #[error("Embedded server error: {0}")]
    EmbeddedServerError(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for TerminalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SFTP file-operation failures must surface with an `SFTP error:` prefix,
    /// not the misleading `SSH error:` prefix (issue #2094).
    #[test]
    fn sftp_error_renders_with_sftp_prefix() {
        let err = TerminalError::SftpError("readdir failed: no such file".to_string());
        let rendered = err.to_string();
        assert_eq!(rendered, "SFTP error: readdir failed: no such file");
        assert!(
            !rendered.starts_with("SSH error:"),
            "SFTP operation errors must not be labeled as SSH errors, got {rendered:?}"
        );
    }

    /// The distinct `SshError` variant keeps its own prefix for genuine
    /// SSH-session/transport failures.
    #[test]
    fn ssh_error_renders_with_ssh_prefix() {
        let err = TerminalError::SshError("exec channel failed".to_string());
        assert_eq!(err.to_string(), "SSH error: exec channel failed");
    }
}
