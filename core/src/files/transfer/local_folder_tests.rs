//! Tests for the local folder-copy planner, layout and group cancel (#3605).

use super::*;
use crate::files::transfer::local::{partial_path, DIRECT_COPY_MAX_BYTES, LOCAL_TRANSFER_SESSION};
use crate::files::transfer::{TransferDirection, TransferProgress};

fn write(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(path, bytes).expect("write");
}

/// A sparse file just above the direct-copy threshold (cheap to create).
fn write_big(path: &Path) -> u64 {
    let size = DIRECT_COPY_MAX_BYTES + 1;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    let file = std::fs::File::create(path).expect("create");
    file.set_len(size).expect("set_len");
    size
}

fn rels(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect()
}

fn file_rels(files: &[FolderFile]) -> Vec<String> {
    files
        .iter()
        .map(|f| f.rel.to_string_lossy().replace('\\', "/"))
        .collect()
}

fn limits(max_entries: usize, max_depth: usize, max_bytes: u64) -> FolderCopyLimits {
    FolderCopyLimits {
        max_entries,
        max_depth,
        max_bytes,
    }
}

// --- plan -------------------------------------------------------------------

#[test]
fn plan_splits_the_tree_by_threshold_with_parents_first() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("a.txt"), b"alpha");
    write(&src.join("sub/b.txt"), b"beta!");
    let big = write_big(&src.join("sub/deeper/big.iso"));
    std::fs::create_dir_all(src.join("empty")).expect("mkdir");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");

    assert_eq!(rels(&plan.dirs), ["empty", "sub", "sub/deeper"]);
    assert_eq!(file_rels(&plan.direct), ["a.txt", "sub/b.txt"]);
    assert_eq!(file_rels(&plan.queued), ["sub/deeper/big.iso"]);
    assert_eq!(plan.queued[0].size, big);
    assert_eq!(plan.total_bytes, 5 + 5 + big);
    assert!(plan.symlinks.is_empty());
    assert!(plan.skipped.is_empty());
}

#[test]
fn threshold_boundary_file_is_copied_directly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).expect("mkdir");
    let f = std::fs::File::create(src.join("edge.bin")).expect("create");
    f.set_len(DIRECT_COPY_MAX_BYTES).expect("set_len");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    assert_eq!(file_rels(&plan.direct), ["edge.bin"]);
    assert!(plan.queued.is_empty());
}

#[cfg(unix)]
#[test]
fn plan_records_symlinks_without_following_them() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    let outside = dir.path().join("outside");
    write(&outside.join("secret.txt"), b"not part of the copy");
    std::fs::create_dir_all(&src).expect("mkdir");
    std::os::unix::fs::symlink(&outside, src.join("to_dir")).expect("link dir");
    std::os::unix::fs::symlink("missing", src.join("dangling")).expect("link dangling");
    // A loop back into the tree must not recurse.
    std::os::unix::fs::symlink(".", src.join("loop")).expect("link loop");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");

    assert_eq!(rels(&plan.symlinks), ["dangling", "loop", "to_dir"]);
    assert!(plan.dirs.is_empty(), "a symlinked dir is not walked");
    assert!(plan.direct.is_empty());
    assert_eq!(plan.total_bytes, 0);
}

#[cfg(unix)]
#[test]
fn plan_skips_and_reports_special_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    std::fs::create_dir_all(src.join("run")).expect("mkdir");
    write(&src.join("keep.txt"), b"k");
    let _listener =
        std::os::unix::net::UnixListener::bind(src.join("run/app.sock")).expect("socket");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");

    assert_eq!(rels(&plan.skipped), ["run/app.sock"]);
    assert_eq!(file_rels(&plan.direct), ["keep.txt"]);
}

#[test]
fn plan_refuses_a_tree_with_too_many_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    for i in 0..4 {
        write(&src.join(format!("f{i}")), b"x");
    }
    assert!(plan_folder_copy(&src, &limits(4, 8, u64::MAX)).is_ok());
    let err = plan_folder_copy(&src, &limits(3, 8, u64::MAX)).expect_err("limit");
    assert!(matches!(err, FolderCopyError::TooManyEntries(3)), "{err}");
}

#[test]
fn plan_refuses_a_tree_nested_too_deep() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    // Depth 3: a/b/c.txt.
    write(&src.join("a/b/c.txt"), b"x");
    assert!(plan_folder_copy(&src, &limits(100, 3, u64::MAX)).is_ok());
    let err = plan_folder_copy(&src, &limits(100, 2, u64::MAX)).expect_err("limit");
    assert!(matches!(err, FolderCopyError::TooDeep(2)), "{err}");
}

