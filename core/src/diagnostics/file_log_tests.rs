use std::fs;
use std::io::Write;
use std::path::Path;

use tracing_subscriber::fmt::MakeWriter;

use super::*;

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn open(dir: &Path, max_bytes: u64, max_files: usize) -> RotatingLogFile {
    RotatingLogFile::new(dir, "app", max_bytes, max_files).unwrap()
}

fn total_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Run `f` under a thread-scoped `subscriber`, deterministically.
///
/// `tracing-core` caches callsite interest globally and, while at most one
/// dispatcher is registered, computes it lock-free from the registering
/// thread's default only — so a parallel test can cache a shared callsite as
/// `never` for another test's subscriber. Two never-dropped no-op dispatchers
/// keep the registry off that fast path.
fn with_scoped_subscriber<S, T>(subscriber: S, f: impl FnOnce() -> T) -> T
where
    S: tracing::Subscriber + Send + Sync + 'static,
{
    use tracing::subscriber::NoSubscriber;
    use tracing::Dispatch;
    static PINNED: std::sync::OnceLock<[Dispatch; 2]> = std::sync::OnceLock::new();
    PINNED.get_or_init(|| {
        [
            Dispatch::new(NoSubscriber::default()),
            Dispatch::new(NoSubscriber::default()),
        ]
    });
    tracing::subscriber::with_default(subscriber, f)
}

// ── Basic writer behavior ───────────────────────────────────────────

#[test]
fn writes_land_in_the_live_file_named_by_the_stem() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 1024, 3);

    log.make_writer().write_all(b"hello\n").unwrap();

    assert_eq!(read(&dir.path().join("app.log")), "hello\n");
    assert_eq!(log.path(), dir.path().join("app.log"));
}

#[test]
fn creates_the_log_directory_if_absent() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("deep").join("nested");

    open(&nested, 1024, 3);

    assert!(nested.join("app.log").exists());
}

#[test]
fn an_unwritable_directory_is_an_error_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("not-a-dir");
    fs::write(&blocker, "file in the way").unwrap();

    assert!(RotatingLogFile::new(blocker.join("logs"), "app", 1024, 3).is_err());
}

#[test]
fn reopening_appends_rather_than_truncating() {
    let dir = tempfile::tempdir().unwrap();

    let first = open(dir.path(), 1024, 3);
    first.make_writer().write_all(b"run one\n").unwrap();
    drop(first);

    let second = open(dir.path(), 1024, 3);
    second.make_writer().write_all(b"run two\n").unwrap();

    assert_eq!(read(&dir.path().join("app.log")), "run one\nrun two\n");
}

// ── Rotation caps size and count ────────────────────────────────────

#[test]
fn rotates_once_the_size_cap_is_exceeded() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 10, 3);

    log.make_writer().write_all(b"aaaaa\n").unwrap(); // 6 bytes, fits
    log.make_writer().write_all(b"bbbbb\n").unwrap(); // would be 12 > 10

    assert_eq!(read(&dir.path().join("app.log")), "bbbbb\n");
    assert_eq!(read(&dir.path().join("app.1.log")), "aaaaa\n");
}

#[test]
fn rotation_never_splits_a_single_event() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 10, 3);

    log.make_writer().write_all(b"aaaaa\n").unwrap();
    log.make_writer().write_all(b"a-very-long-event\n").unwrap();

    assert_eq!(read(&dir.path().join("app.log")), "a-very-long-event\n");
}

#[test]
fn generations_shift_and_the_oldest_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 10, 3);

    for line in ["one\n", "two\n", "three\n", "four\n"] {
        log.make_writer().write_all(line.as_bytes()).unwrap();
        log.make_writer().write_all(b"pad-to-force\n").unwrap();
    }

    assert_eq!(
        file_names(dir.path()),
        vec!["app.1.log", "app.2.log", "app.log"]
    );
}

#[test]
fn total_disk_usage_stays_bounded_under_sustained_writes() {
    let dir = tempfile::tempdir().unwrap();
    let (max_bytes, max_files) = (256, 3);
    let log = open(dir.path(), max_bytes, max_files);

    for i in 0..2000 {
        log.make_writer()
            .write_all(format!("event number {i} padding\n").as_bytes())
            .unwrap();
    }

    // Each file may overshoot by at most one event.
    let ceiling = (max_bytes + 64) * max_files as u64;
    let total = total_bytes(dir.path());
    assert!(total <= ceiling, "log grew to {total} B, above {ceiling} B");
    assert_eq!(file_names(dir.path()).len(), max_files);
}

#[test]
fn a_cap_of_one_file_truncates_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 10, 1);

    log.make_writer().write_all(b"aaaaa\n").unwrap();
    log.make_writer().write_all(b"bbbbb\n").unwrap();

    assert_eq!(read(&dir.path().join("app.log")), "bbbbb\n");
    assert!(!dir.path().join("app.1.log").exists());
}

