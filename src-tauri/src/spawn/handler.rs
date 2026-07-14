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

use super::{SpawnRequest, SPAWN_REQUEST_EVENT};

/// A spawn target resolved to a concrete working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLocation {
    /// Directory the session should open in (`cd` target).
    pub cwd: PathBuf,
    /// `true` when the requested path did not exist and `cwd` fell back to home.
    pub missing: bool,
}

/// A resolved shell spawn: the backend settings JSON to hand to
/// `create_connection(type, …)` plus a display title carrying the "Spawned"
/// marker for the tab badge. Mirrors [`ContainerSpawn`](super::container::ContainerSpawn).
///
/// The [`session_type`](ShellSpawn::session_type) discriminator tells the
/// frontend which backend to open: a `"local"` shell (`startingDirectory`), a
/// `"wsl"` distribution (`distribution` + `startingDirectory` in its `/mnt/`
/// form), or an `"ssh"` session opened from a saved connection's settings — the
/// latter carrying a [`cd_path`](ShellSpawn::cd_path) to `cd` into after connect,
/// since SSH cannot set a start cwd at spawn (#1511).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpawn {
    /// Backend session type to open: `"local"`, `"wsl"`, or `"ssh"`.
    #[serde(rename = "type")]
    pub session_type: String,
    /// Backend settings (camelCase JSON) for the spawned session.
    pub settings: serde_json::Value,
    /// Human-readable tab title, e.g. `"Shell: project (Spawned)"`.
    pub title: String,
    /// Always `true` — distinguishes spawned shells from configured connections
    /// so the frontend can badge and track them separately.
    pub spawned: bool,
    /// `true` when the requested path was missing and home was substituted, so
    /// the frontend can surface a warning.
    pub missing: bool,
    /// For an SSH spawn: the absolute path to `cd` into once the session
    /// connects (SSH cannot set a start cwd at spawn, so the frontend runs the
    /// `cd` via `send_input`). `None` for local/WSL spawns, which set a real
    /// starting directory. (#1511)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cd_path: Option<String>,
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
    let trimmed = location.map(str::trim).filter(|s| !s.is_empty());
    let Some(loc) = trimmed else {
        return ResolvedLocation {
            cwd: home.to_path_buf(),
            missing: false,
        };
    };

    // `canonicalize` both resolves symlinks and requires the target to exist, so
    // a missing path surfaces as an error and falls back to home.
    match std::fs::canonicalize(loc) {
        Ok(canon) => {
            let cwd = if canon.is_dir() {
                canon
            } else {
                // A file resolves to its parent directory.
                canon
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| home.to_path_buf())
            };
            ResolvedLocation {
                cwd,
                missing: false,
            }
        }
        Err(_) => ResolvedLocation {
            cwd: home.to_path_buf(),
            missing: true,
        },
    }
}

/// Convert a Windows absolute path to its WSL `/mnt/` equivalent.
///
/// `C:\Users\foo\bar.sh` → `/mnt/c/Users/foo/bar.sh`. Returns `None` when the
/// path does not start with a drive-letter prefix. Mirrors
/// `core/src/backends/wsl.rs::windows_path_to_wsl_path` so WSL spawns land in the
/// distribution-visible mount path.
pub fn windows_path_to_wsl_path(win_path: &str) -> Option<String> {
    // Parsed from the raw string (not `std::path::Component`) so the conversion
    // is host-independent — `Path::components` only recognises a drive `Prefix`
    // on Windows targets, which would make this untestable on macOS/Linux.
    let bytes = win_path.as_bytes();
    let drive = match bytes.first() {
        Some(c) if c.is_ascii_alphabetic() => (*c as char).to_ascii_lowercase(),
        _ => return None,
    };
    if bytes.get(1) != Some(&b':') {
        return None;
    }
    // Strip the `C:` prefix, normalise separators, and trim leading/trailing
    // slashes so the join below never produces `//` or a trailing `/`.
    let rest = win_path[2..].replace('\\', "/");
    let rest = rest.trim_matches('/');
    if rest.is_empty() {
        Some(format!("/mnt/{drive}"))
    } else {
        Some(format!("/mnt/{drive}/{rest}"))
    }
}

/// Best-effort tab title for a resolved directory: its final path component,
/// falling back to `fallback` for a root/empty path.
fn spawn_title(cwd: &Path, fallback: &str) -> String {
    let name = cwd
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    format!("{name} (Spawned)")
}