#[test]
fn plan_refuses_a_tree_that_is_too_large() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("a"), &[0; 10]);
    write(&src.join("b"), &[0; 10]);
    assert!(plan_folder_copy(&src, &limits(100, 8, 20)).is_ok());
    let err = plan_folder_copy(&src, &limits(100, 8, 19)).expect_err("limit");
    assert!(matches!(err, FolderCopyError::TooLarge(19)), "{err}");
}

#[test]
fn plan_of_a_missing_folder_is_an_io_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let err = plan_folder_copy(&dir.path().join("nope"), &FolderCopyLimits::default())
        .expect_err("missing");
    assert!(matches!(err, FolderCopyError::Io { .. }), "{err}");
}

// --- into itself ------------------------------------------------------------

#[test]
fn copying_a_folder_into_itself_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    std::fs::create_dir_all(src.join("sub")).expect("mkdir");

    for dest in [
        src.clone(),
        src.join("sub/copy"),
        src.join("not-yet/deeper"),
        src.join("sub/../copy"),
    ] {
        let err = check_not_into_itself(&src, &dest).expect_err("into itself");
        assert!(
            matches!(err, FolderCopyError::IntoItself),
            "{}: {err}",
            dest.display()
        );
    }
}

#[test]
fn copying_a_folder_beside_itself_is_allowed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).expect("mkdir");
    // A name that merely shares the prefix is a sibling, not a child.
    check_not_into_itself(&src, &dir.path().join("src-copy")).expect("sibling");
    check_not_into_itself(&src, &dir.path().join("other/src")).expect("elsewhere");
}

// --- layout -----------------------------------------------------------------

#[test]
fn layout_creates_dirs_and_copies_only_the_small_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("a.txt"), b"alpha");
    write(&src.join("sub/b.txt"), b"beta");
    write_big(&src.join("sub/big.iso"));
    std::fs::create_dir_all(src.join("empty")).expect("mkdir");
    let dest = dir.path().join("out/copy");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    lay_out_folder_copy(&src, &dest, &plan).expect("layout");

    assert_eq!(std::fs::read(dest.join("a.txt")).expect("a"), b"alpha");
    assert_eq!(std::fs::read(dest.join("sub/b.txt")).expect("b"), b"beta");
    assert!(dest.join("empty").is_dir());
    assert!(
        !dest.join("sub/big.iso").exists(),
        "queued files are left out"
    );
}

#[test]
fn layout_merges_into_an_existing_folder() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("same.txt"), b"new");
    write(&src.join("sub/new.txt"), b"added");
    let dest = dir.path().join("dest");
    write(&dest.join("same.txt"), b"old contents");
    write(&dest.join("unrelated.txt"), b"stays");
    write(&dest.join("sub/also-stays.txt"), b"stays too");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    lay_out_folder_copy(&src, &dest, &plan).expect("layout");

    assert_eq!(std::fs::read(dest.join("same.txt")).expect("same"), b"new");
    assert_eq!(
        std::fs::read(dest.join("sub/new.txt")).expect("new"),
        b"added"
    );
    assert_eq!(
        std::fs::read(dest.join("unrelated.txt")).expect("u"),
        b"stays"
    );
    assert_eq!(
        std::fs::read(dest.join("sub/also-stays.txt")).expect("s"),
        b"stays too"
    );
}

#[test]
fn layout_refuses_a_file_where_a_folder_must_go() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("sub/x.txt"), b"x");
    let dest = dir.path().join("dest");
    write(&dest.join("sub"), b"a file, not a folder");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    let err = lay_out_folder_copy(&src, &dest, &plan).expect_err("conflict");
    assert!(matches!(err, FolderCopyError::Io { .. }), "{err}");
    assert_eq!(
        std::fs::read(dest.join("sub")).expect("kept"),
        b"a file, not a folder"
    );
}

#[cfg(unix)]
#[test]
fn layout_recreates_symlinks_verbatim_and_replaces_existing_links() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).expect("mkdir");
    std::os::unix::fs::symlink("../elsewhere", src.join("rel")).expect("link");
    std::os::unix::fs::symlink("missing", src.join("dangling")).expect("link");
    let dest = dir.path().join("dest");
    std::fs::create_dir_all(&dest).expect("mkdir");
    std::os::unix::fs::symlink("old-target", dest.join("rel")).expect("old link");

    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    lay_out_folder_copy(&src, &dest, &plan).expect("layout");

    assert_eq!(
        std::fs::read_link(dest.join("rel")).expect("rel"),
        Path::new("../elsewhere")
    );
    assert_eq!(
        std::fs::read_link(dest.join("dangling")).expect("dangling"),
        Path::new("missing")
    );
}

