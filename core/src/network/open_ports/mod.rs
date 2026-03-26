//! List local listening ports — platform-specific implementations.

use crate::network::error::NetworkError;
use crate::network::types::OpenPort;

#[cfg(windows)]
mod windows;

#[cfg(unix)]
mod unix;

/// Return the list of listening TCP/UDP ports on the local machine.
///
/// Includes process name and PID where available. Uses platform-specific
/// methods:
/// - **macOS / Linux**: `lsof` subprocess or `/proc/net` parsing
/// - **Windows**: `GetExtendedTcpTable` / `GetExtendedUdpTable` via `windows-sys`
pub fn list_open_ports() -> Result<Vec<OpenPort>, NetworkError> {
    #[cfg(windows)]
    {
        windows::list_open_ports()
    }
    #[cfg(unix)]
    {
        unix::list_open_ports()
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(NetworkError::Platform(
            "open ports listing is not supported on this platform".into(),
        ))
    }
}
