use super::{allow_dialog_path_gated, ScopeGrant};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

/// Records every grant instead of touching a real scope.
#[derive(Default)]
struct RecordingScope {
    files: RefCell<Vec<PathBuf>>,
    dirs: RefCell<Vec<PathBuf>>,
}

impl ScopeGrant for RecordingScope {
    fn allow_file(&self, path: &Path) -> Result<(), String> {
        self.files.borrow_mut().push(path.to_path_buf());
        Ok(())
    }

    fn allow_directory(&self, path: &Path) -> Result<(), String> {
        self.dirs.borrow_mut().push(path.to_path_buf());
        Ok(())
    }
}

#[test]
fn refuses_and_grants_nothing_when_the_bridge_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let scope = RecordingScope::default();
    let target = dir.path().join("export.json");

    let result = allow_dialog_path_gated(false, &target, &scope);

    assert!(result.is_err());
    assert!(scope.files.borrow().is_empty());
    assert!(scope.dirs.borrow().is_empty());
}

#[test]
fn grants_a_save_target_that_does_not_exist_yet_as_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let scope = RecordingScope::default();
    let target = dir.path().join("not-yet-written.json");

    assert_eq!(allow_dialog_path_gated(true, &target, &scope), Ok(()));

    assert_eq!(*scope.files.borrow(), vec![target]);
    assert!(scope.dirs.borrow().is_empty());
}

#[test]
fn grants_an_existing_file_as_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let scope = RecordingScope::default();
    let target = dir.path().join("to-import.json");
    std::fs::write(&target, "{}").unwrap();

    assert_eq!(allow_dialog_path_gated(true, &target, &scope), Ok(()));

    assert_eq!(*scope.files.borrow(), vec![target]);
}

#[test]
fn grants_an_existing_directory_as_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let scope = RecordingScope::default();

    assert_eq!(allow_dialog_path_gated(true, dir.path(), &scope), Ok(()));

    assert_eq!(*scope.dirs.borrow(), vec![dir.path().to_path_buf()]);
    assert!(scope.files.borrow().is_empty());
}

#[test]
fn refuses_a_relative_path() {
    let scope = RecordingScope::default();

    let result = allow_dialog_path_gated(true, Path::new("relative/export.json"), &scope);

    assert!(result.is_err());
    assert!(scope.files.borrow().is_empty());
}

/// The real fs scope accepts the grant: a granted path is allowed afterwards,
/// a sibling stays refused.
#[test]
fn the_fs_scope_allows_exactly_the_granted_file() {
    let dir = tempfile::tempdir().unwrap();
    let scope = tauri::fs::Scope::new(
        &tauri::test::mock_app(),
        &tauri::utils::config::FsScope::AllowedPaths(Vec::new()),
    )
    .unwrap();
    let target = dir.path().join("granted.json");
    let sibling = dir.path().join("other.json");

    allow_dialog_path_gated(true, &target, &super::FsScope(scope.clone())).unwrap();

    assert!(scope.is_allowed(&target));
    assert!(!scope.is_allowed(&sibling));
}
