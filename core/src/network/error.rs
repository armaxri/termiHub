//! Error type for network diagnostic operations.

use thiserror::Error;

/// Errors that can occur during network diagnostic operations.
#[derive(Error, Debug)]
pub enum NetworkError {
    /// The target hostname could not be resolved.
    #[error("DNS resolution failed for '{host}': {reason}")]
    DnsResolution { host: String, reason: String },

    /// The operation requires privileges (e.g. raw sockets for ICMP) that are
    /// not available. The tool should fall back to an unprivileged alternative.
    #[error("Insufficient privileges for {operation}: {reason}")]
    InsufficientPrivileges { operation: String, reason: String },

    /// The host was not reachable (timeout, network unreachable, etc.).
    #[error("Host unreachable: {0}")]
    HostUnreachable(String),

    /// An invalid parameter was supplied by the caller.
    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),

    /// A platform API call failed.
    #[error("Platform error: {0}")]
    Platform(String),

    /// The operation was cancelled by the caller.
    #[error("Operation cancelled")]
    Cancelled,

    /// A low-level I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
