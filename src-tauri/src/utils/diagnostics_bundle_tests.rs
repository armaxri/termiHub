use std::fs;
use std::io::Read;

use termihub_core::diagnostics::crash_report::CRASH_DIR_NAME;
use termihub_core::diagnostics::redact::RedactionContext;

use super::*;

fn build() -> BuildInfo {
    BuildInfo {
        version: "9.9.9".into(),
        git_hash: "abc1234".into(),
        build_branch: "develop".into(),
    }
}

fn redactor() -> Redactor {
    Redactor::new(RedactionContext {
        home_dirs: vec!["/Users/alice".into()],
        usernames: vec!["alice".into()],
        hostnames: vec!["alice-mbp".into()],
    })
}

/// A log dir with two log generations, a crash report, a session transcript
/// and an unrelated file.
fn populated_log_dir() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    fs::write(
        dir.join("termihub.log"),
        "INFO connect alice@alice-mbp password=hunter2 to 10.0.0.5\n",
    )
    .unwrap();
    fs::write(dir.join("termihub.1.log"), "INFO older run\n").unwrap();
    fs::create_dir_all(dir.join(CRASH_DIR_NAME)).unwrap();
    fs::write(
        dir.join(CRASH_DIR_NAME)
            .join("crash-20260101T000000Z-1.txt"),
        "panic at /Users/alice/x.rs",
    )
    .unwrap();
    fs::create_dir_all(dir.join("sessions")).unwrap();
    fs::write(
        dir.join("sessions").join("ssh-session.log"),
        "$ secret output",
    )
    .unwrap();
    fs::write(dir.join("unrelated.txt"), "nope").unwrap();
    tmp
}

fn names(entries: &[BundleEntry]) -> Vec<String> {
    entries.iter().map(|e| e.info.name.clone()).collect()
}

fn read_zip(path: &Path) -> Vec<(String, String)> {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|i| {
            let mut f = archive.by_index(i).unwrap();
            let mut text = String::new();
            f.read_to_string(&mut text).unwrap();
            (f.name().to_string(), text)
        })
        .collect()
}

#[test]
fn plan_lists_readme_system_info_logs_and_crash_reports_only() {
    let tmp = populated_log_dir();
    let entries = plan_bundle(Some(tmp.path()), &build(), SystemTime::now());
    assert_eq!(
        names(&entries),
        vec![
            "README.txt",
            "system-info.txt",
            "logs/termihub.log",
            "logs/termihub.1.log",
            "crash-reports/crash-20260101T000000Z-1.txt",
        ]
    );
    assert!(entries.iter().all(|e| e.info.size > 0));
}

#[test]
fn plan_never_includes_session_transcripts() {
    let tmp = populated_log_dir();
    let entries = plan_bundle(Some(tmp.path()), &build(), SystemTime::now());
    assert!(!names(&entries).iter().any(|n| n.contains("session")));
}

#[test]
fn plan_without_a_log_dir_still_has_system_info() {
    let entries = plan_bundle(None, &build(), SystemTime::now());
    assert_eq!(names(&entries), vec!["README.txt", "system-info.txt"]);
}

#[test]
fn system_info_carries_version_build_and_platform() {
    let entries = plan_bundle(None, &build(), SystemTime::now());
    let BundleSource::Text(info) = &entries[1].source else {
        panic!("system-info is generated text");
    };
    assert!(info.contains("9.9.9"));
    assert!(info.contains("abc1234"));
    assert!(info.contains(std::env::consts::OS));
    assert!(info.contains(std::env::consts::ARCH));
}

#[test]
fn written_bundle_matches_the_plan_and_is_redacted() {
    let tmp = populated_log_dir();
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("diag.zip");
    let entries = plan_bundle(Some(tmp.path()), &build(), SystemTime::now());

    let count = write_bundle(&dest, &entries, &redactor()).unwrap();

    assert_eq!(count, entries.len());
    let files = read_zip(&dest);
    let zipped: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(zipped, names(&entries));
    let all: String = files.iter().map(|(_, t)| t.as_str()).collect();
    for leak in ["alice", "hunter2", "10.0.0.5", "secret output"] {
        assert!(!all.contains(leak), "{leak} leaked into the bundle");
    }
    assert!(all.contains("older run"));
    // No partial file is left behind.
    assert!(!out.path().join("diag.zip.partial").exists());
}

#[test]
fn a_vanished_source_file_is_skipped() {
    let tmp = populated_log_dir();
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("diag.zip");
    let entries = plan_bundle(Some(tmp.path()), &build(), SystemTime::now());
    fs::remove_file(tmp.path().join("termihub.1.log")).unwrap();

    let count = write_bundle(&dest, &entries, &redactor()).unwrap();

    assert_eq!(count, entries.len() - 1);
}

#[test]
fn a_failed_write_leaves_nothing_at_the_destination() {
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("missing-dir").join("diag.zip");
    let entries = plan_bundle(None, &build(), SystemTime::now());
    assert!(write_bundle(&dest, &entries, &redactor()).is_err());
    assert!(!dest.exists());
}
