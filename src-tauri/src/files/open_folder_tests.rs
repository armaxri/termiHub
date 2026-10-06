use super::*;

#[test]
fn opens_a_plain_directory_by_its_canonical_path() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("projects");
    std::fs::create_dir(&sub).unwrap();

    let target = resolve_folder_target(sub.to_str().unwrap()).unwrap();
    let expected = strip_verbatim_prefix(std::fs::canonicalize(&sub).unwrap());
    assert_eq!(target, FolderTarget::Open(expected));
}

#[test]
fn rejects_an_empty_path() {
    assert!(matches!(
        resolve_folder_target(""),
        Err(TerminalError::InvalidParams(_))
    ));
}

#[test]
fn rejects_a_relative_path() {
    assert!(matches!(
        resolve_folder_target("some/relative/dir"),
        Err(TerminalError::InvalidParams(_))
    ));
}

#[test]
fn rejects_a_missing_path() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert!(matches!(
        resolve_folder_target(missing.to_str().unwrap()),
        Err(TerminalError::NotFound(_))
    ));
}

#[test]
fn rejects_a_regular_file_so_no_executable_or_document_is_launched() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("run.sh");
    std::fs::write(&file, "#!/bin/sh\necho hi\n").unwrap();
    assert!(matches!(
        resolve_folder_target(file.to_str().unwrap()),
        Err(TerminalError::InvalidParams(_))
    ));
}

#[test]
fn reveals_a_launching_bundle_instead_of_opening_it() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("Evil.app");
    std::fs::create_dir(&bundle).unwrap();

    let target = resolve_folder_target(bundle.to_str().unwrap()).unwrap();
    assert!(matches!(target, FolderTarget::Reveal(_)), "{target:?}");
}

#[cfg(unix)]
#[test]
fn a_symlink_is_judged_by_what_it_points_to() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("Tool.app");
    std::fs::create_dir(&bundle).unwrap();
    let link = dir.path().join("docs");
    std::os::unix::fs::symlink(&bundle, &link).unwrap();

    let target = resolve_folder_target(link.to_str().unwrap()).unwrap();
    assert!(matches!(target, FolderTarget::Reveal(_)), "{target:?}");

    let file = dir.path().join("script.sh");
    std::fs::write(&file, "x").unwrap();
    let file_link = dir.path().join("folder-looking");
    std::os::unix::fs::symlink(&file, &file_link).unwrap();
    assert!(resolve_folder_target(file_link.to_str().unwrap()).is_err());
}

#[test]
fn launching_names_are_detected_case_insensitively() {
    for name in [
        "Foo.app",
        "foo.APP",
        "Pane.prefPane",
        "x.saver",
        "a.workflow",
        "Control.{21EC2020-3AEA-1069-A2DD-08002B30309D}",
    ] {
        assert!(launches_when_opened(name), "{name}");
    }
}

#[test]
fn ordinary_folder_names_are_opened() {
    for name in ["projects", "my.notes", "v1.2", ".app", "app", "src", ".config"] {
        assert!(!launches_when_opened(name), "{name}");
    }
}

#[test]
fn verbatim_prefixes_are_stripped() {
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\me")),
        PathBuf::from(r"C:\Users\me")
    );
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\wsl$\Ubuntu\home")),
        PathBuf::from(r"\\wsl$\Ubuntu\home")
    );
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from("/home/me")),
        PathBuf::from("/home/me")
    );
}
