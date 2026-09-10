//! Shared resolution of termiHub's per-user config directory.
//!
//! The same three-branch rule is needed from many storage modules and from the
//! pre-init CLI path, so it lives here once instead of being copy-pasted:
//!
//! 1. an explicit `TERMIHUB_CONFIG_DIR` override always wins (this is also how
//!    `run()`'s setup redirects storage to the portable `data/` directory — it
//!    exports the var before any storage module resolves its path);
//! 2. with a Tauri [`AppHandle`], defer to Tauri's own path resolver
//!    (`app_config_dir()`), which reads the bundle identifier from
//!    `tauri.conf.json`;
//! 3. without an `AppHandle` (pre-init CLI subcommands, which run before the
//!    Tauri app and its path resolver exist), detect portable mode directly and
//!    otherwise fall back to the OS per-user config directory joined with
//!    [`APP_IDENTIFIER`] — equivalent to what `app_config_dir()` would return.

use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::portable::detect_app_mode;

/// Application bundle identifier, mirroring `tauri.conf.json`'s `identifier`.
///
/// Used to reconstruct the OS per-user config directory when no Tauri
/// [`AppHandle`] (and thus no `app_config_dir()`) is available — i.e. from
/// pre-init CLI subcommands. The `app_identifier_matches_tauri_conf` test guards
/// this against drift from `tauri.conf.json`.
const APP_IDENTIFIER: &str = "com.termihub.app";

