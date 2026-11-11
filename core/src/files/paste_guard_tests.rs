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
