//! Tests for the same-session paste guard (#5330).

use std::collections::HashMap;

use super::*;

#[test]
fn the_same_entry_is_the_same_file() {
    assert_eq!(copy_conflict("/a/f", "/a/f", false), Some(SAME_FILE));
    assert_eq!(copy_conflict("/a/d", "/a/d/", true), Some(SAME_FILE));
}

#[test]
fn a_folder_into_its_own_subtree_is_inside_the_source() {
    assert_eq!(copy_conflict("/a/d", "/a/d/sub", true), Some(INSIDE_SOURCE));
    assert_eq!(
        copy_conflict("/a/d", "/a/d/x/y/z", true),
        Some(INSIDE_SOURCE)
    );
    assert_eq!(copy_conflict("/", "/x", true), Some(INSIDE_SOURCE));
}

#[test]
fn a_sibling_with_a_shared_prefix_is_not_a_conflict() {
    assert_eq!(copy_conflict("/a/d", "/a/d2", true), None);
    assert_eq!(copy_conflict("/a/f", "/a/f/x", false), None);
    assert_eq!(copy_conflict("/a/f", "/a/g", false), None);
}

#[test]
fn the_refusal_is_worded_like_the_other_copy_guards() {
    let err = copy_refused("/a/f", "/a/./f", SAME_FILE);
    assert_eq!(
        err.to_string(),
        "Operation failed: copy /a/f to /a/./f refused: source and destination are the same file"
    );
    let err = copy_refused("/a/d", "/a/d/x", INSIDE_SOURCE);
    assert!(err
        .to_string()
        .ends_with("copy /a/d to /a/d/x refused: the destination is inside the source folder"));
}

#[test]
fn lexical_normalisation_resolves_dots_and_slashes() {
    assert_eq!(normalize_lexically("/a/./b//c/"), "/a/b/c");
    assert_eq!(normalize_lexically("/a/b/../c"), "/a/c");
    assert_eq!(normalize_lexically("/../a"), "/a");
    assert_eq!(normalize_lexically("/"), "/");
    assert_eq!(normalize_lexically("a/../../b"), "../b");
    assert_eq!(normalize_lexically("./a/."), "a");
    assert_eq!(normalize_lexically("."), ".");
}

/// A fake backend: the paths that exist, plus symlink aliases, resolved the
/// way `realpath` would (a missing path does not resolve).
fn fake_realpath(path: &str) -> Option<String> {
    let aliases: HashMap<&str, &str> = HashMap::from([
        ("/link", "/data/dir"),
        ("/link/f", "/data/dir/f"),
        ("/data/alias-f", "/data/dir/f"),
    ]);
    let existing = ["/data", "/data/dir", "/data/dir/f", "/data/dir/sub", "/"];
    let normal = normalize_lexically(path);
    if let Some(target) = aliases.get(normal.as_str()) {
        return Some(target.to_string());
    }
    existing.contains(&normal.as_str()).then_some(normal)
}

async fn check(src: &str, dest: &str, src_is_dir: bool) -> Result<(), FileError> {
    // Resolved the way the SFTP resolver does: through the parent when the
    // path is missing.
    check_resolved(src, dest, src_is_dir, |p| async move {
        resolve_through_parent(&p, |q| async move { fake_realpath(&q) }).await
    })
    .await
}

#[tokio::test]
async fn a_missing_destination_resolves_through_its_parent() {
    let resolved = resolve_through_parent("/link/new", |p| async move { fake_realpath(&p) }).await;
    assert_eq!(resolved.as_deref(), Some("/data/dir/new"));
    let root_child = resolve_through_parent("/new", |p| async move { fake_realpath(&p) }).await;
    assert_eq!(root_child.as_deref(), Some("/new"));
    let nowhere = resolve_through_parent("/nope/x", |p| async move { fake_realpath(&p) }).await;
    assert_eq!(nowhere, None);
}

