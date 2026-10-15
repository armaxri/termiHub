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
        git_hash: "663465d52".into(),
        thread: Some("main".into()),
        location: Some("src/lib.rs:42:9".into()),
        message: message.into(),
        backtrace: "0: frame_one\n1: frame_two".into(),
        image: None,
        modules: Vec::new(),
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
    let text = render_report(
        &details("index out of bounds"),
        at(1_790_424_062),
        &redactor(),
    );
    assert!(text.contains("version:   0.1.0"));
    // The commit pins the report to the exact build (#4316); a short hash must
    // survive redaction.
    assert!(text.contains("commit:    663465d52"), "{text}");
    assert!(text.contains(std::env::consts::OS));
    assert!(text.contains("2026-09-26T12:01:02Z"));
    assert!(text.contains("location:  src/lib.rs:42:9"));
    assert!(text.contains("index out of bounds"));
    assert!(text.contains("0: frame_one"));
}

#[test]
fn a_report_without_a_commit_says_unknown() {
    let mut d = details("boom");
    d.git_hash = String::new();
    let text = render_report(&d, at(0), &redactor());
    assert!(text.contains("commit:    unknown"), "{text}");
}

#[test]
fn capture_reads_payload_location_and_backtrace_inside_a_hook() {
    use std::sync::{Arc, Mutex};

    // The hook is process-global and tests run in parallel, so record only the
    // panic of this test's own named thread, then restore the previous hook.
    let seen: Arc<Mutex<Option<CrashDetails>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().name() != Some("capture-probe") {
            return;
        }
        let d = CrashDetails::capture(info, "probe", "9.9.9", "abc1234");
        *sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(d);
    }));
    let result = std::thread::Builder::new()
        .name("capture-probe".into())
        .spawn(|| panic!("boom {}", 42))
        .unwrap()
        .join();
    std::panic::set_hook(previous);
    assert!(result.is_err());

    let d = seen.lock().unwrap().take().expect("hook ran");
    assert_eq!(d.app, "probe");
    assert_eq!(d.version, "9.9.9");
    assert_eq!(d.git_hash, "abc1234");
    assert_eq!(d.message, "boom 42");
    assert_eq!(d.thread.as_deref(), Some("capture-probe"));
    assert!(
        d.location
            .as_deref()
            .is_some_and(|l| l.contains("crash_report_tests.rs")),
        "{:?}",
        d.location
    );
    assert!(!d.backtrace.is_empty());
    // Full format (#4504): every frame carries its address for offline
    // symbolization.
    assert!(d.backtrace.contains(" - "), "{}", d.backtrace);
    assert!(d.backtrace.contains("0x"), "{}", d.backtrace);
}

#[test]
fn a_report_records_the_module_image_for_offline_symbolization() {
    use crate::diagnostics::module_image::{BuildId, ModuleImage};

    let mut d = details("boom");
    let text = render_report(&d, at(0), &redactor());
    assert!(text.contains("image:     unknown"), "{text}");

    // Every build-id shape must survive redaction: a 40-digit hex run would be
    // masked as a token, so the GNU id is grouped.
    let id: Vec<u8> = (0xa0..0xb4).collect();
    for (build_id, shown) in [
        (
            BuildId::MachoUuid([0x4c; 16]),
            "uuid 4C4C4C4C-4C4C-4C4C-4C4C-4C4C4C4C4C4C",
        ),
        (
            BuildId::Gnu(id),
            "build-id a0a1a2a3 a4a5a6a7 a8a9aaab acadaeaf b0b1b2b3",
        ),
        (
            BuildId::Pdb {
                guid: [0x11; 16],
                age: 1,
            },
            "pdb 11111111-1111-1111-1111-111111111111 age 1",
        ),
    ] {
        d.image = Some(ModuleImage {
            base: 0x5555_0000,
            build_id: Some(build_id),
        });
        let text = render_report(&d, at(0), &redactor());
        assert!(text.contains("image:     base 0x"), "{text}");
        assert!(text.contains("5555"), "{text}");
        assert!(text.contains(shown), "{shown} missing: {text}");
    }
}

#[test]
fn a_captured_report_names_this_module() {
    // capture() fills the image in; on a supported platform it is present.
    if cfg!(any(target_vendor = "apple", target_os = "linux", windows)) {
        let image = crate::diagnostics::module_image::ModuleImage::current();
        assert!(image.is_some());
    }
}

