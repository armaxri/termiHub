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
