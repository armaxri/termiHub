use std::fs;
use std::time::{Duration, SystemTime};

use super::*;
use crate::diagnostics::file_log::AGENT_LOG_FAMILY as FAMILY;
use crate::diagnostics::redact::{RedactionContext, Redactor};

fn redactor() -> Redactor {
    Redactor::new(RedactionContext {
        home_dirs: vec!["/home/alice".into()],
        usernames: vec!["alice".into()],
        hostnames: vec!["build-box".into()],
    })
}

fn set_mtime(path: &Path, secs_ago: u64) {
    let t = SystemTime::now() - Duration::from_secs(secs_ago);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(t)
        .unwrap();
}

#[test]
fn plain_log_names_of_the_family_are_accepted() {
    for name in [
        "termihub-agent.log",
        "termihub-agent-stdio-4242.log",
        "termihub-agent-stdio-4242.2.log",
        "termihub-agent-stderr-registry.log",
        "termihub-agent-stderr-daemon-0b7e2c1a-9f3d-4c1e-8a2b-1c2d3e4f5a6b.log",
    ] {
        assert!(is_plain_log_name(name, FAMILY), "{name}");
    }
}

#[test]
fn untrusted_names_outside_the_family_or_with_paths_are_rejected() {
    for name in [
        "",
        "termihub-agent",
        "termihub-agent-stdio-1.txt",
        "termihub.log",
        "termihub-agentx.log",
        "termihub-agent-.log",
        "../termihub-agent-stdio-1.log",
        "logs/termihub-agent-stdio-1.log",
        "logs\\termihub-agent-stdio-1.log",
        "termihub-agent-..-1.log",
        "termihub-agent-stdio 1.log",
        "termihub-agent-stdio-\u{e9}.log",
        "termihub-agent-stdio-1.log\0",
        "crash-20260926T120102Z-4242.txt",
    ] {
        assert!(!is_plain_log_name(name, FAMILY), "{name:?}");
    }
    let long = format!("termihub-agent-{}.log", "a".repeat(MAX_LOG_NAME_LEN));
    assert!(!is_plain_log_name(&long, FAMILY));
}

#[test]
fn listing_returns_the_family_newest_first_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    for (name, age) in [
        ("termihub-agent-stdio-1.log", 300),
        ("termihub-agent-stdio-1.1.log", 600),
        ("termihub-agent-registry-2.log", 10),
        ("termihub-agent-stderr-registry.log", 100),
    ] {
        let p = dir.path().join(name);
        fs::write(&p, "line\n").unwrap();
        set_mtime(&p, age);
    }
    fs::write(dir.path().join("termihub.log"), "desktop").unwrap();
    fs::write(dir.path().join("notes.txt"), "x").unwrap();
    fs::create_dir(dir.path().join("termihub-agent-dir.log")).unwrap();

    let names: Vec<String> = list_family(dir.path(), FAMILY)
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(
        names,
        [
            "termihub-agent-registry-2.log",
            "termihub-agent-stderr-registry.log",
            "termihub-agent-stdio-1.log",
            "termihub-agent-stdio-1.1.log",
        ]
    );
}

#[test]
fn listing_a_missing_directory_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(list_family(&dir.path().join("nope"), FAMILY).is_empty());
}

#[test]
fn listing_is_capped() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..(MAX_REMOTE_LOGS + 5) {
        fs::write(
            dir.path().join(format!("termihub-agent-stdio-{i}.log")),
            "x",
        )
        .unwrap();
    }
    assert_eq!(list_family(dir.path(), FAMILY).len(), MAX_REMOTE_LOGS);
}

#[cfg(unix)]
#[test]
fn symlinks_are_never_listed_or_read() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    fs::write(&secret, "top secret").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("termihub-agent-stdio-9.log")).unwrap();
    assert!(list_family(dir.path(), FAMILY).is_empty());
    let err = read_listed_log(
        dir.path(),
        FAMILY,
        "termihub-agent-stdio-9.log",
        MAX_REMOTE_LOG_BYTES,
        &redactor(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn reading_redacts_and_returns_small_files_whole() {
    let dir = tempfile::tempdir().unwrap();
    let name = "termihub-agent-stdio-7.log";
    fs::write(
        dir.path().join(name),
        "INFO connect alice@build-box password=hunter2 from /home/alice/x\n",
    )
    .unwrap();
    let (text, truncated) =
        read_listed_log(dir.path(), FAMILY, name, MAX_REMOTE_LOG_BYTES, &redactor()).unwrap();
    assert!(!truncated);
    assert!(text.starts_with("INFO connect"));
    for leaked in ["alice", "build-box", "hunter2"] {
        assert!(!text.contains(leaked), "{leaked} leaked: {text}");
    }
}

#[test]
fn reading_an_over_long_file_keeps_whole_newest_lines() {
    let dir = tempfile::tempdir().unwrap();
    let name = "termihub-agent-stdio-7.log";
    let body: String = (0..200).map(|i| format!("line {i:04} ok\n")).collect();
    fs::write(dir.path().join(name), &body).unwrap();
    let (text, truncated) = read_listed_log(dir.path(), FAMILY, name, 100, &redactor()).unwrap();
    assert!(truncated);
    let rest = text.strip_prefix(TAIL_CUT_MARKER).expect("marker");
    assert!(rest.len() <= 100);
    assert!(rest.ends_with("line 0199 ok\n"));
    assert!(
        rest.starts_with("line "),
        "starts on a whole line: {rest:?}"
    );
}

#[test]
fn a_cut_exactly_on_a_line_boundary_keeps_that_line() {
    let dir = tempfile::tempdir().unwrap();
    let name = "termihub-agent-stdio-7.log";
    // 14-byte lines: a 28-byte window holds exactly the last two lines.
    fs::write(
        dir.path().join(name),
        "line 0 ok....\nline 1 ok....\nline 2 ok....\n",
    )
    .unwrap();
    let (text, truncated) = read_listed_log(dir.path(), FAMILY, name, 28, &redactor()).unwrap();
    assert!(truncated);
    assert_eq!(
        text,
        format!("{TAIL_CUT_MARKER}line 1 ok....\nline 2 ok....\n")
    );
}

#[test]
fn reading_rejects_bad_names_and_unlisted_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("termihub.log"), "desktop").unwrap();
    let bad = read_listed_log(
        dir.path(),
        FAMILY,
        "../termihub.log",
        MAX_REMOTE_LOG_BYTES,
        &redactor(),
    )
    .unwrap_err();
    assert_eq!(bad.kind(), io::ErrorKind::InvalidInput);
    let missing = read_listed_log(
        dir.path(),
        FAMILY,
        "termihub-agent-stdio-1.log",
        MAX_REMOTE_LOG_BYTES,
        &redactor(),
    )
    .unwrap_err();
    assert_eq!(missing.kind(), io::ErrorKind::NotFound);
}

#[test]
fn cap_tail_respects_char_boundaries() {
    let (text, cut) = cap_tail("ääää".to_string(), 3);
    assert!(cut);
    assert_eq!(text, "ä");
    let (same, cut) = cap_tail("short\n".to_string(), 100);
    assert!(!cut);
    assert_eq!(same, "short\n");
}
