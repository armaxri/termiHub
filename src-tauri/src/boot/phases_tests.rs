//! Per-phase boot tests on `tauri::test::mock_app()` (#5311).
//!
//! Every path is a temp dir: the config-dir phase gets its environment inputs
//! explicitly (never the real `TERMIHUB_CONFIG_DIR` or OS config dir), and the
//! credentials phase runs with the app-handle wiring swapped for a recorder.
//! No window is built.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::{mock_app, MockRuntime};
use tauri::{Listener, Manager};

use super::{
    init_credentials_and_connections_with, resolve_and_manage_config_dir_with, ConfigDirInputs,
};
use crate::connection::manager::ConnectionManager;
use crate::connection::recovery::RecoveryWarning;
use crate::credential::{CredentialManager, MasterPasswordStore};
use crate::utils::config_paths::ConfigDirOverride;
use crate::utils::portable::AppMode;

type MockApp = tauri::App<MockRuntime>;

fn installed(override_dir: &Path, temp_root: &Path) -> ConfigDirInputs {
    ConfigDirInputs {
        external_override: Some(override_dir.to_path_buf()),
        app_mode: AppMode::Installed,
        temp_root: temp_root.to_path_buf(),
    }
}

fn resolve(app: &MockApp, inputs: ConfigDirInputs) -> (PathBuf, Vec<RecoveryWarning>) {
    let mut warnings = Vec::new();
    let dir = resolve_and_manage_config_dir_with(app, inputs, &mut warnings);
    (dir, warnings)
}

fn file_names(warnings: &[RecoveryWarning]) -> Vec<&str> {
    warnings.iter().map(|w| w.file_name.as_str()).collect()
}

// ── Config-dir phase ────────────────────────────────────────────────────────

#[test]
fn a_missing_config_dir_is_created_and_managed_without_a_warning() {
    let tmp = tempfile::tempdir().unwrap();
    let wanted = tmp.path().join("not/yet/there");
    let app = mock_app();

    let (dir, warnings) = resolve(&app, installed(&wanted, &tmp.path().join("temp")));

    assert_eq!(dir, wanted);
    assert!(wanted.is_dir());
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(app.state::<ConfigDirOverride>().0, wanted);
    assert!(!app.state::<AppMode>().is_portable());
}

#[test]
fn an_unwritable_config_dir_falls_back_to_temp_storage_with_a_warning() {
    let tmp = tempfile::tempdir().unwrap();
    // A config path that exists as a file can never be created as a dir.
    let blocked = tmp.path().join("config-is-a-file");
    std::fs::write(&blocked, b"").unwrap();
    let temp_root = tmp.path().join("temp");
    let app = mock_app();

    let (dir, warnings) = resolve(&app, installed(&blocked, &temp_root));

    let fallback = temp_root.join("termihub-config");
    assert_eq!(dir, fallback);
    assert!(fallback.is_dir());
    assert_eq!(file_names(&warnings), vec!["config directory"]);
    assert!(warnings[0].message.contains("temporary storage"));
    // Every storage module reads the fallback, not the unusable path.
    assert_eq!(app.state::<ConfigDirOverride>().0, fallback);
}

#[test]
fn a_config_dir_without_any_usable_fallback_continues_best_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let blocked = tmp.path().join("config-is-a-file");
    std::fs::write(&blocked, b"").unwrap();
    // The temp root is a file too, so the fallback cannot be created either.
    let temp_root = tmp.path().join("temp-is-a-file");
    std::fs::write(&temp_root, b"").unwrap();
    let app = mock_app();

    let (dir, warnings) = resolve(&app, installed(&blocked, &temp_root));

    // Documented branch: keep the preferred path best-effort and warn.
    assert_eq!(dir, blocked);
    assert_eq!(file_names(&warnings), vec!["config directory"]);
    assert!(warnings[0].message.contains("best-effort"));
}

#[test]
fn an_unwritable_portable_data_dir_falls_back_to_temp_storage_with_a_warning() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    std::fs::write(&data_dir, b"").unwrap();
    let temp_root = tmp.path().join("temp");
    let app = mock_app();

    let (dir, warnings) = resolve(
        &app,
        ConfigDirInputs {
            external_override: None,
            app_mode: AppMode::Portable {
                data_dir: data_dir.clone(),
            },
            temp_root: temp_root.clone(),
        },
    );

    assert_eq!(dir, temp_root.join("termihub-portable-data"));
    assert_eq!(file_names(&warnings), vec!["portable data directory"]);
    assert!(app.state::<AppMode>().is_portable());
}

