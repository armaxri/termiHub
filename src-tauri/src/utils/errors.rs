use termihub_core::errors::SessionError;
use thiserror::Error;

/// Errors that can occur in terminal operations.
#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Failed to spawn terminal: {0}")]
    SpawnFailed(String),

    /// Authentication was genuinely rejected (wrong password/passphrase or a
    /// refused key). Its `Display` (and therefore the serialized IPC string)
    /// carries the stable, locale-independent marker `[thub-code:auth_failed] `
    /// so the frontend can detect it structurally; the `{0}` payload remains the
    /// human message for display once the marker is stripped. The `auth_failed`
    /// code is mirrored on the frontend as `AUTH_FAILED_CODE` in
    /// `src/utils/backendErrorCode.ts` (I18N-001 / ERR-003).
    #[error("[thub-code:auth_failed] {0}")]
    AuthFailed(String),

    #[error("Failed to write to terminal: {0}")]
    WriteFailed(String),

    #[error("Failed to resize terminal: {0}")]
    ResizeFailed(String),

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("SSH error: {0}")]
    SshError(String),

    #[error("SFTP error: {0}")]
    SftpError(String),

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

impl TerminalError {
    /// Map a core [`SessionError`] to a [`TerminalError`] for a **direct
    /// terminal connect**, preserving the typed [`SessionError::AuthFailed`] as
    /// [`TerminalError::AuthFailed`] so the machine-stable auth signal survives
    /// to the IPC boundary. Every other variant keeps its previous stringified
    /// `SpawnFailed` representation, so non-auth error text is unchanged.
    pub fn from_session_spawn(err: SessionError) -> Self {
        match err {
            SessionError::AuthFailed => TerminalError::AuthFailed(err_display(&err)),
            other => TerminalError::SpawnFailed(other.to_string()),
        }
    }

    /// Like [`from_session_spawn`](Self::from_session_spawn) but for the SSH/agent
    /// connect helper, whose non-auth fallback is `SshError` (preserving the
    /// existing `"SSH error: …"` prefix for every non-auth failure).
    pub fn from_session_ssh(err: SessionError) -> Self {
        match err {
            SessionError::AuthFailed => TerminalError::AuthFailed(err_display(&err)),
            other => TerminalError::SshError(other.to_string()),
        }
    }
}

/// The human-readable message for a core error, kept for the auth-failure arm
/// so the `{0}` payload of [`TerminalError::AuthFailed`] stays a real message.
fn err_display(err: &SessionError) -> String {
    err.to_string()
}

/// Preserve the exact embedded-server message text when the relocated core
/// service (#2192) surfaces an error to the desktop, so the frontend sees the
/// same string as before the relocation.
impl From<termihub_core::embedded_servers::service::EmbeddedServerError> for TerminalError {
    fn from(err: termihub_core::embedded_servers::service::EmbeddedServerError) -> Self {
        TerminalError::EmbeddedServerError(err.0)
    }
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

    /// Locale-independent code carried on an auth-failure IPC error. Must match
    /// the frontend `AUTH_FAILED_CODE` in `src/utils/backendErrorCode.ts`.
    const AUTH_FAILED_CODE: &str = "auth_failed";
    /// Wire prefix emitted before an auth-failure message. Must match the
    /// `#[error(...)]` attribute on [`TerminalError::AuthFailed`] and the
    /// frontend parser's regex.
    const AUTH_FAILED_MARKER: &str = "[thub-code:auth_failed] ";

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

    /// A genuine auth rejection maps to the typed `AuthFailed` variant on both
    /// connect chokepoints, and the serialized IPC string carries the stable,
    /// locale-independent `auth_failed` code so the frontend never has to parse
    /// the human message text (I18N-001).
    #[test]
    fn auth_failure_maps_to_typed_variant_and_carries_the_code() {
        for terminal_err in [
            TerminalError::from_session_spawn(SessionError::AuthFailed),
            TerminalError::from_session_ssh(SessionError::AuthFailed),
        ] {
            assert!(matches!(terminal_err, TerminalError::AuthFailed(_)));

            // Display == serialized IPC string (serialize is serialize_str of Display).
            let rendered = terminal_err.to_string();
            assert!(
                rendered.starts_with(AUTH_FAILED_MARKER),
                "auth-failure IPC string must carry the machine code marker, got {rendered:?}"
            );
            assert!(rendered.contains(AUTH_FAILED_CODE));
            // The human message survives after the marker for display.
            assert_eq!(
                rendered,
                format!("{AUTH_FAILED_MARKER}Authentication failed")
            );

            let json = serde_json::to_string(&terminal_err).expect("serialize");
            assert!(
                json.contains(AUTH_FAILED_CODE),
                "serialized error must carry the code, got {json}"
            );
        }
    }

    /// A transport/protocol failure that merely occurred during the auth
    /// exchange is NOT an auth rejection: it must stay non-`AuthFailed` and must
    /// NOT carry the code, so the destructive credential discard never fires for
    /// it (the inverse mis-fire I18N-001 warns about).
    #[test]
    fn non_auth_session_error_does_not_carry_the_code() {
        let spawn = TerminalError::from_session_spawn(SessionError::SpawnFailed(
            "Password auth failed: connection reset".to_string(),
        ));
        assert!(matches!(spawn, TerminalError::SpawnFailed(_)));
        assert!(!spawn.to_string().contains(AUTH_FAILED_CODE));

        let ssh = TerminalError::from_session_ssh(SessionError::SpawnFailed(
            "Connection failed: timed out".to_string(),
        ));
        assert!(matches!(ssh, TerminalError::SshError(_)));
        assert!(!ssh.to_string().contains(AUTH_FAILED_CODE));
    }

    /// Guards the `#[error(...)]` attribute against drifting away from the
    /// `AUTH_FAILED_MARKER` constant the frontend parser is written against.
    #[test]
    fn auth_failed_display_carries_the_marker() {
        let rendered = TerminalError::AuthFailed("x".to_string()).to_string();
        assert_eq!(rendered, format!("{AUTH_FAILED_MARKER}x"));
    }
}