#[tokio::test]
async fn a_file_onto_itself_is_refused_whatever_the_spelling() {
    for dest in [
        "/data/dir/f",
        "/data/dir/./f",
        "/data/dir/sub/../f",
        "/link/f",
    ] {
        let err = check("/data/dir/f", dest, false)
            .await
            .expect_err(&format!("{dest} is the source"));
        assert!(err.to_string().contains(SAME_FILE), "{err}");
    }
    // A symlink to the file, in either direction.
    assert!(check("/data/alias-f", "/data/dir/f", false).await.is_err());
    assert!(check("/data/dir/f", "/data/alias-f", false).await.is_err());
}

#[tokio::test]
async fn a_folder_into_itself_or_a_descendant_is_refused() {
    for dest in [
        "/data/dir",
        "/data/dir/copy",
        "/data/dir/sub/copy",
        "/link/copy",
        "/data/dir/sub/../copy",
    ] {
        let err = check("/data/dir", dest, true)
            .await
            .expect_err(&format!("{dest} is inside the source"));
        assert!(
            err.to_string().contains(INSIDE_SOURCE) || err.to_string().contains(SAME_FILE),
            "{err}"
        );
    }
    assert!(check("/link", "/data/dir/sub/copy", true).await.is_err());
}

#[tokio::test]
async fn a_different_target_or_an_unresolvable_path_is_allowed() {
    check("/data/dir/f", "/data/g", false)
        .await
        .expect("other file");
    check("/data/dir", "/data/dir2", true)
        .await
        .expect("sibling");
    check("/missing/f", "/data/dir/f", false)
        .await
        .expect("unresolvable source is left to the copy");
}

#[tokio::test]
async fn the_lexical_resolver_catches_a_respelled_path() {
    let resolver = PathResolver::Lexical;
    assert!(resolver
        .ensure_copy_allowed("/a/f", "/a/b/../f", false)
        .await
        .is_err());
    assert!(resolver
        .ensure_copy_allowed("/a/d", "/a//d/./x", true)
        .await
        .is_err());
    resolver
        .ensure_copy_allowed("/a/f", "/a/g", false)
        .await
        .expect("different files");
}

// ── #5333: a backend canonicalizer, the lexical check as the floor ──

/// `fake_realpath` as a canonicalizer would answer it: through the parent
/// for a missing final name, an error when nothing resolves.
async fn fake_canon(path: String) -> Result<String, FileError> {
    resolve_through_parent(&path, |p| async move { fake_realpath(&p) })
        .await
        .ok_or_else(|| FileError::NotFound(path.clone()))
}

/// A backend that cannot resolve anything: an agent from before
/// `connection.files.realpath`.
async fn no_canon(_path: String) -> Result<String, FileError> {
    Err(FileError::NotSupported)
}

#[tokio::test]
async fn a_canonicalizer_sees_through_a_symlink_alias() {
    let err = check_real_or_lexical("/data/dir/f", "/data/alias-f", false, fake_canon)
        .await
        .expect_err("the alias is the source");
    assert_eq!(
        err.to_string(),
        "Operation failed: copy /data/dir/f to /data/alias-f refused: \
         source and destination are the same file"
    );
    let err = check_real_or_lexical("/data/dir", "/link/copy", true, fake_canon)
        .await
        .expect_err("the alias is inside the source");
    assert!(err.to_string().ends_with(INSIDE_SOURCE), "{err}");
    check_real_or_lexical("/data/dir/f", "/data/g", false, fake_canon)
        .await
        .expect("a different file copies");
}

/// Without a working canonicalizer the guard is exactly the lexical one of
/// #5330: a respelled path is refused, an alias it cannot see is not.
#[tokio::test]
async fn an_unresolvable_path_falls_back_to_the_lexical_check() {
    for (src, dest, is_dir) in [("/a/f", "/a/b/../f", false), ("/a/d", "/a//d/./x", true)] {
        let lexical = PathResolver::Lexical
            .ensure_copy_allowed(src, dest, is_dir)
            .await
            .expect_err("lexically the same");
        let fallback = check_real_or_lexical(src, dest, is_dir, no_canon)
            .await
            .expect_err("the fallback is the lexical check");
        assert_eq!(fallback.to_string(), lexical.to_string());
    }
    check_real_or_lexical("/data/dir/f", "/data/alias-f", false, no_canon)
        .await
        .expect("an alias is invisible without a resolver, as before");
    // Only one side resolves: both compare lexically, so a respelled path
    // is still refused.
    check_real_or_lexical("/data/dir/f", "/nope/../data/dir/f", false, fake_canon)
        .await
        .expect_err("the lexical floor holds when one side does not resolve");
}

