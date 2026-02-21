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
