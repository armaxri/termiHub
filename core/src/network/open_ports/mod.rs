//! List local listening ports — platform-specific implementations.

use crate::network::error::NetworkError;
use crate::network::types::OpenPort;

#[cfg(windows)]
mod windows;

// Pure decoding of the Windows socket-owner tables (#3814); compiled on every
// platform under `test` so the macOS/Linux legs exercise it too.
#[cfg(any(windows, test))]
mod win_table;

#[cfg(unix)]
mod unix;

/// Return the list of listening TCP/UDP ports on the local machine.
///
/// Blocking: call it off the async reactor (`spawn_blocking`).
///
/// Includes process name and PID where available. Uses platform-specific
/// methods:
/// - **macOS / Linux**: `lsof` subprocess or `/proc/net` parsing
/// - **Windows**: `GetExtendedTcpTable` / `GetExtendedUdpTable` + a Toolhelp
///   process snapshot via `windows-sys` — no child process (#3814)
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