fn module(name: &str, base: usize, size: usize) -> LoadedModule {
    LoadedModule {
        name: name.into(),
        base,
        size,
        build_id: None,
    }
}

#[test]
fn a_report_lists_the_loaded_modules_sorted_and_marks_frame_holders() {
    use crate::diagnostics::module_image::BuildId;

    let mut d = details("boom");
    assert!(render_report(&d, at(0), &redactor()).contains("modules:   unknown"));

    d.backtrace = "   0:     0x7f0000001234 - <unknown>\n   1:     0x10000a000 - main".into();
    let mut libc_so = module("libc.so.6", 0x7f00_0000_0000, 0x20_0000);
    libc_so.build_id = Some(BuildId::Gnu((0..20).collect()));
    d.modules = vec![
        module("termihub", 0x1_0000_0000, 0x10_0000),
        libc_so,
        module("libssl.so.3", 0x7e00_0000_0000, 0x1000),
        module("ntdll.dll", 0x7ffd_0000_0000, 0x1000),
        module("libsystem_kernel.dylib", 0x1_9000_0000, 0x1000),
    ];
    let text = render_report(&d, at(0), &redactor());
    let section: Vec<&str> = text
        .lines()
        .skip_while(|l| !l.starts_with("modules:"))
        .take_while(|l| !l.is_empty())
        .collect();
    let w = 2 * std::mem::size_of::<usize>();
    assert_eq!(
        section,
        [
            "modules:   5 loaded (base, size, name, build id; * = holds a backtrace frame)"
                .to_string(),
            format!(
                "* 0x{:0w$x} 0x00100000 termihub no build id",
                0x1_0000_0000_u64
            ),
            format!(
                "  0x{:0w$x} 0x00001000 libsystem_kernel.dylib no build id",
                0x1_9000_0000_u64
            ),
            format!(
                "  0x{:0w$x} 0x00001000 libssl.so.3 no build id",
                0x7e00_0000_0000_u64
            ),
            format!(
                "* 0x{:0w$x} 0x00200000 libc.so.6 build-id 00010203 04050607 08090a0b 0c0d0e0f \
                 10111213",
                0x7f00_0000_0000_u64
            ),
            format!(
                "  0x{:0w$x} 0x00001000 ntdll.dll no build id",
                0x7ffd_0000_0000_u64
            ),
        ],
        "{text}"
    );
}

#[test]
fn the_module_list_is_capped_and_keeps_frame_holders() {
    let mut d = details("boom");
    // More modules than either cap allows; the one holding the frame is last.
    let n = MAX_MODULES * 2;
    d.modules = (0..n)
        .map(|i| {
            module(
                &format!("libmodule{i:05}.so"),
                0x1000_0000 + i * 0x1_0000,
                0x1000,
            )
        })
        .collect();
    let last = 0x1000_0000 + (n - 1) * 0x1_0000;
    d.backtrace = format!("   0:     {:#x} - <unknown>", last + 0x10);
    let section = render_modules(&d.modules, &d.backtrace);
    assert!(
        section.len() <= MAX_MODULES_BYTES + 200,
        "{}",
        section.len()
    );
    let listed = section.lines().filter(|l| l.contains("libmodule")).count();
    assert!(listed <= MAX_MODULES, "{listed}");
    assert!(listed > 100, "{listed}");
    assert!(
        section.contains(&format!(
            "* {:#0w$x}",
            last,
            w = 2 + 2 * std::mem::size_of::<usize>()
        )),
        "the frame-holding module was dropped"
    );
    assert!(section.ends_with(&format!("[{} more modules omitted]", n - listed)));
    // The whole report still fits what a remote reader serves.
    d.backtrace = "x".repeat(MAX_BACKTRACE_BYTES * 2);
    d.message = "m".repeat(MAX_MESSAGE_BYTES * 2);
    let text = render_report(&d, at(0), &redactor());
    assert!(
        (text.len() as u64) < MAX_REMOTE_REPORT_BYTES,
        "{}",
        text.len()
    );
}

