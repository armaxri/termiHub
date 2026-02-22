//! Concrete [`ConnectionType`](crate::connection::ConnectionType) implementations.
//!
//! These backends depend on optional platform libraries (e.g., `portable-pty`)
//! and are gated behind cargo features so that consumers that don't need them
//! (like the agent crate) can avoid the dependency.

pub mod local_shell;
