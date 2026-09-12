//! Shared resolution of termiHub's per-user config directory.
//!
//! The same rule is needed from many storage modules and from the pre-init CLI
//! path, so it lives here once instead of being copy-pasted. In priority order:
//!
//! 1. a [`ConfigDirOverride`] published as Tauri managed state always wins when
//!    a [`AppHandle`] is available. `run()`'s setup resolves the effective
//!    config directory once — folding in the external override, portable mode,
//!    and any temp-dir fallback — and manages it here, so every storage module
//!    reads that one explicit value. This is the threaded channel that replaced
//!    the app mutating a process-global `TERMIHUB_CONFIG_DIR` on itself
//!    (WA-RS-011);
//! 2. an explicit external `TERMIHUB_CONFIG_DIR` override (a public, documented
//!    knob used by the system-test harness, the README, and power users). It is
//!    read directly only before the managed override exists — the pre-init CLI
//!    path, or during startup's own resolution — because the managed override
//!    already folds it in;
//! 3. with a Tauri [`AppHandle`], defer to Tauri's own path resolver
//!    (`app_config_dir()`), which reads the bundle identifier from
//!    `tauri.conf.json`;
//! 4. without an `AppHandle` (pre-init CLI subcommands, which run before the
//!    Tauri app and its path resolver exist), detect portable mode directly and
//!    otherwise fall back to the OS per-user config directory joined with
//!    [`APP_IDENTIFIER`] — equivalent to what `app_config_dir()` would return.

use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::portable::detect_app_mode;

/// The effective config directory, resolved once at startup and published as
/// Tauri managed state.
///
/// This is the explicit channel that replaced the app writing the portable
/// `data/` directory (or a temp fallback) into its own process-global
/// `TERMIHUB_CONFIG_DIR` environment variable (WA-RS-011). `run()`'s setup
/// resolves the directory — external override → portable data dir → OS default,
/// with a temp-dir fallback — and hands it here via `app.manage(..)`. Every
/// storage module's [`resolve_config_dir`] then reads this one value instead of
/// re-consulting a mutable global, so the portable/fallback directory is passed
/// by explicit state rather than an invisible, order-dependent side channel.
#[derive(Debug, Clone)]
pub struct ConfigDirOverride(pub PathBuf);

/// The OS per-user config directory via Tauri's own path resolver.
///
/// This is what installed mode uses, and what [`resolve_config_dir`]'s handle
/// branch falls back to. Split out so startup can resolve it explicitly without
/// going through the managed-override / external-env precedence.
pub fn app_config_dir(handle: &AppHandle) -> Result<PathBuf> {
    handle
        .path()
        .app_config_dir()
        .context("Failed to resolve app config directory")
}

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
    // 1. The running app resolves the effective config directory once at startup
    //    — folding in the external override, portable mode, and any temp-dir
    //    fallback — and publishes it as managed `ConfigDirOverride` state. When
    //    present it is authoritative: this is the explicit channel that replaced
    //    the app self-mutating `TERMIHUB_CONFIG_DIR` (WA-RS-011).
    if let Some(handle) = app_handle {
        if let Some(override_dir) = handle.try_state::<ConfigDirOverride>() {
            return Ok(override_dir.0.clone());
        }

        // 2. External `TERMIHUB_CONFIG_DIR` override (public: system-test
        //    harness, README, power users). Reached only before the managed
        //    override exists — i.e. during startup's own resolution.
        if let Ok(dir) = std::env::var("TERMIHUB_CONFIG_DIR") {
            return Ok(PathBuf::from(dir));
        }

        // 3. Tauri's resolver already knows the OS config dir joined with the
        //    bundle identifier from `tauri.conf.json`.
        return app_config_dir(handle);
    }

    // 4. Pre-init: no handle (CLI subcommands run before the Tauri app exists).
    //    Apply the same precedence — external override → portable `data/` dir →
    //    OS default — with each input passed explicitly for testability.
    let external_override = std::env::var("TERMIHUB_CONFIG_DIR").ok().map(PathBuf::from);
    let portable_data_dir = detect_app_mode()
        .ok()
        .and_then(|mode| mode.data_dir().map(Path::to_path_buf));
    standalone_config_dir(external_override, portable_data_dir, dirs::config_dir())
}

/// Pure resolver for the no-`AppHandle` (pre-init) path, split out for testing.
///
/// Mirrors the running-app precedence for the paths reachable without a Tauri
/// handle: an explicit external override wins, then the portable `data/`
/// directory when present, otherwise the OS per-user config base joined with
/// [`APP_IDENTIFIER`]. Taking each input explicitly keeps the precedence
/// testable without mutating the process environment.
fn standalone_config_dir(
    external_override: Option<PathBuf>,
    portable_data_dir: Option<PathBuf>,
    fallback_base: Option<PathBuf>,
) -> Result<PathBuf> {
    if let Some(dir) = external_override {
        return Ok(dir);
    }
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
    fn standalone_external_override_wins_over_portable_and_base() {
        // The external `TERMIHUB_CONFIG_DIR` override outranks both portable mode
        // and the OS default. Threading it as an explicit argument lets this
        // precedence be asserted without mutating the process environment.
        let external = PathBuf::from("/explicit/override");
        let resolved = standalone_config_dir(
            Some(external.clone()),
            Some(PathBuf::from("/usb/termiHub/data")),
            Some(PathBuf::from("/home/u/.config")),
        )
        .expect("resolution succeeds");
        assert_eq!(resolved, external);
    }

    #[test]
    fn standalone_prefers_portable_data_dir() {
        let portable = PathBuf::from("/usb/termiHub/data");
        let resolved = standalone_config_dir(
            None,
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
            standalone_config_dir(None, None, Some(base.clone())).expect("resolution succeeds");
        assert_eq!(resolved, base.join(APP_IDENTIFIER));
    }

    #[test]
    fn standalone_errors_without_override_portable_or_base() {
        let result = standalone_config_dir(None, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn config_dir_override_carries_its_path() {
        // The managed-state newtype simply carries the resolved directory that
        // `resolve_config_dir`'s handle branch returns verbatim.
        let dir = PathBuf::from("/portable/data");
        let override_state = ConfigDirOverride(dir.clone());
        assert_eq!(override_state.0, dir);
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
