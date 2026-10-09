//! Windows tests for the update staging dir's protected DACL (#4494).

use super::ensure_private_dir;
use termihub_win_security::{
    current_user_sid_string, dacl_of_path, LOCAL_SYSTEM_SID, OBJECT_AND_CONTAINER_INHERIT,
};

/// Assert `dir` carries a protected DACL granting exactly the current user and
/// `LocalSystem` full control, each ACE inheritable to files and subdirs.
fn assert_staging_dacl(dir: &std::path::Path) {
    let user = current_user_sid_string().unwrap();
    let dacl = dacl_of_path(dir).unwrap();
    assert!(dacl.present, "staging dir must carry a DACL: {dacl:?}");
    assert!(
        dacl.protected,
        "staging dir DACL must be protected: {dacl:?}"
    );
    assert!(
        dacl.grants_full_control_to_exactly(&[&user, LOCAL_SYSTEM_SID]),
        "staging dir must grant only the current user and SYSTEM: {dacl:?}"
    );
    assert_eq!(dacl.aces.len(), 2, "one ACE per principal: {dacl:?}");
    for ace in &dacl.aces {
        assert_eq!(
            ace.flags & OBJECT_AND_CONTAINER_INHERIT,
            OBJECT_AND_CONTAINER_INHERIT,
            "every ACE must be inherited by files and subdirs: {dacl:?}"
        );
    }
}

#[test]
fn ensure_private_dir_applies_a_protected_current_user_dacl() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("config").join("updates");

    ensure_private_dir(&dir).unwrap();

    assert!(dir.is_dir());
    assert_staging_dacl(&dir);
}

#[test]
fn ensure_private_dir_tightens_an_existing_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("updates");
    std::fs::create_dir(&dir).unwrap();
    // Before: the dir inherits the temp dir's ACL, not the protected one.
    assert!(!dacl_of_path(&dir).unwrap().protected);

    ensure_private_dir(&dir).unwrap();
    // Idempotent: a second call leaves the same DACL.
    ensure_private_dir(&dir).unwrap();

    assert_staging_dacl(&dir);
}

#[test]
fn upload_subdirs_inherit_the_staging_dacl() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("updates");
    ensure_private_dir(&dir).unwrap();

    let upload = dir.join("upload.abc123");
    std::fs::create_dir(&upload).unwrap();
    let file = upload.join("termihub-agent.exe");
    std::fs::write(&file, b"bytes").unwrap();

    let user = current_user_sid_string().unwrap();
    let mut expected = vec![user.as_str(), LOCAL_SYSTEM_SID];
    expected.sort_unstable();
    for path in [&upload, &file] {
        // Inherited, so not protected itself: check the grants directly.
        let dacl = dacl_of_path(path).unwrap();
        assert!(dacl.present, "{} must carry a DACL", path.display());
        assert!(
            dacl.aces.iter().all(|ace| ace.allows_full_control()),
            "{} must hold only full-control grants: {dacl:?}",
            path.display()
        );
        let mut granted: Vec<&str> = dacl.aces.iter().filter_map(|a| a.sid.as_deref()).collect();
        granted.sort_unstable();
        assert_eq!(
            granted,
            expected,
            "{} must inherit only the staging grants: {dacl:?}",
            path.display()
        );
    }
}