// --- group cancel + end-to-end ----------------------------------------------

fn quiet_sink() -> ProgressSink {
    Arc::new(|_: &TransferProgress| {})
}

fn enqueue(reg: &TransferRegistry, id: &str, path: &Path) -> Arc<TransferHandle> {
    reg.enqueue(
        id,
        LOCAL_TRANSFER_SESSION,
        TransferDirection::Download,
        "f",
        &path.to_string_lossy(),
        0,
    )
}

async fn wait_for(cond: impl Fn() -> bool) {
    for _ in 0..20_000 {
        if cond() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("condition not reached");
}

#[tokio::test]
async fn cancelling_one_file_cancels_the_rest_of_its_folder() {
    let dir = tempfile::tempdir().expect("tempdir");
    let reg = TransferRegistry::new();
    let ids: Arc<[String]> = Arc::from(vec!["g-1".to_string(), "g-2".to_string()]);
    let mut tasks = Vec::new();
    let mut handles = Vec::new();
    for id in ids.iter() {
        let src = dir.path().join(format!("{id}.src"));
        write_big(&src);
        let dest = dir.path().join(format!("out/{id}.bin"));
        let handle = enqueue(&reg, id, &src);
        // Hold both at their first chunk boundary.
        assert!(reg.pause(id));
        handles.push((handle.clone(), dest.clone()));
        tasks.push(tokio::spawn(run_local_transfer_in_group(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            handle,
            reg.clone(),
            quiet_sink(),
            ids.clone(),
        )));
    }
    wait_for(|| {
        handles
            .iter()
            .all(|(h, _)| h.state().tag() == TransferStateTag::Paused)
    })
    .await;

    assert!(reg.cancel("g-1"));
    for task in tasks {
        task.await.expect("join");
    }

    for (handle, dest) in &handles {
        assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
        assert!(!dest.exists(), "no file at its final name");
        assert!(!partial_path(&dest.to_string_lossy(), &handle.transfer_id).exists());
    }
}

#[tokio::test]
async fn completed_files_do_not_cancel_their_siblings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let reg = TransferRegistry::new();
    let ids: Arc<[String]> = Arc::from(vec!["d-1".to_string(), "d-2".to_string()]);
    let src1 = dir.path().join("one.src");
    write(&src1, b"first");
    let dest1 = dir.path().join("one.bin");
    let h1 = enqueue(&reg, "d-1", &src1);
    let src2 = dir.path().join("two.src");
    write(&src2, b"second");
    let h2 = enqueue(&reg, "d-2", &src2);
    assert!(reg.pause("d-2"));

    run_local_transfer_in_group(
        src1.to_string_lossy().into_owned(),
        dest1.to_string_lossy().into_owned(),
        h1.clone(),
        reg.clone(),
        quiet_sink(),
        ids,
    )
    .await;

    assert_eq!(h1.state().tag(), TransferStateTag::Completed);
    assert_ne!(h2.state().tag(), TransferStateTag::Cancelled);
    assert!(reg.get("d-2").is_some(), "sibling still queued");
}

#[tokio::test]
async fn a_folder_copy_end_to_end_reproduces_the_tree() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("src");
    write(&src.join("readme.md"), b"# hi");
    write(&src.join("nested/deep/small.cfg"), b"k=v");
    let big: Vec<u8> = (0..(DIRECT_COPY_MAX_BYTES as usize + 4096))
        .map(|i| (i % 251) as u8)
        .collect();
    write(&src.join("nested/big.bin"), &big);
    let dest = dir.path().join("dest");

    check_not_into_itself(&src, &dest).expect("not into itself");
    let plan = plan_folder_copy(&src, &FolderCopyLimits::default()).expect("plan");
    lay_out_folder_copy(&src, &dest, &plan).expect("layout");
    assert_eq!(plan.queued.len(), 1);

    let reg = TransferRegistry::new();
    let ids: Arc<[String]> = Arc::from(vec!["e2e-1".to_string()]);
    let file = &plan.queued[0];
    let handle = enqueue(&reg, "e2e-1", &src.join(&file.rel));
    run_local_transfer_in_group(
        src.join(&file.rel).to_string_lossy().into_owned(),
        dest.join(&file.rel).to_string_lossy().into_owned(),
        handle.clone(),
        reg,
        quiet_sink(),
        ids,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(std::fs::read(dest.join("readme.md")).expect("r"), b"# hi");
    assert_eq!(
        std::fs::read(dest.join("nested/deep/small.cfg")).expect("s"),
        b"k=v"
    );
    assert_eq!(std::fs::read(dest.join("nested/big.bin")).expect("b"), big);
}
