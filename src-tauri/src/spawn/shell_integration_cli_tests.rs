//! Tests for the shell-integration CLI's portable data-dir lock (#5245).

use std::cell::Cell;
use std::path::Path;

use super::*;
use crate::utils::data_dir_lock::{acquire, LOCK_FILE_NAME};

fn portable(data_dir: &Path) -> AppMode {
    AppMode::Portable {
        data_dir: data_dir.to_path_buf(),
    }
}

fn storage_in(data_dir: &Path) -> anyhow::Result<SettingsStorage> {
    Ok(SettingsStorage::new_for_test(
        data_dir.join("settings.json"),
    ))
}

/// Mark the settings as registered, as a successful `register` would.
fn fake_register(settings: &mut ShellIntegrationSettings) -> anyhow::Result<()> {
    settings.registered = true;
    settings.registered_exe_path = Some("/fake/termihub".to_string());
    Ok(())
}

#[test]
fn lock_free_portable_command_applies_and_saves() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path();

    apply_with_lock(
        &portable(data_dir),
        false,
        || storage_in(data_dir),
        fake_register,
    )
    .expect("the command proceeds when no instance holds the lock");

    let saved = storage_in(data_dir)
        .unwrap()
        .load_with_recovery()
        .unwrap()
        .data;
    assert!(saved.shell_integration.registered);
    assert_eq!(
        saved.shell_integration.registered_exe_path.as_deref(),
        Some("/fake/termihub")
    );
    // The lock was taken (its file exists) and released once the command ended.
    assert!(data_dir.join(LOCK_FILE_NAME).is_file());
    acquire(data_dir).expect("the command releases the lock when it finishes");
}

#[test]
fn held_lock_refuses_and_leaves_settings_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path();
    let settings_path = data_dir.join("settings.json");
    let original = br#"{"version":"1","shellIntegration":{"registered":false}}"#;
    std::fs::write(&settings_path, original).unwrap();
    let _instance_a = acquire(data_dir).expect("instance A holds the data dir");

    let opened = Cell::new(false);
    let applied = Cell::new(false);
    let result = apply_with_lock(
        &portable(data_dir),
        false,
        || {
            opened.set(true);
            storage_in(data_dir)
        },
        |settings| {
            applied.set(true);
            fake_register(settings)
        },
    );

    match result {
        Err(ShellIntegrationCliError::Refused(message)) => {
            assert!(message.contains("termiHub is running from this folder"));
            assert!(message.contains("Settings"));
            assert!(message.contains(&data_dir.display().to_string()));
        }
        other => panic!("expected Refused, got {other:?}"),
    }
    assert!(!opened.get(), "storage must not be opened on a held lock");
    assert!(
        !applied.get(),
        "the OS registration must not run on a held lock"
    );
    assert_eq!(std::fs::read(&settings_path).unwrap(), original);
}

#[test]
fn installed_mode_takes_no_lock() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path();

    apply_with_lock(
        &AppMode::Installed,
        false,
        || storage_in(data_dir),
        fake_register,
    )
    .expect("installed mode proceeds");

    assert!(!data_dir.join(LOCK_FILE_NAME).exists());
    assert!(data_dir.join("settings.json").is_file());
}

#[test]
fn config_dir_override_takes_no_lock_even_when_portable_dir_is_held() {
    // An explicit `TERMIHUB_CONFIG_DIR` means the portable `data/` is not the
    // write target, so its lock is irrelevant (matches the GUI launch).
    let portable_dir = tempfile::tempdir().unwrap();
    let config_dir = tempfile::tempdir().unwrap();
    let _instance_a = acquire(portable_dir.path()).unwrap();

    apply_with_lock(
        &portable(portable_dir.path()),
        true,
        || storage_in(config_dir.path()),
        fake_register,
    )
    .expect("the override path proceeds");

    assert!(config_dir.path().join("settings.json").is_file());
}

#[test]
fn apply_failure_is_reported_and_nothing_is_saved() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path();

    let result = apply_with_lock(
        &portable(data_dir),
        false,
        || storage_in(data_dir),
        |_| Err(anyhow::anyhow!("unsupported")),
    );

    assert!(matches!(result, Err(ShellIntegrationCliError::Failed(_))));
    assert!(!data_dir.join("settings.json").exists());
}
