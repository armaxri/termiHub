//! The container's path resolver script (#5330), run with the local `sh`
//! against temp-dir trees: it must see through symlinks, `.` and `..`, and
//! resolve a missing destination through its parent.

use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Command;

use super::{parse_resolved_path, RESOLVE_PATH_SCRIPT};

fn resolve(path: &Path) -> Option<String> {
    let out = Command::new("sh")
        .args(["-c", RESOLVE_PATH_SCRIPT, "sh"])
        .arg(path)
        .output()
        .expect("run sh");
    if !out.status.success() {
        return None;
    }
    parse_resolved_path(&String::from_utf8_lossy(&out.stdout))
}

/// `root/dir/f`, `root/dir/sub/`, `root/link -> dir`, `root/alias-f -> dir/f`.
fn tree() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::fs::create_dir_all(root.join("dir/sub")).expect("mkdir");
    std::fs::write(root.join("dir/f"), b"payload").expect("write");
    symlink(root.join("dir"), root.join("link")).expect("dir link");
    symlink(root.join("dir/f"), root.join("alias-f")).expect("file link");
    // The temp dir itself may sit behind a symlink (/var -> /private/var).
    let real = std::fs::canonicalize(root).expect("canonical root");
    (tmp, real.to_string_lossy().into_owned())
}

#[test]
fn every_spelling_of_a_file_resolves_to_the_same_path() {
    let (tmp, real) = tree();
    let root = tmp.path();
    let want = Some(format!("{real}/dir/f"));
    for spelling in ["dir/f", "dir/./f", "dir/sub/../f", "link/f", "alias-f"] {
        assert_eq!(resolve(&root.join(spelling)), want, "{spelling}");
    }
}

#[test]
fn a_folder_resolves_through_a_symlink_and_a_trailing_slash() {
    let (tmp, real) = tree();
    let root = tmp.path();
    let want = Some(format!("{real}/dir"));
    assert_eq!(resolve(&root.join("link")), want);
    assert_eq!(resolve(&root.join("dir/")), want);
    assert_eq!(resolve(&root.join("dir/sub/..")), want);
}

#[test]
fn a_missing_destination_resolves_through_its_parent() {
    let (tmp, real) = tree();
    let root = tmp.path();
    assert_eq!(
        resolve(&root.join("link/copy")),
        Some(format!("{real}/dir/copy"))
    );
    assert_eq!(resolve(&root.join("nope/copy")), None);
}

#[test]
fn a_hostile_name_is_passed_as_data() {
    let (tmp, real) = tree();
    let name = "-x '$(touch pwned)`id`; echo \"y\"";
    assert_eq!(
        resolve(&tmp.path().join("dir").join(name)),
        Some(format!("{real}/dir/{name}"))
    );
    assert!(!tmp.path().join("pwned").exists());
    assert!(!Path::new("pwned").exists());
}

#[test]
fn only_an_absolute_path_is_accepted_as_output() {
    assert_eq!(parse_resolved_path("/a/b\n").as_deref(), Some("/a/b"));
    assert_eq!(parse_resolved_path(""), None);
    assert_eq!(parse_resolved_path("relative\n"), None);
}
