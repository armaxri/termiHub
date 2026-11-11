//! A local copy of a file onto itself, or of a folder into itself, is refused
//! before anything is created or truncated (#5325).
//!
//! `std::fs::copy` opens its destination for writing with truncation, so a
//! copy onto the source itself can empty it. A folder copied into itself would
//! recurse into its own output. Each case is checked by the same path and by a
//! respelled one (`dir/./f`, `..`, a symlink, a hard link).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::*;
use crate::files::FileBrowser;

const PRECIOUS: &[u8] = b"precious bytes that must survive";

/// Every entry under `root` with its contents (files) or `None` (folders and
/// links), so a refused copy can be shown to have created nothing.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                stack.push(path.clone());
                out.insert(path, None);
            } else if kind.is_symlink() {
                out.insert(path, None);
            } else {
                out.insert(path.clone(), Some(std::fs::read(&path).unwrap()));
            }
        }
    }
    out
}

fn s(path: &Path) -> &str {
    path.to_str().unwrap()
}

/// Assert `err` is the refusal, worded like the SFTP guard (#5320).
fn assert_refused(err: &FileError, reason: &str) {
    match err {
        FileError::OperationFailed(msg) => {
            assert!(msg.starts_with("copy "), "{msg}");
            assert!(msg.ends_with(&format!("refused: {reason}")), "{msg}");
        }
        other => panic!("expected the copy refusal, got {other:?}"),
    }
}

const SAME: &str = "source and destination are the same file";
const INSIDE: &str = "the destination is inside the source folder";

/// One folder holding `f` with [`PRECIOUS`] and an empty `sub/`.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f");
    std::fs::write(&file, PRECIOUS).unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    (dir, file)
}

fn respellings_of_f(dir: &Path) -> Vec<PathBuf> {
    vec![
        dir.join("f"),
        dir.join(".").join("f"),
        dir.join("sub").join("..").join("f"),
    ]
}

#[tokio::test]
async fn a_file_copied_onto_itself_is_refused_and_keeps_its_bytes() {
    let (dir, file) = fixture();
    let before = snapshot(dir.path());
    for dest in respellings_of_f(dir.path()) {
        let err = LocalFileBrowser::new()
            .copy(s(&file), s(&dest))
            .await
            .expect_err(s(&dest));
        assert_refused(&err, SAME);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            PRECIOUS,
            "{}",
            dest.display()
        );

        let err = copy_sync(s(&file), s(&dest), false).expect_err(s(&dest));
        assert!(err.to_string().ends_with(SAME), "{err}");
        assert_eq!(
            std::fs::read(&file).unwrap(),
            PRECIOUS,
            "{}",
            dest.display()
        );
    }
    assert_eq!(snapshot(dir.path()), before);
}

#[cfg(unix)]
#[tokio::test]
async fn a_file_copied_onto_a_symlink_or_hard_link_to_itself_is_refused() {
    let (dir, file) = fixture();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&file, &link).unwrap();
    let hard = dir.path().join("hard");
    std::fs::hard_link(&file, &hard).unwrap();
    let before = snapshot(dir.path());

    for (src, dest) in [
        (&file, &link),
        (&link, &file),
        (&file, &hard),
        (&hard, &file),
    ] {
        let err = LocalFileBrowser::new()
            .copy(s(src), s(dest))
            .await
            .expect_err(s(dest));
        assert_refused(&err, SAME);
        assert!(
            copy_sync(s(src), s(dest), false).is_err(),
            "{}",
            dest.display()
        );
        assert_eq!(std::fs::read(&file).unwrap(), PRECIOUS);
    }
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(snapshot(dir.path()), before);
}

#[tokio::test]
async fn a_folder_copied_onto_itself_is_refused_and_creates_nothing() {
    let (dir, _file) = fixture();
    let src = dir.path().to_path_buf();
    let before = snapshot(&src);
    for dest in [src.clone(), src.join("."), src.join("sub").join("..")] {
        let err = LocalFileBrowser::new()
            .copy(s(&src), s(&dest))
            .await
            .expect_err(s(&dest));
        assert_refused(&err, SAME);
        assert!(copy_sync(s(&src), s(&dest), true).is_err());
        assert_eq!(snapshot(&src), before, "{}", dest.display());
    }
}

#[tokio::test]
async fn a_folder_copied_into_a_descendant_is_refused_and_creates_nothing() {
    let outer = tempfile::tempdir().unwrap();
    let src = outer.path().join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("f"), PRECIOUS).unwrap();
    let before = snapshot(outer.path());
    for dest in [
        src.join("copy"),
        src.join("sub"),
        src.join("sub").join("copy"),
        src.join("not-yet").join("deeper"),
        src.join(".").join("copy"),
        outer.path().join("src").join("sub").join("..").join("copy"),
    ] {
        let err = LocalFileBrowser::new()
            .copy(s(&src), s(&dest))
            .await
            .expect_err(s(&dest));
        assert_refused(&err, INSIDE);
        assert!(copy_sync(s(&src), s(&dest), true).is_err());
        assert_eq!(snapshot(outer.path()), before, "{}", dest.display());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_copied_into_itself_through_a_symlink_is_refused() {
    let outer = tempfile::tempdir().unwrap();
    let src = outer.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("f"), PRECIOUS).unwrap();
    let alias = outer.path().join("alias");
    std::os::unix::fs::symlink(&src, &alias).unwrap();
    let before = snapshot(outer.path());

    let err = LocalFileBrowser::new()
        .copy(s(&src), s(&alias.join("copy")))
        .await
        .expect_err("through the alias");
    assert_refused(&err, INSIDE);
    let err = LocalFileBrowser::new()
        .copy(s(&alias), s(&src.join("copy")))
        .await
        .expect_err("from the alias");
    assert_refused(&err, INSIDE);
    assert_eq!(snapshot(outer.path()), before);
}

#[tokio::test]
async fn a_folder_copied_beside_itself_still_works() {
    let outer = tempfile::tempdir().unwrap();
    let src = outer.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("f"), PRECIOUS).unwrap();
    // A name that merely shares the prefix is a sibling, not a child.
    let dest = outer.path().join("src-copy");
    LocalFileBrowser::new()
        .copy(s(&src), s(&dest))
        .await
        .unwrap();
    assert_eq!(std::fs::read(dest.join("f")).unwrap(), PRECIOUS);
    assert_eq!(std::fs::read(src.join("f")).unwrap(), PRECIOUS);
}