#[cfg(unix)]
mod local {
    use super::*;
    use crate::files::LocalFileBrowser;

    fn tree() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path())
            .expect("canonical tempdir")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(format!("{root}/data/sub")).expect("mkdir");
        std::fs::write(format!("{root}/data/f"), b"payload").expect("write");
        std::os::unix::fs::symlink(format!("{root}/data"), format!("{root}/link"))
            .expect("dir link");
        std::os::unix::fs::symlink(format!("{root}/data/f"), format!("{root}/alias-f"))
            .expect("file link");
        (dir, root)
    }

    #[tokio::test]
    async fn local_realpath_follows_links_and_a_missing_final_name() {
        let (_dir, root) = tree();
        let real = |p: &str| {
            let path = format!("{root}/{p}");
            async move { local_realpath(&path).await }
        };
        assert_eq!(real("link/f").await.unwrap(), format!("{root}/data/f"));
        assert_eq!(real("alias-f").await.unwrap(), format!("{root}/data/f"));
        assert_eq!(real("link/new").await.unwrap(), format!("{root}/data/new"));
        assert_eq!(
            real("link/sub/../f").await.unwrap(),
            format!("{root}/data/f")
        );
        assert!(matches!(real("nope/x").await, Err(FileError::NotFound(_))));
    }

    #[tokio::test]
    async fn a_local_paste_through_an_alias_is_refused() {
        let (_dir, root) = tree();
        let browser = LocalFileBrowser::new();
        let src = format!("{root}/data/f");
        let alias = format!("{root}/alias-f");
        let err = ensure_paste_allowed(&browser, &src, &alias, false)
            .await
            .expect_err("the alias is the source");
        assert_eq!(
            err.to_string(),
            format!("Operation failed: copy {src} to {alias} refused: {SAME_FILE}")
        );
        let folder = format!("{root}/data");
        let into = format!("{root}/link/sub/copy");
        let err = ensure_paste_allowed(&browser, &folder, &into, true)
            .await
            .expect_err("inside the source");
        assert!(err.to_string().ends_with(INSIDE_SOURCE), "{err}");
        ensure_paste_allowed(&browser, &folder, &format!("{root}/data2"), true)
            .await
            .expect("a sibling copies");
        assert_eq!(std::fs::read(&src).unwrap(), b"payload");
        assert_eq!(
            real_path(&browser, &alias).await.unwrap(),
            src,
            "what an agent answers connection.files.realpath with"
        );
    }
}

/// A browser without a resolver of its own answers `NotSupported`, so the
/// agent tells the desktop to fall back to its lexical check.
#[tokio::test]
async fn real_path_of_a_browser_without_a_resolver_is_not_supported() {
    struct Plain;
    #[async_trait::async_trait]
    impl FileBrowser for Plain {
        async fn list_dir(&self, _: &str) -> Result<Vec<crate::files::FileEntry>, FileError> {
            Err(FileError::NotSupported)
        }
        async fn read_file(&self, _: &str) -> Result<Vec<u8>, FileError> {
            Err(FileError::NotSupported)
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn delete(&self, _: &str) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn rename(&self, _: &str, _: &str) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn stat(&self, _: &str) -> Result<crate::files::FileEntry, FileError> {
            Err(FileError::NotSupported)
        }
        async fn mkdir(&self, _: &str) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn set_permissions(&self, _: &str, _: u32) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn set_owner(
            &self,
            _: &str,
            _: Option<u32>,
            _: Option<u32>,
        ) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn create_symlink(&self, _: &str, _: &str) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
        async fn copy(&self, _: &str, _: &str) -> Result<(), FileError> {
            Err(FileError::NotSupported)
        }
    }
    assert!(matches!(
        real_path(&Plain, "/a").await,
        Err(FileError::NotSupported)
    ));
    ensure_paste_allowed(&Plain, "/a/f", "/a/./f", false)
        .await
        .expect_err("the lexical check still applies");
}
