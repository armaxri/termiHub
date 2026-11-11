#![cfg(feature = "ssh")]
//! Error paths of the SFTP attribute and copy operations (#5320), against the
//! `ssh-keys` Docker fixture.
//!
//! chmod, chown, symlink and copy are destructive remote operations. A refused
//! one must come back as a typed [`FileError`], never as a silent success, so
//! the file browser can tell the user what went wrong. Each test drives the
//! core [`SftpFileBrowser`] (the browser a session's SSH connection serves its
//! file ops through) as the unprivileged `testuser`:
//!
//! - chmod and chown on a root-owned file are [`FileError::PermissionDenied`];
//! - a symlink into a directory the user cannot write is
//!   [`FileError::PermissionDenied`] and leaves no link behind;
//! - copying a file onto itself is refused and leaves its contents intact
//!   (a naive stream-copy truncates the destination, which is the source).
//!
//! The root-owned file is the image's own `/etc/passwd`; the read-only folder
//! is a scratch folder whose write bits the test clears. The chmod/chown calls
//! ask for the file's current mode and owner, so even an unexpected success
//! could not change the fixture.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d ssh-keys`.
//! Skips when it is not running; fails under `TERMIHUB_REQUIRE_DOCKER=1`.

mod common;

use std::time::{SystemTime, UNIX_EPOCH};

use common::{port_ssh_keys, require_docker, ssh_key_config};
use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::errors::FileError;
use termihub_core::files::FileBrowser;

/// A file the fixture image ships owned by root (mode 0644).
const ROOT_OWNED_FILE: &str = "/etc/passwd";
/// The mode `/etc/passwd` already has, so a chmod that wrongly succeeded
/// would leave it unchanged.
const ROOT_OWNED_FILE_MODE: u32 = 0o644;

/// A key-authenticated browser on the `ssh-keys` fixture, as `testuser`.
fn browser() -> SftpFileBrowser {
    SftpFileBrowser::new(ssh_key_config(port_ssh_keys(), "ed25519"))
}

/// A fresh scratch folder in `testuser`'s home, unique per test run.
async fn scratch_dir(browser: &SftpFileBrowser, tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let dir = format!(
        "/home/testuser/termihub-5320-{tag}-{}-{nanos}",
        std::process::id()
    );
    browser.mkdir(&dir).await.expect("create the scratch folder");
    dir
}