/// Build a resolved **local-shell** [`ShellSpawn`] for a spawn request, resolving
/// its target against `home`. The resolved directory becomes the shell's
/// `startingDirectory` (the `core/src/backends/local_shell.rs` `cwd` path), so
/// the session opens `cd`'d to the target without a fragile post-start `cd`.
pub fn build_shell_spawn(req: &SpawnRequest, home: &Path) -> ShellSpawn {
    let resolved = resolve_spawn_location(req.location.as_deref(), home);
    if resolved.missing {
        tracing::warn!(
            requested = ?req.location,
            "spawn target not found; opening the home directory"
        );
    }

    let starting_directory = resolved.cwd.to_string_lossy().into_owned();

    // Serialised into the exact camelCase keys the local-shell backend parses
    // (`startingDirectory`, `shellIntegration`); the shell itself is left to the
    // system default.
    let settings = json!({
        "startingDirectory": starting_directory,
        "shellIntegration": true,
    });

    ShellSpawn {
        session_type: "local".to_string(),
        settings,
        title: spawn_title(&resolved.cwd, "Shell"),
        spawned: true,
        missing: resolved.missing,
        cd_path: None,
    }
}

/// Build a resolved **WSL** [`ShellSpawn`] for a spawn request against `home`,
/// opening the given `distribution` at the target directory (#1511).
///
/// The resolved Windows directory is converted to its `/mnt/<drive>` form so the
/// distribution opens in the right place; a non-convertible path is used
/// unchanged. The distribution is resolved by the caller — from the saved WSL
/// connection referenced by `--connection`, or the system default distro.
pub fn build_wsl_spawn(req: &SpawnRequest, home: &Path, distribution: &str) -> ShellSpawn {
    let resolved = resolve_spawn_location(req.location.as_deref(), home);
    if resolved.missing {
        tracing::warn!(
            requested = ?req.location,
            "WSL spawn target not found; opening the home directory"
        );
    }

    let native = resolved.cwd.to_string_lossy().into_owned();
    let starting_directory = windows_path_to_wsl_path(&native).unwrap_or(native);

    // The WSL backend parses `distribution` + `startingDirectory` (camelCase).
    let settings = json!({
        "distribution": distribution,
        "startingDirectory": starting_directory,
    });

    ShellSpawn {
        session_type: "wsl".to_string(),
        settings,
        title: spawn_title(&resolved.cwd, "WSL"),
        spawned: true,
        missing: resolved.missing,
        cd_path: None,
    }
}

/// Build a resolved **SSH** [`ShellSpawn`] from a saved SSH connection's settings
/// (#1511).
///
/// SSH cannot set a start cwd at spawn, so the target `location` (if any) is
/// carried in [`ShellSpawn::cd_path`] for the frontend to `cd` into via
/// `send_input` once the session connects. The saved connection's `settings` are
/// used verbatim (host, auth, port, …); `connection_name` names the tab.
pub fn build_ssh_spawn(
    location: Option<&str>,
    ssh_settings: &serde_json::Value,
    connection_name: &str,
) -> ShellSpawn {
    let cd_path = location
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let name = if connection_name.trim().is_empty() {
        "SSH".to_string()
    } else {
        connection_name.trim().to_string()
    };

    ShellSpawn {
        session_type: "ssh".to_string(),
        settings: ssh_settings.clone(),
        title: format!("{name} (Spawned)"),
        spawned: true,
        missing: false,
        cd_path,
    }
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
    use super::super::SpawnKind;
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
        assert_eq!(spawn.session_type, "local");
        assert!(spawn.spawned);
        assert!(!spawn.missing);
        assert!(spawn.cd_path.is_none());
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
    fn build_wsl_spawn_converts_windows_path_and_sets_distribution() {
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
        let spawn = build_wsl_spawn(&req, &home, "Ubuntu");
        assert_eq!(spawn.session_type, "wsl");
        assert!(spawn.spawned);
        assert!(spawn.cd_path.is_none());
        assert_eq!(spawn.settings["distribution"], json!("Ubuntu"));
        assert_eq!(
            spawn.settings["startingDirectory"],
            json!("/mnt/c/Users/foo")
        );
    }

    #[test]
    fn build_ssh_spawn_carries_connection_settings_and_cd_path() {
        // The saved SSH connection's settings are used verbatim, and the target
        // path is carried as `cd_path` for the frontend to `cd` into on connect.
        let settings = json!({ "host": "example.com", "port": 22, "username": "me" });
        let spawn = build_ssh_spawn(Some("/srv/app"), &settings, "My Server");
        assert_eq!(spawn.session_type, "ssh");
        assert!(spawn.spawned);
        assert!(!spawn.missing);
        assert_eq!(spawn.settings, settings);
        assert_eq!(spawn.cd_path.as_deref(), Some("/srv/app"));
        assert_eq!(spawn.title, "My Server (Spawned)");
    }

    #[test]
    fn build_ssh_spawn_without_location_has_no_cd_path() {
        let settings = json!({ "host": "h", "username": "u" });
        let spawn = build_ssh_spawn(None, &settings, "");
        assert_eq!(spawn.session_type, "ssh");
        assert!(spawn.cd_path.is_none());
        // An empty connection name falls back to a generic "SSH" tab title.
        assert_eq!(spawn.title, "SSH (Spawned)");
    }
}
