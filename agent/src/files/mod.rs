//! Connection-scoped file browsing for the agent.
//!
//! Currently provides a local filesystem backend. Other connection types
//! will use `ConnectionType::file_browser()` from `termihub_core`.

pub mod local;

pub use termihub_core::errors::FileError;
pub use termihub_core::files::FileBackend;