/// Best-effort removal of a scratch folder and everything in it.
async fn remove_tree(browser: &SftpFileBrowser, dir: &str) {
    // Give back the write bit a test may have cleared, so the entries can go.
    let _ = browser.set_permissions(dir, 0o755).await;
    if let Ok(entries) = browser.list_dir(dir).await {
        for entry in entries {
            if entry.is_directory && !entry.is_symlink {
                Box::pin(remove_tree(browser, &entry.path)).await;
            } else {
                let _ = browser.delete(&entry.path).await;
            }
        }
    }
    let _ = browser.delete(dir).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chmod_on_a_root_owned_file_is_permission_denied() {
    require_docker!(port_ssh_keys());
    let browser = browser();

    let err = browser
        .set_permissions(ROOT_OWNED_FILE, ROOT_OWNED_FILE_MODE)
        .await
        .expect_err("a non-root chmod of a root-owned file must fail");
    assert!(
        matches!(&err, FileError::PermissionDenied(msg) if msg.contains(ROOT_OWNED_FILE)),
        "chmod of a root-owned file must be PermissionDenied naming the file, got {err:?}"
    );

    // Control: the same call on a file the user owns succeeds, so the denial
    // above is the server's answer, not a broken session.
    let dir = scratch_dir(&browser, "chmod").await;
    let own = format!("{dir}/own.txt");
    browser.write_file(&own, b"x").await.expect("write own file");
    browser
        .set_permissions(&own, 0o600)
        .await
        .expect("chmod of an owned file succeeds");
    remove_tree(&browser, &dir).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chown_on_a_root_owned_file_is_permission_denied() {
    require_docker!(port_ssh_keys());
    let browser = browser();

    // root:root is the current owner, so a wrong success changes nothing.
    let err = browser
        .set_owner(ROOT_OWNED_FILE, Some(0), Some(0))
        .await
        .expect_err("a non-root chown of a root-owned file must fail");
    assert!(
        matches!(&err, FileError::PermissionDenied(msg) if msg.contains(ROOT_OWNED_FILE)),
        "chown of a root-owned file must be PermissionDenied naming the file, got {err:?}"
    );

    // Leaving both sides unchanged takes the stat-then-setstat path too.
    let err = browser
        .set_owner(ROOT_OWNED_FILE, None, None)
        .await
        .expect_err("a non-root chown of a root-owned file must fail");
    assert!(
        matches!(err, FileError::PermissionDenied(_)),
        "chown with unchanged ids must still be PermissionDenied, got {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chmod_and_chown_on_a_missing_file_are_not_found() {
    require_docker!(port_ssh_keys());
    let browser = browser();
    let missing = "/home/testuser/termihub-5320-does-not-exist";

    let err = browser
        .set_permissions(missing, 0o644)
        .await
        .expect_err("chmod of a missing file must fail");
    assert!(
        matches!(&err, FileError::NotFound(p) if p == missing),
        "chmod of a missing file must be NotFound, got {err:?}"
    );
    let err = browser
        .set_owner(missing, None, None)
        .await
        .expect_err("chown of a missing file must fail");
    assert!(
        matches!(&err, FileError::NotFound(p) if p == missing),
        "chown of a missing file must be NotFound, got {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlink_into_a_read_only_folder_is_permission_denied() {
    require_docker!(port_ssh_keys());
    let browser = browser();
    let dir = scratch_dir(&browser, "symlink").await;
    let target = format!("{dir}/target.txt");
    browser
        .write_file(&target, b"target")
        .await
        .expect("write the link target");
    let locked = format!("{dir}/locked");
    browser.mkdir(&locked).await.expect("create the locked folder");
    browser
        .set_permissions(&locked, 0o555)
        .await
        .expect("make the folder read-only");

    let link = format!("{locked}/link");
    let result = browser.create_symlink(&target, &link).await;
    // Check the folder before cleanup can hide a link that was made.
    let left_behind = browser.stat(&link).await;
    remove_tree(&browser, &dir).await;

    let err = result.expect_err("a symlink into a read-only folder must fail");
    assert!(
        matches!(&err, FileError::PermissionDenied(msg) if msg.contains(&link)),
        "symlink into a read-only folder must be PermissionDenied naming the link, got {err:?}"
    );
    assert!(
        matches!(left_behind, Err(FileError::NotFound(_))),
        "a refused symlink must leave no link behind, got {left_behind:?}"
    );

    // The image's own root-owned /etc is read-only to testuser as well.
    let err = browser
        .create_symlink(ROOT_OWNED_FILE, "/etc/termihub-5320-link")
        .await
        .expect_err("a symlink into /etc must fail for testuser");
    assert!(
        matches!(err, FileError::PermissionDenied(_)),
        "symlink into root-owned /etc must be PermissionDenied, got {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_a_file_onto_itself_is_refused_and_keeps_its_contents() {
    require_docker!(port_ssh_keys());
    let browser = browser();
    let dir = scratch_dir(&browser, "copy").await;
    let file = format!("{dir}/data.txt");
    browser
        .write_file(&file, b"precious bytes")
        .await
        .expect("write the source file");

    let same = browser.copy(&file, &file).await;
    // The same file spelled differently must be caught as well.
    let respelled = browser
        .copy(&file, &format!("{dir}/./data.txt"))
        .await;
    let contents = browser.read_file(&file).await;
    remove_tree(&browser, &dir).await;

    for (what, result) in [("same path", same), ("respelled path", respelled)] {
        let err = result.expect_err(&format!("copy onto itself ({what}) must fail"));
        assert!(
            matches!(&err, FileError::OperationFailed(msg) if msg.contains("same file")),
            "copy onto itself ({what}) must be OperationFailed saying so, got {err:?}"
        );
    }
    assert_eq!(
        contents.expect("read the source back"),
        b"precious bytes",
        "a refused self-copy must not truncate the file"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_a_folder_into_itself_is_refused() {
    require_docker!(port_ssh_keys());
    let browser = browser();
    let dir = scratch_dir(&browser, "copydir").await;
    let src = format!("{dir}/src");
    browser.mkdir(&src).await.expect("create the source folder");
    browser
        .write_file(&format!("{src}/a.txt"), b"a")
        .await
        .expect("write a file in the source folder");

    let result = browser.copy(&src, &format!("{src}/nested")).await;
    let nested = browser.stat(&format!("{src}/nested")).await;
    remove_tree(&browser, &dir).await;

    let err = result.expect_err("copying a folder into itself must fail");
    assert!(
        matches!(&err, FileError::OperationFailed(msg) if msg.contains("inside")),
        "copying a folder into itself must be OperationFailed saying so, got {err:?}"
    );
    assert!(
        matches!(nested, Err(FileError::NotFound(_))),
        "a refused folder copy must create nothing, got {nested:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlink_in_a_writable_folder_points_at_its_target() {
    require_docker!(port_ssh_keys());
    let browser = browser();
    let dir = scratch_dir(&browser, "symlink-ok").await;
    let target = format!("{dir}/target.txt");
    browser
        .write_file(&target, b"target")
        .await
        .expect("write the link target");
    let link = format!("{dir}/link");

    let result = browser.create_symlink(&target, &link).await;
    let listing = browser.list_dir(&dir).await;
    remove_tree(&browser, &dir).await;

    result.expect("a symlink in a writable folder succeeds");
    let listing = listing.expect("list the scratch folder");
    let made = listing
        .iter()
        .find(|e| e.name == "link")
        .unwrap_or_else(|| panic!("the link must be created at its own path: {listing:?}"));
    assert!(made.is_symlink, "the new entry must be a symlink: {made:?}");
    assert_eq!(
        made.symlink_target.as_deref(),
        Some(target.as_str()),
        "the link must point at the target"
    );
}
