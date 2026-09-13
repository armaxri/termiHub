//! JSON-RPC request/response DTOs and method-name constants.
//!
//! These moved to `termihub_core::protocol::methods` so the desktop
//! (`src-tauri`) and the agent share one definition of the wire types and
//! method names (DUP-001 / DUP-002). This re-export keeps the existing
//! `crate::protocol::methods::*` paths working unchanged.

pub use termihub_core::protocol::methods::*;
