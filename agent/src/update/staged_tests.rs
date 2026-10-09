//! Tests for handle-bound, private update staging (#4287, AGT2-002).

use super::*;

use std::os::unix::fs::PermissionsExt;

fn mode_of(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .unwrap()
        .permissions()
        .mode()
        & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A private staging root (0700) holding one private (0600) staged binary.
fn private_staging(dir: &Path, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let root = dir.join("updates");
    std::fs::create_dir_all(&root).unwrap();
    set_mode(&root, 0o700);
    let bin = root.join("termihub-agent");
    std::fs::write(&bin, bytes).unwrap();
    set_mode(&bin, 0o600);
    (root, bin)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn read_all(file: &std::fs::File) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let mut handle = file;
    handle.seek(SeekFrom::Start(0)).unwrap();
    let mut out = Vec::new();
    handle.read_to_end(&mut out).unwrap();
    out
}

// ── The staging dir is private ────────────────────────────────────────────

#[test]
fn ensure_private_dir_creates_an_owner_only_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("termihub-agent").join("updates");

    ensure_private_dir(&dir).unwrap();

    assert!(dir.is_dir());
    assert_eq!(mode_of(&dir), 0o700, "the staging dir must be 0700");
}

#[test]
fn ensure_private_dir_tightens_an_existing_open_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("updates");
    std::fs::create_dir(&dir).unwrap();
    set_mode(&dir, 0o777);

    ensure_private_dir(&dir).unwrap();

    assert_eq!(mode_of(&dir), 0o700, "an existing open dir must be tightened");
}

#[test]
fn ensure_private_dir_refuses_a_symlinked_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("elsewhere");
    std::fs::create_dir(&real).unwrap();
    let link = tmp.path().join("updates");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    assert!(
        ensure_private_dir(&link).is_err(),
        "a symlink must never be adopted as the staging dir"
    );
}

// ── Opening the staged binary once, privately ─────────────────────────────

#[test]
fn open_accepts_a_privately_staged_file() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"AGENT");

    let file = open_private_staged(&root, &bin).expect("a private staged file must open");
    assert_eq!(read_all(&file), b"AGENT");
}

#[test]
fn open_accepts_a_file_in_a_private_upload_subdir() {
    // The desktop uploads into `<root>/upload.XXXXXX/termihub-agent`.
    let tmp = tempfile::tempdir().unwrap();
    let (root, _) = private_staging(tmp.path(), b"UNUSED");
    let upload = root.join("upload.abc123");
    std::fs::create_dir(&upload).unwrap();
    set_mode(&upload, 0o700);
    let bin = upload.join("termihub-agent");
    std::fs::write(&bin, b"AGENT").unwrap();
    set_mode(&bin, 0o600);

    open_private_staged(&root, &bin).expect("a private upload subdir must be accepted");
}

#[test]
fn open_refuses_a_symlink_leaf() {
    // O_NOFOLLOW: even a symlink pointing at a file inside the root is refused.
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"AGENT");
    let link = root.join("link");
    std::os::unix::fs::symlink(&bin, &link).unwrap();

    assert!(open_private_staged(&root, &link).is_err());
}

#[test]
fn open_refuses_a_hard_linked_file() {
    // A second link means another name can change what we install.
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"AGENT");
    std::fs::hard_link(&bin, tmp.path().join("other-name")).unwrap();

    let err = open_private_staged(&root, &bin).expect_err("a hard-linked file must be refused");
    assert!(format!("{err:#}").contains("link"), "got: {err:#}");
}

#[test]
fn open_refuses_a_group_or_world_writable_file() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"AGENT");
    for mode in [0o620, 0o602, 0o666] {
        set_mode(&bin, mode);
        assert!(
            open_private_staged(&root, &bin).is_err(),
            "mode {mode:o} must be refused"
        );
    }
}