/// Resolve termiHub's per-user config directory.
///
/// Applies the shared three-branch rule (env override → portable `data/`
/// directory → OS config dir + identifier). Pass `Some(handle)` when a Tauri
/// [`AppHandle`] is available (the common case) and `None` from pre-init CLI
/// paths that run before the Tauri app exists.
///
/// This does not create the directory — callers that need it materialized
/// should `fs::create_dir_all` the returned path.
pub fn resolve_config_dir(app_handle: Option<&AppHandle>) -> Result<PathBuf> {
    // 1. An explicit override always wins. `run()`'s setup also exports this for
    //    portable mode, so the handle branch below never sees portable mode.
    if let Ok(dir) = std::env::var("TERMIHUB_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }

    // 2. With a handle, Tauri's resolver already knows the OS config dir joined
    //    with the bundle identifier from `tauri.conf.json`.
    if let Some(handle) = app_handle {
        return handle
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory");
    }

    // 3. Pre-init: no handle. Detect portable mode ourselves, otherwise fall
    //    back to the OS per-user config directory joined with the identifier.
    let portable_data_dir = detect_app_mode()
        .ok()
        .and_then(|mode| mode.data_dir().map(Path::to_path_buf));
    standalone_config_dir(portable_data_dir, dirs::config_dir())
}

/// Pure resolver for the no-`AppHandle` (pre-init) path, split out for testing.
///
/// Prefers the portable `data/` directory when present; otherwise joins the OS
/// per-user config base with [`APP_IDENTIFIER`].
fn standalone_config_dir(
    portable_data_dir: Option<PathBuf>,
    fallback_base: Option<PathBuf>,
) -> Result<PathBuf> {
    if let Some(data_dir) = portable_data_dir {
        return Ok(data_dir);
    }
    let base = fallback_base.context("Failed to resolve user config directory")?;
    Ok(base.join(APP_IDENTIFIER))
}

/// Outcome of [`create_dir_with_fallback`].
///
/// Startup must never panic just because a directory could not be created
/// (ERR-004 / WA-RS-003): read-only portable media, a locked-down profile, a
/// full disk, or a config path that exists as a file are all realistic. This
/// reports what happened so the caller can log it and keep going.
#[derive(Debug)]
pub enum DirOutcome {
    /// The preferred directory was created (or already existed).
    Preferred(PathBuf),
    /// The preferred directory could not be created, so the fallback is in use.
    /// Carries the fallback path and the error that forced it, for logging.
    Fallback { dir: PathBuf, error: io::Error },
    /// Neither directory could be created. The caller must degrade further
    /// (e.g. keep the preferred path best-effort) but must not panic.
    Failed {
        preferred_error: io::Error,
        fallback_error: io::Error,
    },
}

/// Create `preferred`, falling back to `fallback` when it cannot be created.
///
/// Returns a [`DirOutcome`] describing which directory (if any) now exists. This
/// is what lets startup degrade gracefully instead of `.expect()`-panicking on an
/// unwritable config/data location.
pub fn create_dir_with_fallback(preferred: &Path, fallback: &Path) -> DirOutcome {
    match std::fs::create_dir_all(preferred) {
        Ok(()) => DirOutcome::Preferred(preferred.to_path_buf()),
        Err(preferred_error) => match std::fs::create_dir_all(fallback) {
            Ok(()) => DirOutcome::Fallback {
                dir: fallback.to_path_buf(),
                error: preferred_error,
            },
            Err(fallback_error) => DirOutcome::Failed {
                preferred_error,
                fallback_error,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_identifier_matches_tauri_conf() {
        // The pre-init path reconstructs the config dir as
        // `<os-config>/APP_IDENTIFIER`, duplicating the bundle identifier that
        // Tauri's own `app_config_dir()` reads from `tauri.conf.json`. If the
        // identifier there is ever changed without updating this constant, the
        // pre-init CLI subcommands would read/write a different config than the
        // running app. Guard the duplication with a build-time assertion.
        let conf = include_str!("../../tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(conf).expect("tauri.conf.json is valid JSON");
        let identifier = parsed
            .get("identifier")
            .and_then(serde_json::Value::as_str)
            .expect("tauri.conf.json has a string identifier");
        assert_eq!(
            identifier, APP_IDENTIFIER,
            "APP_IDENTIFIER is out of sync with tauri.conf.json's identifier"
        );
    }

    #[test]
    fn standalone_prefers_portable_data_dir() {
        let portable = PathBuf::from("/usb/termiHub/data");
        let resolved = standalone_config_dir(
            Some(portable.clone()),
            Some(PathBuf::from("/home/u/.config")),
        )
        .expect("resolution succeeds");
        assert_eq!(resolved, portable);
    }

    #[test]
    fn standalone_falls_back_to_config_base_with_identifier() {
        let base = PathBuf::from("/home/u/.config");
        let resolved =
            standalone_config_dir(None, Some(base.clone())).expect("resolution succeeds");
        assert_eq!(resolved, base.join(APP_IDENTIFIER));
    }

    #[test]
    fn standalone_errors_without_portable_or_base() {
        let result = standalone_config_dir(None, None);
        assert!(result.is_err());
    }

    #[test]
    fn fallback_creates_the_preferred_dir_when_possible() {
        let tmp = tempfile::tempdir().unwrap();
        let preferred = tmp.path().join("config");
        let fallback = tmp.path().join("temp-config");

        match create_dir_with_fallback(&preferred, &fallback) {
            DirOutcome::Preferred(dir) => {
                assert_eq!(dir, preferred);
                assert!(preferred.exists());
                assert!(
                    !fallback.exists(),
                    "fallback must not be touched on success"
                );
            }
            other => panic!("expected Preferred, got {other:?}"),
        }
    }

    #[test]
    fn fallback_degrades_when_preferred_cannot_be_created() {
        let tmp = tempfile::tempdir().unwrap();
        // A regular file where the preferred dir's parent should be makes
        // `create_dir_all(preferred)` fail on every platform.
        let blocker = tmp.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let preferred = blocker.join("config");
        let fallback = tmp.path().join("temp-config");

        match create_dir_with_fallback(&preferred, &fallback) {
            DirOutcome::Fallback { dir, .. } => {
                assert_eq!(dir, fallback);
                assert!(fallback.exists(), "fallback dir must be created");
            }
            other => panic!("expected Fallback, got {other:?}"),
        }
    }

    #[test]
    fn fallback_reports_failure_when_neither_can_be_created() {
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        // Both paths sit under the blocking file, so both creations fail.
        let preferred = blocker.join("config");
        let fallback = blocker.join("temp-config");

        match create_dir_with_fallback(&preferred, &fallback) {
            DirOutcome::Failed { .. } => {}
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
