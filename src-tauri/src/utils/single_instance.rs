//! Single-instance enforcement (per user) for installed release builds.
//!
//! Running two copies of termiHub at once lets them clobber each other's shared
//! config and last-session files: neither store takes a cross-process lock
//! (finding PER-005), and `last_session` writes are last-writer-wins (finding
//! SM-025, `workspace/last_session.rs`). Enforcing a single instance closes both
//! races at the source — the second launch never writes the shared files at all,
//! because it focuses the already-running window and exits.
//!
//! Two deliberate exclusions keep legitimate multi-instance workflows working:
//!
//! * **Debug builds are never locked** — the parallel dev-checkout workflow runs
//!   many debug copies (`scripts/dev.sh` builds debug) at once. The plugin
//!   registration in `lib.rs` is gated behind `#[cfg(not(debug_assertions))]`, so
//!   this whole mechanism is compiled out of debug builds.
//! * **Portable mode is never locked** — two portable copies in *different*
//!   folders use *different* `data/` directories and legitimately do not clobber
//!   one another. A global lock keyed on the bundle id would wrongly block them,
//!   so [`should_enforce_single_instance`] returns `false` for portable mode even
//!   in a release build. (The narrow residual — two portable copies sharing one
//!   `data/` dir — is left for a dedicated data-dir file lock.)

// Only the release-only `on_second_instance` callback below touches the Tauri
// window API; in debug builds this whole callback is compiled out, so the import
// would otherwise be unused.
#[cfg(not(debug_assertions))]
use tauri::{AppHandle, Manager, Runtime};

use super::portable::AppMode;

/// Decide whether this process should enforce single-instance behavior.
///
/// Returns `true` only for an **installed** app running a **release** build.
/// Portable mode and debug builds are excluded (see the module docs for why).
///
/// `is_debug` is threaded in as a parameter (rather than read from
/// `cfg!(debug_assertions)` inside) purely so the gating rule can be exercised
/// directly by unit tests across both build flavors.
///
/// Only the release registration path and the (debug) unit tests call this, so a
/// plain non-test debug build sees it as dead — allowed there, genuinely used in
/// release.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn should_enforce_single_instance(mode: &AppMode, is_debug: bool) -> bool {
    !is_debug && !mode.is_portable()
}

/// Single-instance callback: runs inside the **already-running first instance**
/// when a second launch is attempted. Brings the existing window to the front so
/// the user sees the running app; the second process then exits automatically
/// (the plugin handles that), never touching the shared config/session files.
///
/// Best-effort and never fatal: a platform that refuses unminimize/show/focus
/// (e.g. some Wayland compositors) still leaves the first instance running and
/// the second exited, which is the property PER-005/SM-025 rely on.
///
/// `_argv`/`_cwd` carry the second launch's arguments. Spawn/open-connection
/// requests (`termiHub spawn …`) are already forwarded to the running instance
/// over a dedicated IPC channel *before* the Tauri builder is reached (see
/// `spawn::classify_command`), so they never arrive here. Forwarding arbitrary
/// args through this callback is deferred as a follow-up.
#[cfg(not(debug_assertions))]
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, _argv: Vec<String>, _cwd: String) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("single-instance: second launch but no main window to focus");
        return;
    };
    if let Err(e) = window.unminimize() {
        tracing::warn!("single-instance: failed to unminimize main window: {e}");
    }
    if let Err(e) = window.show() {
        tracing::warn!("single-instance: failed to show main window: {e}");
    }
    if let Err(e) = window.set_focus() {
        tracing::warn!("single-instance: failed to focus main window: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn enforces_for_installed_release() {
        assert!(should_enforce_single_instance(
            &AppMode::Installed,
            /* is_debug */ false
        ));
    }

    #[test]
    fn does_not_enforce_for_installed_debug() {
        // Debug builds power the parallel dev-checkout workflow — never lock them.
        assert!(!should_enforce_single_instance(
            &AppMode::Installed,
            /* is_debug */ true
        ));
    }

    #[test]
    fn does_not_enforce_for_portable_release() {
        // Two portable copies in different folders use different data dirs and
        // legitimately do not clobber — a global lock would wrongly block them.
        let portable = AppMode::Portable {
            data_dir: PathBuf::from("/usb/termiHub/data"),
        };
        assert!(!should_enforce_single_instance(
            &portable, /* is_debug */ false
        ));
    }

    #[test]
    fn does_not_enforce_for_portable_debug() {
        let portable = AppMode::Portable {
            data_dir: PathBuf::from("/usb/termiHub/data"),
        };
        assert!(!should_enforce_single_instance(
            &portable, /* is_debug */ true
        ));
    }
}
