//! External-trigger session opening for local/WSL/SSH spawns (#1365, SI-2).
//!
//! The parallel of [`container`](super::container) for the "open a shell at the
//! target directory" path. A `termiHub spawn` that reaches the running instance
//! is turned into a session the frontend opens:
//!
//! 1. the target `location` is resolved to a working directory — a folder is
//!    used as-is, a file resolves to its parent, and a missing path falls back
//!    to the home directory (flagged so the frontend can warn), with symlinks
//!    resolved,
//! 2. the resolved directory becomes the shell's starting directory (the
//!    `core/src/backends/local_shell.rs` `cwd` path — so the session opens
//!    `cd`'d to the target without a fragile post-start `cd`), and
//! 3. the main window is focused and the request is delivered to the frontend
//!    over the shared `spawn-request` event so it opens the tab and confirms
//!    with a toast.
//!
//! The path-resolution and Windows→WSL conversion helpers are pure so they are
//! unit-testable without a Tauri `AppHandle` (the high-value, macOS-runnable
//! coverage for this feature).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::{SpawnKind, SpawnRequest, SPAWN_REQUEST_EVENT};

/// A spawn target resolved to a concrete working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLocation {
    /// Directory the session should open in (`cd` target).
    pub cwd: PathBuf,
    /// `true` when the requested path did not exist and `cwd` fell back to home.
    pub missing: bool,
}

/// A resolved shell spawn: the local-shell settings JSON to hand to
/// `create_connection("local", …)` plus a display title carrying the "Spawned"
/// marker for the tab badge. Mirrors [`ContainerSpawn`](super::container::ContainerSpawn).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpawn {
    /// Local-shell backend settings (camelCase JSON) for the spawned session.
    pub settings: serde_json::Value,
    /// Human-readable tab title, e.g. `"Shell: project (Spawned)"`.
    pub title: String,
    /// Always `true` — distinguishes spawned shells from configured connections
    /// so the frontend can badge and track them separately.
    pub spawned: bool,
    /// `true` when the requested path was missing and home was substituted, so
    /// the frontend can surface a warning.
    pub missing: bool,
}

/// Cold-start pending spawn slot.
///
/// A spawn handed to this instance before the UI is ready cannot be delivered by
/// an event (no frontend listener yet), so it is parked here and drained by the
/// frontend via `take_pending_spawn` once its listener is registered.
#[derive(Default)]
pub struct PendingSpawn(pub Mutex<Option<SpawnRequest>>);

/// Resolve a spawn target `location` into a working directory.
///
/// - `None`/empty → `home` (not treated as "missing").
/// - Existing directory → that directory, with symlinks resolved.
/// - Existing file → the file's parent directory, with symlinks resolved.
/// - Missing path → `home`, flagged `missing = true`.
pub fn resolve_spawn_location(location: Option<&str>, home: &Path) -> ResolvedLocation {
    todo!("resolve_spawn_location")
}

/// Convert a Windows absolute path to its WSL `/mnt/` equivalent.
///
/// `C:\Users\foo\bar.sh` → `/mnt/c/Users/foo/bar.sh`. Returns `None` when the
/// path does not start with a drive-letter prefix. Mirrors
/// `core/src/backends/wsl.rs::windows_path_to_wsl_path` so WSL spawns land in the
/// distribution-visible mount path.
pub fn windows_path_to_wsl_path(win_path: &str) -> Option<String> {
    todo!("windows_path_to_wsl_path")
}

/// Build the resolved [`ShellSpawn`] for a spawn request, resolving its target
/// against `home`. For a WSL-kind spawn the resolved directory is converted to
/// its `/mnt/` path so the distribution opens in the right place.
pub fn build_shell_spawn(req: &SpawnRequest, home: &Path) -> ShellSpawn {
    todo!("build_shell_spawn")
}

/// The home directory, falling back to `.` when it cannot be determined.
fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Focus the main window, best-effort. Logged (not fatal) on failure so a spawn
/// still opens its tab even when the platform refuses the focus (e.g. Wayland).
pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.set_focus() {
            tracing::warn!("failed to focus window for spawn: {e}");
        }
    }
}

/// Focus the main window and deliver a spawn request to the frontend over the
/// shared [`SPAWN_REQUEST_EVENT`]. Used for warm spawns (a running instance
/// reached over IPC or the macOS Services provider).
pub fn emit_spawn_request<R: Runtime>(app: &AppHandle<R>, req: &SpawnRequest) -> tauri::Result<()> {
    focus_main_window(app);
    app.emit(SPAWN_REQUEST_EVENT, req)
}

