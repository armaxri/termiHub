//! Tests for the portable data-dir lock (#3100): acquire, contention, release
//! on drop, per-directory scoping, and release when the holder crashes.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use super::*;
use crate::utils::portable::AppMode;

#[test]
fn acquire_creates_the_lock_file_inside_the_data_dir() {
    let dir = tempfile::tempdir().unwrap();

    let lock = acquire(dir.path()).expect("first acquire succeeds");

    assert_eq!(lock.path(), dir.path().join(LOCK_FILE_NAME));
    assert!(dir.path().join(LOCK_FILE_NAME).is_file());
}

#[test]
fn second_acquire_on_the_same_dir_reports_held() {
    let dir = tempfile::tempdir().unwrap();
    let _first = acquire(dir.path()).expect("first acquire succeeds");

    match acquire(dir.path()) {
        Err(DataDirLockError::Held { data_dir }) => assert_eq!(data_dir, dir.path()),
        Err(other) => panic!("expected Held, got {other}"),
        Ok(_) => panic!("a second holder must not acquire the same data dir"),
    }
}

#[test]
fn dropping_the_lock_releases_it() {
    let dir = tempfile::tempdir().unwrap();
    let first = acquire(dir.path()).expect("first acquire succeeds");
    drop(first);

    acquire(dir.path()).expect("re-acquire after release succeeds");
}

#[test]
fn different_data_dirs_do_not_contend() {
    // Two portable copies in different folders must both run.
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();

    let _la = acquire(a.path()).expect("dir a");
    let _lb = acquire(b.path()).expect("dir b");
}

#[test]
fn a_stale_lock_file_left_on_disk_does_not_block() {
    // A crashed run leaves the file behind; only a live OS lock blocks, never
    // the file's mere existence.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(LOCK_FILE_NAME), b"12345\n").unwrap();

    acquire(dir.path()).expect("a leftover lock file is not a held lock");
}

#[test]
fn missing_data_dir_is_an_io_error_not_held() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");

    match acquire(&missing) {
        Err(DataDirLockError::Io { .. }) => {}
        Err(other) => panic!("expected Io, got {other}"),
        Ok(_) => panic!("cannot lock inside a missing directory"),
    }
}

#[test]
fn lock_target_is_the_portable_data_dir() {
    let mode = AppMode::Portable {
        data_dir: PathBuf::from("/usb/termiHub/data"),
    };
    assert_eq!(
        lock_target(&mode, /* config_dir_env_override */ false),
        Some(PathBuf::from("/usb/termiHub/data").as_path())
    );
}

#[test]
fn installed_mode_takes_no_data_dir_lock() {
    // Installed release builds are covered by the single-instance plugin.
    assert_eq!(lock_target(&AppMode::Installed, false), None);
}

#[test]
fn explicit_config_dir_override_takes_no_data_dir_lock() {
    // TERMIHUB_CONFIG_DIR wins over portable mode, so the data dir is unused.
    let mode = AppMode::Portable {
        data_dir: PathBuf::from("/usb/termiHub/data"),
    };
    assert_eq!(lock_target(&mode, true), None);
}

#[test]
fn held_message_names_the_folder() {
    let msg = held_message(Path::new("/usb/termiHub/data"));
    assert!(msg.contains("/usb/termiHub/data"), "{msg}");
    assert!(msg.contains("already running"), "{msg}");
}

// ---- crash release, via a real child process ---------------------------------

/// Env var carrying the data dir the helper child should lock.
const CHILD_DIR_ENV: &str = "TERMIHUB_TEST_DATA_DIR_LOCK_CHILD";
/// Line the child prints once it holds the lock.
const CHILD_READY: &str = "DATA_DIR_LOCK_HELD";

/// Helper run *as a child process* by [`lock_is_released_when_the_holder_crashes`]:
/// it acquires the lock, announces it, then blocks until killed. Ignored in
/// normal runs; without the env var it is a no-op.
#[test]
#[ignore = "helper spawned as a child process by the crash-release test"]
fn lock_holder_child_process() {
    let Some(dir) = std::env::var_os(CHILD_DIR_ENV) else {
        return;
    };
    let _lock = acquire(Path::new(&dir)).expect("child acquires the lock");
    println!("{CHILD_READY}");
    loop {
        std::thread::park();
    }
}

#[test]
fn lock_is_released_when_the_holder_crashes() {
    let dir = tempfile::tempdir().unwrap();
    let exe = std::env::current_exe().unwrap();

    let mut child = Command::new(exe)
        .args([
            "--exact",
            "utils::data_dir_lock::tests::lock_holder_child_process",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DIR_ENV, dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lock-holder child");

    // Wait until the child reports it holds the lock.
    let stdout = child.stdout.take().unwrap();
    let mut held = false;
    for line in BufReader::new(stdout).lines() {
        if line.unwrap().contains(CHILD_READY) {
            held = true;
            break;
        }
    }
    assert!(held, "child never reported holding the lock");

    // While the child lives, this process cannot take the same data dir.
    assert!(
        matches!(acquire(dir.path()), Err(DataDirLockError::Held { .. })),
        "a live holder in another process must block the lock"
    );

    // Crash it (SIGKILL / TerminateProcess — no destructors run) and reap it.
    child.kill().unwrap();
    child.wait().unwrap();

    // The OS released the lock with the dead process. Windows documents the
    // release after termination as prompt but not synchronous, so poll briefly.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match acquire(dir.path()) {
            Ok(_) => break,
            Err(DataDirLockError::Held { .. }) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => panic!("lock not released after the holder crashed: {e}"),
        }
    }
}
