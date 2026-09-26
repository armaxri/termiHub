use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::*;
use crate::diagnostics::redact::{RedactionContext, Redactor};

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}

fn details(message: &str) -> CrashDetails {
    CrashDetails {
        app: "termiHub desktop".into(),
        version: "0.1.0".into(),
        thread: Some("main".into()),
        location: Some("src/lib.rs:42:9".into()),
        message: message.into(),
        backtrace: "0: frame_one\n1: frame_two".into(),
    }
}

fn redactor() -> Redactor {
    Redactor::new(RedactionContext {
        home_dirs: vec!["/Users/alice".into()],
        usernames: vec!["alice".into()],
        hostnames: vec!["alice-mbp".into()],
    })
}

/// Write a plain report file with a given name (bypassing the clock).
fn touch(dir: &std::path::Path, name: &str) {
    fs::write(dir.join(name), "x").unwrap();
}

#[test]
fn formats_utc_timestamps() {
    assert_eq!(format_utc(at(0)), "1970-01-01T00:00:00Z");
    // 2026-09-26T12:01:02Z
    assert_eq!(format_utc(at(1_790_424_062)), "2026-09-26T12:01:02Z");
    // Leap day.
    assert_eq!(format_utc(at(951_782_400)), "2000-02-29T00:00:00Z");
}

#[test]
fn report_names_sort_chronologically() {
    let a = report_file_name(at(1_790_424_062), 7);
    let b = report_file_name(at(1_790_424_063), 1);
    assert_eq!(a, "crash-20260926T120102Z-7.txt");
    assert!(a < b);
}

#[test]
fn a_report_has_version_os_time_message_and_backtrace() {
    let text = render_report(&details("index out of bounds"), at(1_790_424_062), &redactor());
    assert!(text.contains("version:   0.1.0"));
    assert!(text.contains(std::env::consts::OS));
    assert!(text.contains("2026-09-26T12:01:02Z"));
    assert!(text.contains("location:  src/lib.rs:42:9"));
    assert!(text.contains("index out of bounds"));
    assert!(text.contains("0: frame_one"));
}

#[test]
fn a_report_is_redacted() {
    let mut d = details("connect alice@db.example.com password=hunter2 from 10.1.2.3");
    d.backtrace = "0: at /Users/alice/src/x.rs".into();
    let text = render_report(&d, at(0), &redactor());
    for leak in ["alice", "hunter2", "10.1.2.3", "example.com"] {
        assert!(!text.contains(leak), "{leak} leaked: {text}");
    }
    assert!(text.contains("~/src/x.rs"));
}

#[test]
fn an_oversized_message_is_truncated() {
    let big = "A".repeat(MAX_MESSAGE_BYTES * 3);
    let text = render_report(&details(&big), at(0), &redactor());
    assert!(text.len() < MAX_MESSAGE_BYTES * 2);
    assert!(text.contains("[truncated"));
}

#[test]
fn a_missing_backtrace_is_marked() {
    let mut d = details("boom");
    d.backtrace = "disabled backtrace".into();
    assert!(render_report(&d, at(0), &redactor()).contains("(not captured)"));
}

#[test]
fn write_report_creates_the_directory_and_lists_it() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("nested").join(CRASH_DIR_NAME);
    let path = write_report(&dir, &details("boom"), SystemTime::now(), &redactor()).unwrap();
    assert!(path.exists());
    let listed = list_reports(&dir);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].path, path);
    assert!(listed[0].size > 0);
}

#[test]
fn list_ignores_non_report_files_and_sorts_newest_first() {
    let tmp = tempfile::tempdir().unwrap();
    touch(tmp.path(), "crash-20260101T000000Z-1.txt");
    touch(tmp.path(), "crash-20260301T000000Z-1.txt");
    touch(tmp.path(), "notes.txt");
    touch(tmp.path(), ".notified");
    let names: Vec<String> = list_reports(tmp.path()).into_iter().map(|r| r.name).collect();
    assert_eq!(
        names,
        vec!["crash-20260301T000000Z-1.txt", "crash-20260101T000000Z-1.txt"]
    );
    assert!(list_reports(&tmp.path().join("missing")).is_empty());
}

#[test]
fn prune_bounds_the_report_count() {
    let tmp = tempfile::tempdir().unwrap();
    for i in 0..15 {
        touch(tmp.path(), &format!("crash-202601{:02}T000000Z-1.txt", i + 1));
    }
    let deleted = prune(tmp.path(), MAX_REPORTS, MAX_REPORT_AGE, SystemTime::now()).unwrap();
    assert_eq!(deleted, 5);
    let left = list_reports(tmp.path());
    assert_eq!(left.len(), MAX_REPORTS);
    // The newest survive.
    assert_eq!(left[0].name, "crash-20260115T000000Z-1.txt");
}

#[test]
fn prune_drops_reports_older_than_the_age_limit() {
    let tmp = tempfile::tempdir().unwrap();
    touch(tmp.path(), "crash-20260101T000000Z-1.txt");
    let later = SystemTime::now() + MAX_REPORT_AGE + Duration::from_secs(60);
    assert_eq!(prune(tmp.path(), MAX_REPORTS, MAX_REPORT_AGE, later).unwrap(), 1);
    assert!(list_reports(tmp.path()).is_empty());
    // A fresh report is kept.
    touch(tmp.path(), "crash-20260102T000000Z-1.txt");
    assert_eq!(
        prune(tmp.path(), MAX_REPORTS, MAX_REPORT_AGE, SystemTime::now()).unwrap(),
        0
    );
}

#[test]
fn write_report_enforces_the_bound_itself() {
    let tmp = tempfile::tempdir().unwrap();
    for i in 0..MAX_REPORTS {
        touch(tmp.path(), &format!("crash-200001{:02}T000000Z-1.txt", i + 1));
    }
    write_report(tmp.path(), &details("boom"), SystemTime::now(), &redactor()).unwrap();
    assert_eq!(list_reports(tmp.path()).len(), MAX_REPORTS);
}

#[test]
fn notice_is_pending_until_acknowledged_and_again_after_a_new_crash() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(pending_notice(tmp.path()).is_none());
    touch(tmp.path(), "crash-20260101T000000Z-1.txt");
    assert_eq!(
        pending_notice(tmp.path()).unwrap().name,
        "crash-20260101T000000Z-1.txt"
    );
    acknowledge(tmp.path()).unwrap();
    assert!(pending_notice(tmp.path()).is_none());
    touch(tmp.path(), "crash-20260102T000000Z-1.txt");
    assert!(pending_notice(tmp.path()).is_some());
}

#[test]
fn read_report_refuses_paths_outside_the_directory() {
    let tmp = tempfile::tempdir().unwrap();
    touch(tmp.path(), "crash-20260101T000000Z-1.txt");
    assert_eq!(
        read_report(tmp.path(), "crash-20260101T000000Z-1.txt").unwrap(),
        "x"
    );
    for bad in ["../secret.txt", "crash-../../x.txt", "notes.txt", "crash-a/b.txt"] {
        assert!(read_report(tmp.path(), bad).is_err(), "{bad} accepted");
    }
}
