//! Unit tests for the host side of the ABI 1.1 host context (#3576): the
//! runner log pipeline and the plugin data directory.

use super::*;
use crate::plugin::log_rate_limit::LogRateLimitConfig;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A limiter whose clock never advances, so the burst never refills.
fn frozen_limiter(burst: u32) -> Arc<PluginLogLimiter> {
    let t0 = Instant::now();
    Arc::new(PluginLogLimiter::with_clock(
        LogRateLimitConfig {
            burst,
            lines_per_sec: 20,
            summary_interval: Duration::from_secs(1),
        },
        Box::new(move || t0),
    ))
}

#[test]
fn sanitize_strips_control_characters_replaces_bad_utf8_and_marks_truncation() {
    assert_eq!(sanitize_log_message(b"plain", false), "plain");
    assert_eq!(
        sanitize_log_message(b"line1\nfake [plugin] line2\r\x1b[31m", false),
        "line1 fake [plugin] line2  [31m"
    );
    assert_eq!(
        sanitize_log_message(b"bad \xff byte", false),
        "bad \u{fffd} byte"
    );
    assert_eq!(sanitize_log_message(b"cut", true), "cut …[truncated]");
    // Truncating mid-codepoint degrades to a replacement char, never a panic.
    let euro = "€".as_bytes();
    assert_eq!(
        sanitize_log_message(&euro[..2], true),
        "\u{fffd} …[truncated]"
    );
}

/// Forward `n` runner log lines of plugin `id` through `limiter`.
fn log_n(limiter: &PluginLogLimiter, id: &str, n: usize) {
    for _ in 0..n {
        emit_runner_log(limiter, id, 3, b"flood", false);
    }
}

#[test]
fn a_runner_log_flood_is_dropped_past_the_burst() {
    let limiter = frozen_limiter(5);
    log_n(&limiter, "echo", 50);
    assert_eq!(limiter.pending_suppressed(), 45, "5 accepted, 45 dropped");
}

#[test]
fn an_unknown_runner_log_level_is_dropped_without_charging_the_budget() {
    let limiter = frozen_limiter(1);
    for bad in [0, 6, u32::MAX] {
        emit_runner_log(&limiter, "echo", bad, b"x", false);
    }
    assert_eq!(limiter.pending_suppressed(), 0);
    // The budget is intact: the one valid line is accepted, the next dropped.
    log_n(&limiter, "echo", 2);
    assert_eq!(limiter.pending_suppressed(), 1);
}

#[test]
fn an_oversized_runner_log_line_is_bounded() {
    // A runner that forwards more than the bound is cut at the bound, never
    // panics, and still costs one line.
    let limiter = frozen_limiter(5);
    let long = vec![b'a'; MAX_LOG_MESSAGE_BYTES * 2];
    emit_runner_log(&limiter, "echo", 3, &long, true);
    assert_eq!(limiter.pending_suppressed(), 0);
}

#[test]
fn a_flooding_plugin_does_not_starve_another_plugin() {
    let noisy = frozen_limiter(5);
    let quiet = frozen_limiter(5);
    log_n(&noisy, "noisy", 1000);
    log_n(&quiet, "quiet", 5);
    assert_eq!(noisy.pending_suppressed(), 995);
    assert_eq!(
        quiet.pending_suppressed(),
        0,
        "the quiet plugin's burst is intact"
    );
}

#[test]
fn log_lines_are_tagged_with_the_host_trusted_id() {
    assert_eq!(compose_plugin_log("echo", "hi"), "[echo] hi");
}

#[test]
fn data_dir_is_created_private_contained_and_stable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = prepare_plugin_data_dir(tmp.path(), "echo-backend").unwrap();
    let path = Path::new(&dir);
    assert!(path.is_dir());
    assert!(path.ends_with(Path::new(PLUGIN_DATA_DIR_NAME).join("echo-backend")));
    // Idempotent: a second call returns the same directory.
    assert_eq!(
        prepare_plugin_data_dir(tmp.path(), "echo-backend").unwrap(),
        dir
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

#[test]
fn data_dir_refuses_ids_that_could_escape() {
    let tmp = tempfile::TempDir::new().unwrap();
    for bad in ["", "..", "../x", "a/b", "a\\b", "UPPER", ".data"] {
        assert!(
            matches!(
                prepare_plugin_data_dir(tmp.path(), bad),
                Err(PluginDataDirError::InvalidId(_))
            ),
            "{bad:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn data_dir_refuses_a_symlink_planted_in_its_place() {
    let tmp = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join(PLUGIN_DATA_DIR_NAME)).unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        tmp.path().join(PLUGIN_DATA_DIR_NAME).join("echo"),
    )
    .unwrap();
    assert!(matches!(
        prepare_plugin_data_dir(tmp.path(), "echo"),
        Err(PluginDataDirError::NotADirectory(_))
    ));

    // Removing it unlinks the symlink without touching the target.
    std::fs::write(outside.path().join("keep"), b"x").unwrap();
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    assert!(outside.path().join("keep").exists());
    assert!(!tmp.path().join(PLUGIN_DATA_DIR_NAME).join("echo").exists());
}

#[test]
fn remove_data_dir_deletes_it_and_tolerates_absence() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = prepare_plugin_data_dir(tmp.path(), "echo").unwrap();
    std::fs::write(Path::new(&dir).join("state.json"), b"{}").unwrap();
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    assert!(!Path::new(&dir).exists());
    remove_plugin_data_dir(tmp.path(), "echo").unwrap();
    remove_plugin_data_dir(tmp.path(), "../nope").unwrap();
}
