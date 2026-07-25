//! Desktop helpers for per-session output logging (#1960).
//!
//! The core [`SessionLogger`](termihub_core::output::session_log::SessionLogger)
//! is date-library free and takes an injected clock. This module supplies the
//! desktop wiring: a `chrono`-based clock for per-line timestamps and the
//! default transcript location (`<connection>-<timestamp>.log` beside the app
//! diagnostics log).

use std::path::PathBuf;

use chrono::Local;
use termihub_core::output::session_log::{default_log_filename, Clock};

use crate::utils::file_log;

/// A clock producing millisecond-precision local timestamps for line prefixes.
pub fn desktop_clock() -> Clock {
    Box::new(|| Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string())
}

/// The default directory for per-session transcripts: a `sessions` subfolder
/// beside the platform app-log directory (`file_log::log_dir()`).
pub fn default_session_log_dir() -> Option<PathBuf> {
    file_log::log_dir().map(|d| d.join("sessions"))
}

/// Build the default transcript path for a session titled `title`.
///
/// Yields `<default dir>/<sanitized-title>-<YYYYMMDD-HHMMSS>.log`. `None` when
/// the platform log directory cannot be resolved.
pub fn default_session_log_path(title: &str) -> Option<PathBuf> {
    let dir = default_session_log_dir()?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    Some(dir.join(default_log_filename(title, &stamp)))
}