// ── Self-healing: a renamed or deleted live file is reopened ────────

#[test]
fn a_live_file_deleted_underneath_the_writer_is_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 1024, 3);
    log.make_writer().write_all(b"before\n").unwrap();

    fs::remove_file(dir.path().join("app.log")).unwrap();
    log.make_writer().write_all(b"after\n").unwrap();

    assert_eq!(
        read(&dir.path().join("app.log")),
        "after\n",
        "a write after the live file vanished must not go into an unlinked inode"
    );
}

#[test]
fn a_writer_whose_file_another_writer_rotated_follows_the_live_path() {
    // OBS2-002: two writers sharing one path. When A rotates, B's handle points
    // at the archive; B's next write must land in the new live file, and no
    // line may be lost even after enough rotations to delete B's old inode.
    let dir = tempfile::tempdir().unwrap();
    let a = open(dir.path(), 64, 3);
    let b = open(dir.path(), 64, 3);

    let mut expected = Vec::new();
    for i in 0..40 {
        let (writer, who) = if i % 2 == 0 { (&a, "a") } else { (&b, "b") };
        let line = format!("{who}-line-{i:03}-padding\n");
        writer.make_writer().write_all(line.as_bytes()).unwrap();
        expected.push(line);
    }

    // Writes alternate strictly, so with both writers following the live path
    // the retained generations, oldest first, are one contiguous, in-order tail
    // of everything written — nothing went into a renamed or unlinked file.
    let retained: String = ["app.2.log", "app.1.log", "app.log"]
        .iter()
        .map(|n| read(&dir.path().join(n)))
        .collect();
    let everything: String = expected.concat();
    assert!(
        !retained.is_empty() && everything.ends_with(&retained),
        "retained logs are not an in-order tail of what was written:\n{retained}"
    );
    assert!(read(&dir.path().join("app.log")).ends_with(expected.last().unwrap().as_str()));
}

// ── Per-process files: concurrent writers never interleave ──────────

#[test]
fn per_process_files_keep_concurrent_writers_apart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let handles: Vec<_> = ["worker-1", "worker-2"]
        .into_iter()
        .map(|stem| {
            let path = path.clone();
            std::thread::spawn(move || {
                let log = RotatingLogFile::new(&path, stem, 1 << 20, 3).unwrap();
                for i in 0..500 {
                    log.make_writer()
                        .write_all(format!("{stem} {i}\n").as_bytes())
                        .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    for stem in ["worker-1", "worker-2"] {
        let content = read(&dir.path().join(format!("{stem}.log")));
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 500, "{stem} lost lines");
        for (i, line) in lines.iter().enumerate() {
            assert_eq!(*line, format!("{stem} {i}"), "{stem} interleaved");
        }
    }
}

// ── Log families and the directory budget ───────────────────────────

#[test]
fn per_process_stem_combines_family_role_and_pid() {
    assert_eq!(
        per_process_stem("termihub-agent", "daemon", 4242),
        "termihub-agent-daemon-4242"
    );
}

#[test]
fn family_files_lists_every_member_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "app.log",
        "app.1.log",
        "app-daemon-7.log",
        "app-daemon-7.1.log",
        "app-stdio-3.log",
        "apple.log",
        "app.txt",
        "other.log",
    ] {
        fs::write(dir.path().join(name), "x").unwrap();
    }
    fs::create_dir(dir.path().join("app-dir.log")).unwrap();

    let names: Vec<String> = family_files(dir.path(), "app")
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

    assert_eq!(
        names,
        vec![
            "app.log",
            "app.1.log",
            "app-daemon-7.log",
            "app-daemon-7.1.log",
            "app-stdio-3.log",
        ]
    );
}

#[test]
fn family_files_of_a_missing_directory_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(family_files(&dir.path().join("nope"), "app").is_empty());
}

fn set_age(path: &Path, secs_ago: u64) {
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(t)
        .unwrap();
}

#[test]
fn prune_family_drops_archives_before_live_files_and_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    // Three live files and two archives, 10 bytes each.
    for (name, age) in [
        ("app-a-1.log", 500),
        ("app-a-1.1.log", 100),
        ("app-b-2.log", 400),
        ("app-b-2.1.log", 300),
        ("app-c-3.log", 10),
    ] {
        fs::write(d.join(name), "0123456789").unwrap();
        set_age(&d.join(name), age);
    }

    // Budget of 30 bytes: two must go — both archives, never a live file.
    prune_family(d, "app", &[], 30, 100);
    assert_eq!(
        file_names(d),
        vec!["app-a-1.log", "app-b-2.log", "app-c-3.log"]
    );

    // A count cap of 2: the oldest live file goes next.
    prune_family(d, "app", &[], 1 << 20, 2);
    assert_eq!(file_names(d), vec!["app-b-2.log", "app-c-3.log"]);
}

