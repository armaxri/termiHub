//! Desktop hosting for the embedded HTTP/FTP/TFTP servers.
//!
//! The server implementations and their `Service` lift were relocated into
//! [`termihub_core::embedded_servers`] (#2192) so the same code can run on the
//! desktop or a remote agent. The desktop keeps only the host-specific pieces —
//! the [`server_manager`] (config store, run-location routing, Tauri event
//! bridge) and its [`storage`] — and re-exports the relocated `config` and
//! `service` modules so existing `crate::embedded_servers::{config, service}`
//! paths keep working unchanged.

pub mod server_manager;
pub mod storage;

pub use termihub_core::embedded_servers::{config, service};
