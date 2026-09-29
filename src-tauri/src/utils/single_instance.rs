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

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::portable::AppMode;
use crate::utils::errors::TerminalError;

/// Event the running instance emits to its frontend when a second launch
/// forwarded a workspace to open (#3101). The payload is the workspace name; the
/// frontend launches it exactly as it does a startup `--workspace`.
pub const CLI_WORKSPACE_REQUESTED_EVENT: &str = "cli-workspace-requested";

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
/// plain non-test debug build sees it as dead — expected there, genuinely used in
/// release.
#[cfg_attr(
    all(debug_assertions, not(test)),
    expect(dead_code, reason = "only release builds and the unit tests call it")
)]
pub fn should_enforce_single_instance(mode: &AppMode, is_debug: bool) -> bool {
    !is_debug && !mode.is_portable()
}

/// Single-instance callback: runs inside the **already-running first instance**
/// when a second launch is attempted. Applies any meaningful arguments the second
/// launch carried (see [`handle_forwarded_args`]), then brings the existing window
/// to the front so the user sees the running app; the second process exits
/// automatically (the plugin handles that), never touching the shared
/// config/session files.
///
/// Best-effort and never fatal: a platform that refuses unminimize/show/focus
/// (e.g. some Wayland compositors) still leaves the first instance running and
/// the second exited, which is the property PER-005/SM-025 rely on.
///
/// Spawn/open-connection requests (`termiHub spawn …`) are forwarded to the
/// running instance over a dedicated IPC channel *before* the Tauri builder is
/// reached (see `spawn::classify_command`), so they never arrive here.
#[cfg(not(debug_assertions))]
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    handle_forwarded_args(app, &argv, Path::new(&cwd));
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

/// A workspace a second launch asked the running instance to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceRequest {
    /// `--workspace <NAME>` / `-w <NAME>`: launch a saved workspace by name.
    Name(String),
    /// `--workspace-file <FILE>`: import a definition file, then launch it. The
    /// path is already resolved against the second launch's working directory.
    File(PathBuf),
}

/// The validated, actionable part of a second launch's arguments.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ForwardedArgs {
    /// The workspace to open, if the second launch named one.
    pub workspace: Option<WorkspaceRequest>,
    /// Arguments that were not acted on (unknown, malformed, not forwardable, or
    /// superseded), kept verbatim so they can be logged.
    pub ignored: Vec<String>,
}

/// Parse a second launch's `argv` (program name first, as the single-instance
/// plugin delivers it) into the request the running instance should apply.
///
/// Mirrors the startup flags declared in `tauri.conf.json` (`cli.args`):
/// `--workspace`/`-w` (incl. `--workspace=X` and `-wX`) and `--workspace-file`
/// (incl. `--workspace-file=X`). As at startup (`get_cli_workspace`), a name
/// takes precedence over a file. A relative file path is resolved against
/// `cwd`, the second launch's working directory — the first instance's cwd is
/// unrelated. `--list-workspaces` prints to the second process's own stdout, so
/// there is nothing to forward; it and anything unknown land in `ignored`.
pub fn parse_forwarded_args(argv: &[String], cwd: &Path) -> ForwardedArgs {
    let mut name: Option<String> = None;
    let mut file: Option<(PathBuf, String)> = None;
    let mut ignored = Vec::new();
    let mut args = argv.iter().skip(1).peekable();

    while let Some(arg) = args.next() {
        let (flag, inline) = split_flag(arg);
        let is_name = matches!(flag, "--workspace" | "-w");
        if !is_name && flag != "--workspace-file" {
            ignored.push(arg.clone());
            continue;
        }
        // Take the value inline, or from the next argument unless that is a flag.
        let (value, raw) = match inline {
            Some(v) => (v.to_string(), arg.clone()),
            None => match args.next_if(|next| !next.starts_with('-')) {
                Some(v) => (v.clone(), format!("{arg} {v}")),
                None => (String::new(), arg.clone()),
            },
        };
        if value.is_empty() {
            ignored.push(raw);
        } else if is_name {
            name = Some(value);
        } else {
            file = Some((cwd.join(value), raw));
        }
    }

    let workspace = match (name, file) {
        (Some(name), superseded) => {
            ignored.extend(superseded.map(|(_, raw)| raw));
            Some(WorkspaceRequest::Name(name))
        }
        (None, Some((path, _))) => Some(WorkspaceRequest::File(path)),
        (None, None) => None,
    };
    ForwardedArgs { workspace, ignored }
}

/// Split `--flag=value` / `-wvalue` into the flag and its inline value.
fn split_flag(arg: &str) -> (&str, Option<&str>) {
    if let Some((flag, value)) = arg.split_once('=').filter(|_| arg.starts_with("--")) {
        return (flag, Some(value));
    }
    match arg.strip_prefix("-w") {
        Some(value) if !arg.starts_with("--") && !value.is_empty() => ("-w", Some(value)),
        _ => (arg, None),
    }
}

/// Turn a [`WorkspaceRequest`] into the workspace name to launch. A file is
/// imported through `load_file` (which persists it and returns its name); a
/// failure is logged and yields `None`, never an error the caller must handle.
pub fn resolve_workspace_request(
    request: WorkspaceRequest,
    load_file: impl FnOnce(&Path) -> Result<String, TerminalError>,
) -> Option<String> {
    match request {
        WorkspaceRequest::Name(name) => Some(name),
        WorkspaceRequest::File(path) => match load_file(&path) {
            Ok(name) => Some(name),
            Err(e) => {
                tracing::warn!("single-instance: ignoring forwarded workspace file: {e}");
                None
            }
        },
    }
}

/// Receiver for a second launch's arguments in the running instance (#3101).
///
/// Validates `argv`, logs every argument it ignores, and — when a workspace was
/// requested — emits [`CLI_WORKSPACE_REQUESTED_EVENT`] so the frontend launches it
/// as if it had been passed at startup. Returns the emitted workspace name. A
/// bare re-launch emits nothing (the caller just focuses the window).
///
/// Only the release-only [`on_second_instance`] and the unit tests call this.
#[cfg_attr(
    all(debug_assertions, not(test)),
    expect(dead_code, reason = "only release builds and the unit tests call it")
)]
pub fn handle_forwarded_args<R: Runtime>(
    app: &AppHandle<R>,
    argv: &[String],
    cwd: &Path,
) -> Option<String> {
    let ForwardedArgs { workspace, ignored } = parse_forwarded_args(argv, cwd);
    if !ignored.is_empty() {
        tracing::info!(
            ignored = ?ignored,
            "single-instance: ignoring unsupported second-launch arguments"
        );
    }
    let name = resolve_workspace_request(workspace?, |path| {
        let manager = app
            .try_state::<crate::workspace::manager::WorkspaceManager>()
            .ok_or_else(|| {
                TerminalError::WorkspaceError("workspace manager not available".to_string())
            })?;
        crate::commands::workspace::load_workspace_file(path, &manager)
    })?;
    tracing::info!(workspace = %name, "single-instance: opening forwarded workspace");
    if let Err(e) = app.emit(CLI_WORKSPACE_REQUESTED_EVENT, &name) {
        tracing::warn!("single-instance: failed to forward workspace request: {e}");
        return None;
    }
    Some(name)
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

#[cfg(test)]
#[path = "single_instance_forward_tests.rs"]
mod forward_tests;
