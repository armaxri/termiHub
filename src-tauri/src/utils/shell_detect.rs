//! Shell detection — thin delegation layer to `termihub_core`.
//!
//! The canonical implementation now lives in `termihub_core::session::shell`.
//! This module re-exports the functions for backward compatibility with
//! existing callers in the desktop crate.

/// Detect available shells on the current platform.
///
/// Delegates to [`termihub_core::session::shell::detect_available_shells()`].
pub fn detect_available_shells() -> Vec<String> {
    termihub_core::session::shell::detect_available_shells()
}

/// Detect the user's default shell on this platform.
///
/// Delegates to [`termihub_core::session::shell::detect_default_shell()`].
pub fn detect_default_shell() -> Option<String> {
    termihub_core::session::shell::detect_default_shell()
}
