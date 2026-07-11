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
}
