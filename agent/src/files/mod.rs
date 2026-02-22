//! Connection-scoped file browsing for the agent.
//!
//! Each connection type (local, docker, ssh) provides its own implementation
//! of the [`FileBackend`] trait from the core crate. The dispatcher resolves
//! which backend to use based on the connection's `session_type`.

#[cfg(unix)]
pub mod docker;
pub mod local;
pub mod ssh;

pub use termihub_core::errors::FileError;
pub use termihub_core::files::FileBackend;

// ── Re-exported utility functions from core ──────────────────────────
pub use termihub_core::files::utils::{chrono_from_epoch, format_permissions};
