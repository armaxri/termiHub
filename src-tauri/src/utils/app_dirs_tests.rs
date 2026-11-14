//! Tests for the app-owned directory resolver (#5764).

use std::path::{Path, PathBuf};

use tauri::Manager;
use tempfile::TempDir;

use super::*;

fn portable(data_dir: &Path) -> AppMode {
    AppMode::Portable {
        data_dir: data_dir.to_path_buf(),
    }
}

/// A mock Tauri app whose config carries the override for `mode`, exactly as
/// `run()` applies it to the real context.
fn mock_app_for(mode: &AppMode) -> tauri::App<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().app.app_directories_override = directories_override(mode);
    tauri::test::mock_builder()
        .build(context)
        .expect("mock app builds")
}

/// Where each app-owned location actually resolves to in a running app for
/// `mode`, through the same code paths production uses.
fn resolved(dir: AppOwnedDir, mode: &AppMode, app: &tauri::App<tauri::test::MockRuntime>) -> PathBuf {
    let path = app.path();
    match dir {
        // Startup's config resolution: the portable `data/` dir.
        AppOwnedDir::Config => mode
            .data_dir()
            .map(Path::to_path_buf)
            .expect("portable mode has a data dir"),
        AppOwnedDir::Logs => crate::utils::file_log::resolve_log_dir(
            None,
            mode.data_dir(),
            Some(PathBuf::from("/os/logs")),
        )
        .expect("log dir resolves"),
        AppOwnedDir::Cache => path.app_cache_dir().expect("cache dir resolves"),
        AppOwnedDir::AgentBinaryCache => {
            agent_binary_cache_dir(mode, Some(PathBuf::from("/os/cache")))
        }
        // Tauri's default webview data dir on Windows/Linux.
        AppOwnedDir::WebviewData => path.app_local_data_dir().expect("local data dir resolves"),
        AppOwnedDir::Temp => portable_temp_dir(mode).expect("portable temp dir"),
    }
}

#[test]
fn every_app_owned_dir_is_under_the_portable_root_in_portable_mode() {
    let root = TempDir::new().unwrap();
    let data_dir = root.path().join("data");
    let mode = portable(&data_dir);
    let app = mock_app_for(&mode);

    for dir in AppOwnedDir::ALL {
        let path = resolved(dir, &mode, &app);
        assert!(
            path.starts_with(&data_dir),
            "{dir:?} resolves to {path:?}, outside the portable data dir {data_dir:?}"
        );
        assert_eq!(path, dir.portable_path(&data_dir), "{dir:?} layout drifted");
    }
}

#[test]
fn portable_dirs_are_distinct() {
    let data_dir = PathBuf::from("/usb/termiHub/data");
    let paths: Vec<PathBuf> = AppOwnedDir::ALL
        .iter()
        .map(|d| d.portable_path(&data_dir))
        .collect();
    for (i, a) in paths.iter().enumerate() {
        for b in &paths[i + 1..] {
            assert_ne!(a, b, "two app-owned dirs share one path");
        }
    }
}

#[test]
fn installed_mode_has_no_override() {
    assert!(directories_override(&AppMode::Installed).is_none());
}

#[test]
fn portable_override_moves_cache_log_and_webview_but_not_config() {
    let data_dir = PathBuf::from("/usb/termiHub/data");
    let Some(AppDirectoriesOverride::Directories(dirs)) =
        directories_override(&portable(&data_dir))
    else {
        panic!("portable mode must override individual directories");
    };
    assert_eq!(dirs.cache, Some(data_dir.join(CACHE_SUBDIR)));
    assert_eq!(dirs.log, Some(data_dir.join(LOGS_SUBDIR)));
    assert_eq!(dirs.local_data, Some(data_dir.join(WEBVIEW_SUBDIR)));
    // Config resolution keeps its own precedence and temp fallbacks.
    assert_eq!(dirs.config, None);
    assert_eq!(dirs.data, None);
}

#[test]
fn installed_mode_cache_dir_is_the_platform_default() {
    let app = mock_app_for(&AppMode::Installed);
    let cache = app.path().app_cache_dir().expect("cache dir resolves");
    assert!(
        cache.ends_with(&app.config().identifier),
        "installed cache dir {cache:?} must be the platform default"
    );
}

#[test]
fn drag_out_and_plugin_downloads_land_under_the_portable_cache() {
    let data_dir = PathBuf::from("/usb/termiHub/data");
    let app = mock_app_for(&portable(&data_dir));
    let cache = app.path().app_cache_dir().expect("cache dir resolves");
    for sub in [
        crate::files::drag_out::STAGING_DIR_NAME,
        "plugin-downloads",
        "plugin-updates",
    ] {
        assert!(cache.join(sub).starts_with(data_dir.join(CACHE_SUBDIR)));
    }
}

#[test]
fn agent_binary_cache_is_portable_in_portable_mode() {
    let data_dir = PathBuf::from("/usb/termiHub/data");
    assert_eq!(
        agent_binary_cache_dir(&portable(&data_dir), Some(PathBuf::from("/os/cache"))),
        data_dir.join(CACHE_SUBDIR).join(AGENT_BINARIES_SUBDIR)
    );
}

#[test]
fn agent_binary_cache_is_unchanged_in_installed_mode() {
    assert_eq!(
        agent_binary_cache_dir(&AppMode::Installed, Some(PathBuf::from("/os/cache"))),
        PathBuf::from("/os/cache/termihub/agent-binaries")
    );
    assert_eq!(
        agent_binary_cache_dir(&AppMode::Installed, None),
        PathBuf::from("/tmp/termihub/agent-binaries")
    );
}

#[test]
fn temp_dir_is_portable_only_in_portable_mode() {
    let data_dir = PathBuf::from("/usb/termiHub/data");
    assert_eq!(
        portable_temp_dir(&portable(&data_dir)),
        Some(data_dir.join(TEMP_SUBDIR))
    );
    assert_eq!(portable_temp_dir(&AppMode::Installed), None);
}

#[test]
fn ephemeral_webview_store_only_for_portable_macos() {
    let mode = portable(Path::new("/usb/termiHub/data"));
    assert!(ephemeral_webview_store_for(&mode, true));
    assert!(!ephemeral_webview_store_for(&mode, false));
    assert!(!ephemeral_webview_store_for(&AppMode::Installed, true));
    assert!(!ephemeral_webview_store_for(&AppMode::Installed, false));
}

#[test]
fn clean_app_temp_dir_empties_the_portable_temp_dir() {
    let root = TempDir::new().unwrap();
    let data_dir = root.path().join("data");
    let tmp = data_dir.join(TEMP_SUBDIR);
    std::fs::create_dir_all(tmp.join("termihub-edit")).unwrap();
    std::fs::write(tmp.join("termihub-edit").join("a.txt"), b"x").unwrap();
    std::fs::write(data_dir.join("settings.json"), b"{}").unwrap();

    clean_app_temp_dir(&portable(&data_dir));

    assert!(!tmp.exists(), "portable temp dir must be emptied");
    assert!(
        data_dir.join("settings.json").exists(),
        "cleaning temp must not touch the rest of data/"
    );
}

#[test]
fn clean_app_temp_dir_tolerates_a_missing_dir() {
    let root = TempDir::new().unwrap();
    clean_app_temp_dir(&portable(&root.path().join("data")));
}