#[test]
fn open_refuses_a_file_under_a_world_writable_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"AGENT");
    set_mode(&root, 0o777);

    let err = open_private_staged(&root, &bin).expect_err("an open staging dir must be refused");
    assert!(format!("{err:#}").contains("writable"), "got: {err:#}");
}

#[test]
fn open_refuses_a_world_writable_upload_subdir() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, _) = private_staging(tmp.path(), b"UNUSED");
    let upload = root.join("upload.shared");
    std::fs::create_dir(&upload).unwrap();
    set_mode(&upload, 0o777);
    let bin = upload.join("termihub-agent");
    std::fs::write(&bin, b"AGENT").unwrap();
    set_mode(&bin, 0o600);

    assert!(open_private_staged(&root, &bin).is_err());
}

// ── Copy + hash from the one handle ───────────────────────────────────────

#[test]
fn copy_into_private_temp_copies_and_hashes_the_handle_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"VERIFIED-AGENT-BYTES");
    let dest = tmp.path().join("bin");
    std::fs::create_dir(&dest).unwrap();

    let mut file = open_private_staged(&root, &bin).unwrap();
    let (copy, digest) = copy_into_private_temp(&mut file, &dest).unwrap();

    assert_eq!(digest, sha256_hex(b"VERIFIED-AGENT-BYTES"));
    assert_eq!(read_all(copy.as_file()), b"VERIFIED-AGENT-BYTES");
    assert_eq!(copy.path().parent().unwrap(), dest);
    assert_eq!(mode_of(copy.path()) & 0o077, 0, "the copy must be owner-only");
}

#[test]
fn copy_reads_the_opened_file_even_if_the_path_is_swapped() {
    // The bytes copied are the bytes of the inode we opened: renaming another
    // file over the path afterwards cannot change them.
    let tmp = tempfile::tempdir().unwrap();
    let (root, bin) = private_staging(tmp.path(), b"GOOD-BYTES");
    let mut file = open_private_staged(&root, &bin).unwrap();

    let evil = root.join("evil");
    std::fs::write(&evil, b"EVIL-BYTES").unwrap();
    std::fs::rename(&evil, &bin).unwrap();

    let (copy, digest) = copy_into_private_temp(&mut file, tmp.path()).unwrap();
    assert_eq!(read_all(copy.as_file()), b"GOOD-BYTES");
    assert_eq!(digest, sha256_hex(b"GOOD-BYTES"));
}

// ── Removing the staged upload after a successful apply ───────────────────

#[test]
fn discard_applied_upload_removes_the_file_and_its_upload_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, _) = private_staging(tmp.path(), b"UNUSED");
    let upload = root.join("upload.abc123");
    std::fs::create_dir(&upload).unwrap();
    let bin = upload.join("termihub-agent");
    std::fs::write(&bin, b"AGENT").unwrap();

    discard_applied_upload(std::slice::from_ref(&root), &bin);

    assert!(!bin.exists(), "the applied upload must be removed");
    assert!(!upload.exists(), "its now-empty upload dir must be removed");
    assert!(root.is_dir(), "the staging root itself stays");
}

#[test]
fn discard_applied_upload_keeps_a_non_empty_upload_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, _) = private_staging(tmp.path(), b"UNUSED");
    let upload = root.join("upload.abc123");
    std::fs::create_dir(&upload).unwrap();
    let bin = upload.join("termihub-agent");
    std::fs::write(&bin, b"AGENT").unwrap();
    let other = upload.join("something-else");
    std::fs::write(&other, b"KEEP").unwrap();

    discard_applied_upload(std::slice::from_ref(&root), &bin);

    assert!(!bin.exists());
    assert!(other.exists(), "an unrelated file must be kept");
}

#[test]
fn discard_applied_upload_never_touches_a_path_outside_the_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, _) = private_staging(tmp.path(), b"UNUSED");
    let outside = tmp.path().join("not-staged");
    std::fs::write(&outside, b"KEEP").unwrap();

    discard_applied_upload(&[root], &outside);

    assert!(outside.exists(), "a path outside the staging roots must be kept");
}