#[test]
fn the_external_override_wins_over_portable_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let wanted = tmp.path().join("override");
    let data_dir = tmp.path().join("data");
    let app = mock_app();

    let (dir, warnings) = resolve(
        &app,
        ConfigDirInputs {
            external_override: Some(wanted.clone()),
            app_mode: AppMode::Portable {
                data_dir: data_dir.clone(),
            },
            temp_root: tmp.path().join("temp"),
        },
    );

    assert_eq!(dir, wanted);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(!data_dir.exists(), "portable data dir must not be created");
}

// ── Credentials + connections phase ─────────────────────────────────────────

/// What the injected app-handle wiring was called with.
type AttachCalls = Arc<Mutex<Vec<Option<u32>>>>;

/// Run the config-dir phase, then the credentials phase, on a mock app rooted
/// at `config_dir` (already seeded by the test).
fn boot_credentials(config_dir: &Path) -> (MockApp, Vec<RecoveryWarning>, AttachCalls) {
    boot_credentials_on(mock_app(), config_dir)
}

fn boot_credentials_on(
    app: MockApp,
    config_dir: &Path,
) -> (MockApp, Vec<RecoveryWarning>, AttachCalls) {
    let (dir, mut warnings) = resolve(&app, installed(config_dir, &config_dir.join("temp")));
    assert!(warnings.is_empty(), "{warnings:?}");
    let calls: AttachCalls = Arc::default();
    let sink = calls.clone();
    init_credentials_and_connections_with(&app, dir, &mut warnings, move |_, minutes| {
        sink.lock().unwrap().push(minutes);
    });
    (app, warnings, calls)
}

fn assert_booted(app: &MockApp, calls: &AttachCalls) {
    assert!(app.try_state::<ConnectionManager>().is_some());
    assert!(app.try_state::<Arc<CredentialManager>>().is_some());
    assert_eq!(*calls.lock().unwrap(), vec![Some(15)]);
}

#[test]
fn a_clean_data_dir_boots_without_warnings() {
    let tmp = tempfile::tempdir().unwrap();

    let (app, warnings, calls) = boot_credentials(tmp.path());

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_booted(&app, &calls);
}

#[test]
fn a_corrupt_connections_file_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("connections.json"), "{ not json").unwrap();

    let (app, warnings, calls) = boot_credentials(tmp.path());

    assert!(
        file_names(&warnings).contains(&"connections.json"),
        "{warnings:?}"
    );
    assert_booted(&app, &calls);
    // The corrupt original is kept as a backup, never silently dropped.
    assert!(tmp.path().join("connections.json.bak").exists());
}

#[test]
fn a_connections_file_from_a_newer_version_is_left_intact_with_a_warning() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("connections.json");
    let newer = r#"{"version":"9999","children":[],"agents":[]}"#;
    std::fs::write(&path, newer).unwrap();

    let (app, warnings, calls) = boot_credentials(tmp.path());

    let w = warnings
        .iter()
        .find(|w| w.file_name == "connections.json")
        .expect("a newer-schema warning");
    assert!(w.message.contains("newer version"), "{}", w.message);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
    assert_booted(&app, &calls);
}

#[test]
fn a_corrupt_settings_file_adds_a_warning_and_falls_back_to_defaults() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("settings.json"), "[[[").unwrap();

    let (app, warnings, calls) = boot_credentials(tmp.path());

    assert!(
        file_names(&warnings).contains(&"settings.json"),
        "{warnings:?}"
    );
    assert_booted(&app, &calls);
    // Defaults mean the no-persistence credential store.
    let cm = app.state::<Arc<CredentialManager>>();
    assert!(cm.with_master_password_store(|_| ()).is_none());
}

#[test]
fn a_locked_master_password_store_skips_without_a_panic() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("settings.json"),
        r#"{"credentialStorageMode":"master_password"}"#,
    )
    .unwrap();
    MasterPasswordStore::new(tmp.path().join("credentials.enc"))
        .setup("pw")
        .unwrap();
    let app = mock_app();
    let locked: Arc<Mutex<bool>> = Arc::default();
    let seen = locked.clone();
    app.listen_any("credential-store-locked", move |_| {
        *seen.lock().unwrap() = true;
    });

    let (app, warnings, calls) = boot_credentials_on(app, tmp.path());

    // The UI is told the store is locked, shortly after setup.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !*locked.lock().unwrap() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(*locked.lock().unwrap(), "no credential-store-locked event");
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_booted(&app, &calls);
    let cm = app.state::<Arc<CredentialManager>>();
    assert_eq!(
        cm.with_master_password_store(|s| s.is_unlocked()),
        Some(false)
    );
}