#[test]
fn prune_family_never_deletes_the_callers_own_files() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("app-old-1.log"), "0123456789").unwrap();
    set_age(&d.join("app-old-1.log"), 1000);
    fs::write(d.join("app-me-2.log"), "0123456789").unwrap();
    set_age(&d.join("app-me-2.log"), 2000);

    prune_family(d, "app", &[d.join("app-me-2.log")], 10, 100);

    assert_eq!(file_names(d), vec!["app-me-2.log"]);
}

#[test]
fn a_family_budget_bounds_the_whole_directory_across_many_processes() {
    // Simulate many short-lived processes, each with its own stem.
    let dir = tempfile::tempdir().unwrap();
    let budget = FamilyBudget {
        prefix: "app".into(),
        max_total_bytes: 2048,
        max_files: 8,
    };
    for pid in 0..50 {
        let log = RotatingLogFile::new(dir.path(), &per_process_stem("app", "w", pid), 256, 3)
            .unwrap()
            .with_family_budget(budget.clone());
        for i in 0..30 {
            log.make_writer()
                .write_all(format!("pid {pid} event {i} padding padding\n").as_bytes())
                .unwrap();
        }
    }

    let files = family_files(dir.path(), "app");
    let total = total_bytes(dir.path());
    // The newest process's files are exempt from its own prune, so allow one
    // process's worth (3 × (256 + one event)) of slack above the budget.
    assert!(total <= 2048 + 3 * 320, "directory grew to {total} B");
    assert!(
        files.len() <= 8 + 3,
        "directory holds {} files",
        files.len()
    );
    assert!(
        dir.path().join("app-w-49.log").exists(),
        "the newest process's live file must survive"
    );
}

// ── russh clamp and the file filter ─────────────────────────────────

#[test]
fn russh_clamped_prepends_the_clamp() {
    assert_eq!(russh_clamped("debug"), "russh=warn,debug");
}

fn russh_debug_reaches_file(filter: EnvFilter) -> bool {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::Layer as _;

    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 1 << 20, 3);
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(log.clone())
            .with_filter(filter),
    );
    with_scoped_subscriber(subscriber, || {
        tracing::debug!(target: "russh", "packet cipher internals");
    });
    read(&dir.path().join("app.log")).contains("packet cipher internals")
}

#[test]
fn the_default_file_filter_clamps_russh() {
    assert!(!russh_debug_reaches_file(file_env_filter(None)));
}

#[test]
fn raising_file_detail_does_not_unclamp_russh() {
    assert!(!russh_debug_reaches_file(file_env_filter(Some("debug"))));
}

#[test]
fn an_explicit_russh_directive_still_wins() {
    assert!(russh_debug_reaches_file(file_env_filter(Some(
        "debug,russh=debug"
    ))));
}

#[test]
fn a_blank_or_invalid_override_falls_back_to_the_default() {
    assert_eq!(
        file_env_filter(Some("   ")).to_string(),
        file_env_filter(None).to_string()
    );
    assert_eq!(
        file_env_filter(Some("[[[not a directive")).to_string(),
        file_env_filter(None).to_string()
    );
}

#[test]
fn file_filter_keeps_info_and_drops_debug() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::Layer as _;

    let dir = tempfile::tempdir().unwrap();
    let log = open(dir.path(), 1 << 20, 3);
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(log.clone())
            .with_filter(file_env_filter(None)),
    );
    with_scoped_subscriber(subscriber, || {
        tracing::info!(target: "termihub::x", "session opened");
        tracing::debug!(target: "termihub::x", "per-event noise");
    });

    let contents = read(&dir.path().join("app.log"));
    assert!(contents.contains("session opened"));
    assert!(!contents.contains("per-event noise"));
}

// ── Capped stderr capture files ─────────────────────────────────────

#[test]
fn open_capped_appends_below_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stderr.log");
    fs::write(&path, "previous run\n").unwrap();

    let mut f = open_capped(&path, 1024).unwrap();
    f.write_all(b"this run\n").unwrap();

    assert_eq!(read(&path), "previous run\nthis run\n");
}

#[test]
fn open_capped_truncates_a_file_already_over_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stderr.log");
    fs::write(&path, vec![b'x'; 2048]).unwrap();

    let mut f = open_capped(&path, 1024).unwrap();
    f.write_all(b"fresh\n").unwrap();

    assert_eq!(read(&path), "fresh\n");
}

#[test]
fn enforce_cap_truncates_an_append_handle_that_outgrew_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stderr.log");
    let mut writer = open_capped(&path, 1024).unwrap();
    let watcher = writer.try_clone().unwrap();

    writer.write_all(&[b'x'; 1500]).unwrap();
    assert!(
        enforce_cap(&watcher, 1024).unwrap(),
        "over the cap: truncated"
    );
    writer.write_all(b"after\n").unwrap();

    assert_eq!(
        read(&path),
        "after\n",
        "an append handle must continue at the new end, not leave a hole"
    );
    assert!(
        !enforce_cap(&watcher, 1024).unwrap(),
        "under the cap: untouched"
    );
}
