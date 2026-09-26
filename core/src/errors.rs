//! Unified error types for the termiHub core crate.
//!
//! These types replace the duplicated error enums across the desktop and agent
//! crates. Each consumer maps these core errors to their own transport errors
//! (desktop → Tauri serialized error, agent → JSON-RPC error response).

use thiserror::Error;

/// Top-level error type encompassing all core error categories.
#[derive(Error, Debug)]
pub enum CoreError {
    /// A session-related error.
    #[error("Session error: {0}")]
    Session(#[from] SessionError),

    /// A file-operation error.
    #[error("File error: {0}")]
    File(#[from] FileError),

    /// A configuration error (invalid values, missing fields, parse failures).
    #[error("Config error: {0}")]
    Config(String),

    /// A low-level I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The remote answered, but its output could not be parsed — e.g. a
    /// monitoring collect whose output is not the expected `/proc` layout.
    ///
    /// A typed discriminant so a collect loop can tell "reachable but
    /// unusable" (terminal before the first sample, #3252) apart from a
    /// transport failure (timeout, exec error) without matching on message
    /// text (#3300). Displays the bare message, like [`CoreError::Other`].
    #[error("{0}")]
    Unparseable(String),

    /// Catch-all for errors that don't fit other categories.
    #[error("{0}")]
    Other(String),
}

/// Errors related to terminal session lifecycle and operations.
#[derive(Error, Debug)]
pub enum SessionError {
    /// The requested session does not exist.
    #[error("Session not found: {0}")]
    NotFound(String),

    /// A session with the given identifier already exists.
    #[error("Session already exists: {0}")]
    AlreadyExists(String),

    /// The session backend failed to start.
    #[error("Spawn failed: {0}")]
    SpawnFailed(String),

    /// A transport-level failure while establishing the connection (TCP connect,
    /// DNS, or SSH handshake transport) — the host could not be reached.
    ///
    /// This is a **typed, locale-independent** discriminant, distinct from a
    /// credential rejection ([`AuthFailed`](Self::AuthFailed)): it is returned
    /// when the remote could not be contacted at all. Consumers classify an
    /// "unreachable host" by matching this variant rather than by parsing the
    /// English "Connection failed" text, which is one localization or rewording
    /// away from silently misclassifying (I18N-002 / ERR-003).
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Authentication was genuinely rejected by the remote (wrong password,
    /// wrong passphrase, or a refused public key).
    ///
    /// This is a **typed, locale-independent** discriminant: it is returned only
    /// when the credentials were rejected, never for a transport/protocol error
    /// that merely occurred during the authentication exchange. Consumers must
    /// classify auth failures by matching this variant — never by parsing the
    /// human-readable message text, which is English today and one localization
    /// or rewording away from silently misclassifying (I18N-001).
    #[error("Authentication failed")]
    AuthFailed,

    /// The user dismissed an interactive authentication prompt (SSH
    /// keyboard-interactive / OTP, #3371).
    ///
    /// Distinct from [`AuthFailed`](Self::AuthFailed): nothing was rejected, so
    /// consumers must **not** treat it as a credential failure (no stored
    /// credential discard, no "authentication failed" error state).
    #[error("Authentication cancelled")]
    AuthCancelled,

    /// A **later** authentication factor the user typed (an SSH
    /// keyboard-interactive answer such as a one-time code) was rejected after
    /// an earlier factor — the saved password or key — had already been
    /// accepted (#3376).
    ///
    /// Distinct from [`AuthFailed`](Self::AuthFailed): the stored credential is
    /// not known to be wrong, so consumers must **not** discard it. The user
    /// simply retries with a fresh code.
    #[error("Verification code rejected")]
    SecondFactorFailed,

    /// The session configuration is invalid.
    #[error("Invalid config: {0}")]
    InvalidConfig(String),

    /// The maximum number of concurrent sessions has been reached.
    #[error("Session limit reached")]
    LimitReached,

    /// The session exists but is no longer running.
    #[error("Session not running: {0}")]
    NotRunning(String),

    /// A low-level I/O error during session operations.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Errors related to file browsing and file operations.
#[derive(Error, Debug)]
pub enum FileError {
    /// The requested file or directory was not found.
    #[error("File not found: {0}")]
    NotFound(String),

    /// Permission was denied for the requested operation.
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// A file operation failed (I/O error, command failure, etc.).
    #[error("Operation failed: {0}")]
    OperationFailed(String),

    /// A read was rejected because the file exceeds the maximum in-memory size
    /// allowed for a single read (CORE-013). Defense-in-depth against OOM: the
    /// read path buffers the whole file, so a pathological/hostile multi-GB file
    /// is rejected cleanly here instead of exhausting host memory.
    #[error("file too large: {size} bytes exceeds the {limit} byte limit")]
    TooLarge { size: u64, limit: u64 },

    /// File browsing is not supported for this connection type.
    #[error("File browsing not supported for this connection type")]
    NotSupported,

    /// A low-level I/O error during file operations.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_error_display() {
        let err = SessionError::NotFound("abc-123".into());
        assert_eq!(err.to_string(), "Session not found: abc-123");

        let err = SessionError::LimitReached;
        assert_eq!(err.to_string(), "Session limit reached");

        let err = SessionError::NotRunning("xyz".into());
        assert_eq!(err.to_string(), "Session not running: xyz");
    }

    /// The typed auth-failure variant renders a stable human message and is a
    /// distinct discriminant that callers can match on without parsing text
    /// (I18N-001).
    #[test]
    fn auth_failed_is_a_distinct_typed_variant() {
        let err = SessionError::AuthFailed;
        assert_eq!(err.to_string(), "Authentication failed");
        assert!(matches!(err, SessionError::AuthFailed));
        // It must NOT collapse into SpawnFailed — a transport failure during the
        // auth exchange stays SpawnFailed, only a genuine rejection is AuthFailed.
        assert!(!matches!(
            SessionError::SpawnFailed("Password auth failed: timeout".into()),
            SessionError::AuthFailed
        ));
    }

    /// A dismissed interactive prompt is its own discriminant, never an auth
    /// failure (#3371).
    #[test]
    fn auth_cancelled_is_distinct_from_auth_failed() {
        let err = SessionError::AuthCancelled;
        assert_eq!(err.to_string(), "Authentication cancelled");
        assert!(!matches!(err, SessionError::AuthFailed));
    }

    /// A rejected second factor is its own discriminant, never an auth failure
    /// — that is what keeps the saved password from being discarded (#3376).
    #[test]
    fn second_factor_failed_is_distinct_from_auth_failed() {
        let err = SessionError::SecondFactorFailed;
        assert_eq!(err.to_string(), "Verification code rejected");
        assert!(!matches!(err, SessionError::AuthFailed));
    }

    /// The typed connection-failure variant renders a stable human message and
    /// is a distinct discriminant callers can match on without parsing text — it
    /// must never collapse into `SpawnFailed` (I18N-002 / ERR-003).
    #[test]
    fn connection_failed_is_a_distinct_typed_variant() {
        let err = SessionError::ConnectionFailed("timed out".into());
        assert_eq!(err.to_string(), "Connection failed: timed out");
        assert!(matches!(err, SessionError::ConnectionFailed(_)));
        assert!(!matches!(
            SessionError::SpawnFailed("Connection failed: timed out".into()),
            SessionError::ConnectionFailed(_)
        ));
    }

    #[test]
    fn file_error_display() {
        let err = FileError::NotFound("/tmp/missing".into());
        assert_eq!(err.to_string(), "File not found: /tmp/missing");

        let err = FileError::PermissionDenied("/root".into());
        assert_eq!(err.to_string(), "Permission denied: /root");

        let err = FileError::NotSupported;
        assert_eq!(
            err.to_string(),
            "File browsing not supported for this connection type"
        );

        let err = FileError::TooLarge {
            size: 3_000_000_000,
            limit: 268_435_456,
        };
        assert_eq!(
            err.to_string(),
            "file too large: 3000000000 bytes exceeds the 268435456 byte limit"
        );
    }

    #[test]
    fn core_error_from_session_error() {
        let session_err = SessionError::NotFound("s1".into());
        let core_err: CoreError = session_err.into();
        assert_eq!(core_err.to_string(), "Session error: Session not found: s1");
    }

    #[test]
    fn core_error_from_file_error() {
        let file_err = FileError::NotFound("/missing".into());
        let core_err: CoreError = file_err.into();
        assert_eq!(core_err.to_string(), "File error: File not found: /missing");
    }

    #[test]
    fn core_error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let core_err: CoreError = io_err.into();
        assert_eq!(core_err.to_string(), "I/O error: gone");
    }

    #[test]
    fn session_error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe broke");
        let session_err: SessionError = io_err.into();
        assert_eq!(session_err.to_string(), "I/O error: pipe broke");
    }

    #[test]
    fn file_error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let file_err: FileError = io_err.into();
        assert_eq!(file_err.to_string(), "I/O error: access denied");
    }
}