#[test]
fn module_names_are_redaction_safe() {
    use crate::diagnostics::module_image::module_file_name;

    let mut d = details("boom");
    d.modules = vec![
        module(
            &module_file_name("/Users/alice/Library/plugin.dylib"),
            0x1000,
            0x10,
        ),
        module(
            &module_file_name(r"C:\Users\alice\AppData\x.dll"),
            0x2000,
            0x10,
        ),
        module(&module_file_name("/home/alice/alice-tool"), 0x3000, 0x10),
    ];
    let text = render_report(&d, at(0), &redactor());
    assert!(!text.contains("alice"), "{text}");
    assert!(
        !text.contains("/Users") && !text.contains("AppData"),
        "{text}"
    );
    assert!(
        text.contains(" plugin.dylib ") && text.contains(" x.dll "),
        "{text}"
    );
}

#[cfg(any(target_vendor = "apple", target_os = "linux", windows))]
#[test]
fn a_captured_report_lists_this_module() {
    let modules = crate::diagnostics::module_image::loaded_modules();
    let here = a_captured_report_lists_this_module as fn() as usize;
    let mut d = details("boom");
    d.backtrace = format!("   0:     {here:#x} - here");
    d.modules = modules;
    let section = render_modules(&d.modules, &d.backtrace);
    let marked: Vec<&str> = section.lines().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1, "{section}");
    assert!(marked[0].contains("termihub"), "{section}");
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
    let names: Vec<String> = list_reports(tmp.path())
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(
        names,
        vec![
            "crash-20260301T000000Z-1.txt",
            "crash-20260101T000000Z-1.txt"
        ]
    );
    assert!(list_reports(&tmp.path().join("missing")).is_empty());
}

#[test]
fn prune_bounds_the_report_count() {
    let tmp = tempfile::tempdir().unwrap();
    for i in 0..15 {
        touch(
            tmp.path(),
            &format!("crash-202601{:02}T000000Z-1.txt", i + 1),
        );
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
    assert_eq!(
        prune(tmp.path(), MAX_REPORTS, MAX_REPORT_AGE, later).unwrap(),
        1
    );
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
        touch(
            tmp.path(),
            &format!("crash-200001{:02}T000000Z-1.txt", i + 1),
        );
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
    for bad in [
        "../secret.txt",
        "crash-../../x.txt",
        "notes.txt",
        "crash-a/b.txt",
    ] {
        assert!(read_report(tmp.path(), bad).is_err(), "{bad} accepted");
    }
}

#[test]
fn read_listed_report_serves_only_listed_reports() {
    let tmp = tempfile::tempdir().unwrap();
    touch(tmp.path(), "crash-20260101T000000Z-1.txt");
    fs::write(tmp.path().join("notes.txt"), "private").unwrap();
    let (text, truncated) =
        read_listed_report(tmp.path(), "crash-20260101T000000Z-1.txt", 1024).unwrap();
    assert_eq!(text, "x");
    assert!(!truncated);
    for bad in [
        "../secret.txt",
        "crash-../../x.txt",
        "notes.txt",
        "crash-a/b.txt",
        "crash-a\\b.txt",
        "crash-\u{1F600}.txt",
        "",
    ] {
        assert!(
            read_listed_report(tmp.path(), bad, 1024).is_err(),
            "{bad:?} accepted"
        );
    }
    // Well-formed but not in the listing.
    let missing = read_listed_report(tmp.path(), "crash-20260102T000000Z-1.txt", 1024);
    assert_eq!(missing.unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn read_listed_report_ignores_symlinked_reports() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "private").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret"),
        tmp.path().join("crash-20260101T000000Z-1.txt"),
    )
    .unwrap();
    assert!(read_listed_report(tmp.path(), "crash-20260101T000000Z-1.txt", 1024).is_err());
}

#[test]
fn read_listed_report_caps_the_size() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(
        tmp.path().join("crash-20260101T000000Z-1.txt"),
        "a".repeat(100),
    )
    .unwrap();
    let (text, truncated) =
        read_listed_report(tmp.path(), "crash-20260101T000000Z-1.txt", 10).unwrap();
    assert_eq!(text.len(), 10);
    assert!(truncated);
    let (text, truncated) =
        read_listed_report(tmp.path(), "crash-20260101T000000Z-1.txt", 100).unwrap();
    assert_eq!(text.len(), 100);
    assert!(!truncated);
}

#[test]
fn plain_report_names_are_validated() {
    assert!(is_plain_report_name("crash-20260926T120102Z-4242.txt"));
    assert!(!is_plain_report_name("crash-x/../y.txt"));
    assert!(!is_plain_report_name("crash- spaced.txt"));
    assert!(!is_plain_report_name(&format!(
        "crash-{}.txt",
        "a".repeat(200)
    )));
}
