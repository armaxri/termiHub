//! Concrete [`ConnectionType`](crate::connection::ConnectionType) implementations.
//!
//! These backends depend on optional platform libraries (e.g., `portable-pty`,
//! `serialport`) and are gated behind cargo features so that consumers that
//! don't need them can avoid the dependency.

#[cfg(feature = "local-shell")]
pub mod local_shell;

#[cfg(feature = "serial")]
pub mod serial;

#[cfg(feature = "telnet")]
pub mod telnet;

#[cfg(feature = "ssh")]
pub mod ssh;

#[cfg(feature = "docker")]
pub mod docker;

#[cfg(all(feature = "wsl", windows))]
pub mod wsl;

#[cfg(feature = "ftp")]
pub mod ftp;

#[cfg(feature = "mock-remote-desktop")]
pub mod mock_remote_desktop;

#[cfg(feature = "vnc")]
pub mod vnc;

// RDP (IronRDP) backend — #1682. The `rdp/` module is implemented but parked
// (not declared here) and its `rdp` cargo feature is commented out, because
// IronRDP cannot currently coexist with the `russh`-based SSH backend: both
// hard-pin mutually-incompatible RustCrypto pre-releases. See the blocker note
// on the ironrdp deps in `core/Cargo.toml`. Restore `#[cfg(feature = "rdp")] pub
// mod rdp;` here (plus the deps, feature, and desktop registration) when the
// upstream conflict clears.
