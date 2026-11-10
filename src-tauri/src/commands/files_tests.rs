//! Table tests for the thin `local_*` file commands (#5168), run against a
//! temp dir through the exact command functions the frontend invokes.

use std::path::Path;

use tempfile::TempDir;

use super::*;

fn p(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

fn write(dir: &Path, name: &str, content: &str) -> String {
    let path = p(dir, name);
    std::fs::write(&path, content).unwrap();
    path
}

#[test]
fn list_mkdir_and_stat_report_what_is_on_disk() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "a.txt", "hello");
    local_mkdir(p(dir.path(), "sub")).unwrap();

    let mut entries = local_list_dir(dir.path().to_string_lossy().into_owned()).unwrap();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let summary: Vec<(&str, bool)> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_directory))
        .collect();
    assert_eq!(summary, vec![("a.txt", false), ("sub", true)]);

    let stat = local_stat(p(dir.path(), "a.txt")).unwrap();
    assert_eq!(stat.size, 5);
    assert!(!stat.is_directory);
}

#[test]
fn missing_paths_are_errors() {
    let dir = TempDir::new().unwrap();
    let missing = p(dir.path(), "missing");
    let cases: Vec<(&str, Result<(), TerminalError>)> = vec![
        ("list", local_list_dir(missing.clone()).map(|_| ())),
        ("stat", local_stat(missing.clone()).map(|_| ())),
        ("read", local_read_file(missing.clone()).map(|_| ())),
        ("delete file", local_delete(missing.clone(), false)),
        ("delete dir", local_delete(missing.clone(), true)),
        (
            "rename",
            local_rename(missing.clone(), p(dir.path(), "x"), None),
        ),
        (
            "mkdir under a missing parent",
            local_mkdir(p(dir.path(), "missing/child")),
        ),
    ];
    for (name, result) in cases {
        assert!(result.is_err(), "{name} on a missing path succeeded");
    }
}

#[test]
fn delete_removes_files_and_whole_directories() {
    let dir = TempDir::new().unwrap();
    let file = write(dir.path(), "f.txt", "x");
    local_mkdir(p(dir.path(), "d")).unwrap();
    write(dir.path(), "d/inner.txt", "y");

    local_delete(file.clone(), false).unwrap();
    local_delete(p(dir.path(), "d"), true).unwrap();

    assert!(!Path::new(&file).exists());
    assert!(!dir.path().join("d").exists());
}

#[test]
fn rename_overwrites_by_default_and_refuses_when_overwrite_is_false() {
    // (overwrite param, expect ok, destination content afterwards)
    let cases = [
        (None, true, "src"),
        (Some(true), true, "src"),
        (Some(false), false, "dest"),
    ];
    for (overwrite, ok, dest_after) in cases {
        let dir = TempDir::new().unwrap();
        let src = write(dir.path(), "src.txt", "src");
        let dest = write(dir.path(), "dest.txt", "dest");

        let result = local_rename(src.clone(), dest.clone(), overwrite);

        assert_eq!(result.is_ok(), ok, "overwrite={overwrite:?}: {result:?}");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), dest_after);
        assert_eq!(Path::new(&src).exists(), !ok, "overwrite={overwrite:?}");
    }
}

#[test]
fn rename_without_overwrite_moves_to_a_free_name() {
    let dir = TempDir::new().unwrap();
    let src = write(dir.path(), "src.txt", "src");
    let dest = p(dir.path(), "new.txt");
    local_rename(src.clone(), dest.clone(), Some(false)).unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "src");
    assert!(!Path::new(&src).exists());
}

#[test]
fn write_overwrites_unless_exclusive() {
    // (pre-existing content, exclusive param, expect ok, content afterwards)
    let cases = [
        (None, None, true, "new"),
        (None, Some(true), true, "new"),
        (Some("old"), None, true, "new"),
        (Some("old"), Some(false), true, "new"),
        (Some("old"), Some(true), false, "old"),
    ];
    for (existing, exclusive, ok, after) in cases {
        let dir = TempDir::new().unwrap();
        let path = p(dir.path(), "f.txt");
        if let Some(old) = existing {
            std::fs::write(&path, old).unwrap();
        }

        let result = local_write_file(path.clone(), "new".to_string(), exclusive);

        assert_eq!(
            result.is_ok(),
            ok,
            "existing={existing:?} exclusive={exclusive:?}: {result:?}"
        );
        assert_eq!(local_read_file(path).unwrap(), after);
    }
}

#[test]
fn read_round_trips_utf8_content() {
    let dir = TempDir::new().unwrap();
    let path = p(dir.path(), "u.txt");
    local_write_file(path.clone(), "grüße ✓\n".to_string(), Some(true)).unwrap();
    assert_eq!(local_read_file(path).unwrap(), "grüße ✓\n");
}

#[cfg(unix)]
#[test]
fn set_permissions_applies_the_mode_bits() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "f.sh", "#!/bin/sh");
    for mode in [0o755, 0o600, 0o640] {
        local_set_permissions(path.clone(), mode).unwrap();
        let actual = std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(actual, mode);
    }
    assert!(local_set_permissions(p(dir.path(), "missing"), 0o644).is_err());
}

#[cfg(unix)]
#[test]
fn set_owner_with_no_ids_leaves_the_file_alone() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "f.txt", "x");
    local_set_owner(path, None, None).unwrap();
    assert!(local_set_owner(p(dir.path(), "missing"), None, None).is_err());
}

#[cfg(unix)]
#[test]
fn create_symlink_links_to_the_target() {
    let dir = TempDir::new().unwrap();
    let target = write(dir.path(), "t.txt", "target");
    let link = p(dir.path(), "l.txt");
    local_create_symlink(target.clone(), link.clone()).unwrap();
    assert_eq!(std::fs::read_link(&link).unwrap(), Path::new(&target));
    assert_eq!(local_read_file(link.clone()).unwrap(), "target");
    assert!(local_stat(link.clone()).unwrap().is_symlink);
    // The link path is taken now.
    assert!(local_create_symlink(target, link).is_err());
}

#[cfg(not(unix))]
#[test]
fn unix_only_ops_are_refused_elsewhere() {
    let dir = TempDir::new().unwrap();
    let path = write(dir.path(), "f.txt", "x");
    assert!(local_set_permissions(path.clone(), 0o644).is_err());
    assert!(local_set_owner(path.clone(), Some(0), None).is_err());
    assert!(local_create_symlink(path, p(dir.path(), "l")).is_err());
}

#[test]
fn home_dir_is_an_existing_directory() {
    let home = get_home_dir().unwrap();
    assert!(Path::new(&home).is_dir(), "{home}");
}