/// Park a cold-start spawn request so the frontend drains it once ready, and
/// focus the window so the launched instance surfaces immediately.
pub fn store_pending_spawn<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingSpawn,
    req: SpawnRequest,
) {
    focus_main_window(app);
    if let Ok(mut slot) = pending.0.lock() {
        *slot = Some(req);
    }
}

/// Drain the parked cold-start spawn request, if any.
pub fn take_pending_spawn(pending: &PendingSpawn) -> Option<SpawnRequest> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn none_location_resolves_to_home_not_missing() {
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(None, &home);
        assert_eq!(resolved.cwd, home);
        assert!(!resolved.missing);
    }

    #[test]
    fn empty_location_resolves_to_home_not_missing() {
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(Some("   "), &home);
        assert_eq!(resolved.cwd, home);
        assert!(!resolved.missing);
    }

    #[test]
    fn existing_directory_resolves_to_itself() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(Some(dir.path().to_str().unwrap()), &home);
        // Canonicalize the expectation too, to tolerate /var → /private/var on macOS.
        assert_eq!(resolved.cwd, fs::canonicalize(dir.path()).unwrap());
        assert!(!resolved.missing);
    }

    #[test]
    fn existing_file_resolves_to_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("script.sh");
        fs::write(&file, b"echo hi").expect("write file");
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(Some(file.to_str().unwrap()), &home);
        assert_eq!(resolved.cwd, fs::canonicalize(dir.path()).unwrap());
        assert!(!resolved.missing);
    }

    #[test]
    fn missing_path_falls_back_to_home_and_flags_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(Some(missing.to_str().unwrap()), &home);
        assert_eq!(resolved.cwd, home);
        assert!(resolved.missing);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_directory_resolves_to_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real-dir");
        fs::create_dir(&real).expect("create real dir");
        let link = dir.path().join("link-dir");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let home = PathBuf::from("/home/user");
        let resolved = resolve_spawn_location(Some(link.to_str().unwrap()), &home);
        assert_eq!(resolved.cwd, fs::canonicalize(&real).unwrap());
        assert!(!resolved.missing);
    }

    #[test]
    fn windows_path_converts_to_wsl_mount() {
        assert_eq!(
            windows_path_to_wsl_path(r"C:\Users\foo\bar.sh").as_deref(),
            Some("/mnt/c/Users/foo/bar.sh")
        );
        assert_eq!(windows_path_to_wsl_path(r"D:\").as_deref(), Some("/mnt/d"));
    }

    #[test]
    fn non_drive_path_has_no_wsl_conversion() {
        assert_eq!(windows_path_to_wsl_path("/already/unix"), None);
        assert_eq!(windows_path_to_wsl_path("relative/path"), None);
    }

    #[test]
    fn build_shell_spawn_sets_starting_directory_and_spawned_flag() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = PathBuf::from("/home/user");
        let req = SpawnRequest {
            location: Some(dir.path().to_str().unwrap().to_string()),
            kind: SpawnKind::Local,
            ..SpawnRequest::default()
        };
        let spawn = build_shell_spawn(&req, &home);
        assert!(spawn.spawned);
        assert!(!spawn.missing);
        assert!(spawn.title.contains("Spawned"), "title: {}", spawn.title);
        let cwd = fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            spawn.settings["startingDirectory"],
            json!(cwd.to_string_lossy())
        );
    }

    #[test]
    fn build_shell_spawn_missing_target_uses_home_and_flags_missing() {
        let home = PathBuf::from("/home/user");
        let req = SpawnRequest {
            location: Some("/no/such/path/here".to_string()),
            kind: SpawnKind::Local,
            ..SpawnRequest::default()
        };
        let spawn = build_shell_spawn(&req, &home);
        assert!(spawn.missing);
        assert_eq!(
            spawn.settings["startingDirectory"],
            json!(home.to_string_lossy())
        );
    }

    #[test]
    fn build_shell_spawn_wsl_kind_converts_windows_path() {
        // A WSL spawn's resolved Windows directory is converted to its /mnt path
        // so the distribution opens in the right place. Use a path that does not
        // exist so resolution falls back to `home` deterministically, then the
        // WSL conversion applies to that Windows-style home.
        let home = PathBuf::from(r"C:\Users\foo");
        let req = SpawnRequest {
            location: None,
            kind: SpawnKind::Wsl,
            ..SpawnRequest::default()
        };
        let spawn = build_shell_spawn(&req, &home);
        assert_eq!(
            spawn.settings["startingDirectory"],
            json!("/mnt/c/Users/foo")
        );
    }
}
