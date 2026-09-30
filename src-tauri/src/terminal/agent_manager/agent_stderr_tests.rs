//! Tests for the desktop re-emit of the agent's framed stderr (#2854, OBS-004).

use std::io;
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;

use super::*;
use crate::utils::log_capture::{
    create_log_buffer, default_env_filter, test_support, LogCaptureLayer, LogEntry,
};

/// Run `f` with the desktop's LogViewer capture (behind the app's default
/// filter) as this thread's subscriber; return what it captured.
fn capture(f: impl FnOnce()) -> Vec<LogEntry> {
    let buffer = create_log_buffer();
    let subscriber = tracing_subscriber::registry()
        .with(default_env_filter())
        .with(LogCaptureLayer::new(buffer.clone()));
    test_support::with_scoped_subscriber(subscriber, f);
    let entries = buffer.lock().unwrap().get_recent(100);
    entries
}

fn framed(level: &str, target: &str, msg: &str, extra: &str) -> String {
    format!(
        "@termihub-log/1 {{\"ts\":\"2026-09-30T10:00:00.000000Z\",\"level\":\"{level}\",\
         \"target\":\"{target}\",\"msg\":\"{msg}\"{extra}}}\n"
    )
}

#[test]
fn framed_record_is_reemitted_at_its_real_level_and_target() {
    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-1");
        d.push(
            framed(
                "DEBUG",
                "termihub_agent::session::manager",
                "spawned daemon",
                "",
            )
            .as_bytes(),
        );
        d.push(framed("ERROR", "termihub_agent::io::stdio", "write failed", "").as_bytes());
    });
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert_eq!(entries[0].level, "DEBUG");
    assert_eq!(entries[0].target, "termihub_agent::session::manager");
    assert!(
        entries[0].message.starts_with("spawned daemon"),
        "{entries:?}"
    );
    assert!(entries[0].message.contains("agent_id=agent-1"));
    assert_eq!(entries[1].level, "ERROR");
    assert_eq!(entries[1].target, "termihub_agent::io::stdio");
}

#[test]
fn correlation_id_and_fields_are_carried() {
    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-1");
        d.push(
            framed(
                "INFO",
                "termihub_agent::handler::dispatch",
                "agent session created",
                ",\"cid\":\"desk-sid-1\",\"fields\":{\"session_id\":\"a-9\",\"type_id\":\"ssh\"}",
            )
            .as_bytes(),
        );
    });
    assert_eq!(entries.len(), 1, "{entries:?}");
    let m = &entries[0].message;
    assert!(m.contains("correlation_id=desk-sid-1"), "{m}");
    assert!(m.contains("session_id=a-9"), "{m}");
    assert!(m.contains("type_id=ssh"), "{m}");
}

#[test]
fn a_record_split_across_chunks_is_reassembled() {
    let line = framed("INFO", "termihub_agent::x", "split record", "");
    let (a, b) = line.as_bytes().split_at(20);
    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-1");
        d.push(a);
        d.push(b);
    });
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].level, "INFO");
    assert!(entries[0].message.starts_with("split record"));
}

#[test]
fn unframed_lines_fall_back_to_warn_passthrough() {
    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-1");
        d.push(b"thread 'main' panicked at src/main.rs:1:1:\nboom\n\n");
        // A trailing partial line only surfaces on flush.
        d.push(b"libc: no newline");
        d.flush();
    });
    assert_eq!(entries.len(), 3, "{entries:?}");
    assert!(entries.iter().all(|e| e.level == "WARN"));
    assert!(entries[0]
        .message
        .contains("agent process stderr: thread 'main' panicked"));
    assert!(entries[1].message.ends_with("boom"), "{entries:?}");
    assert!(
        entries[2].message.ends_with("libc: no newline"),
        "{entries:?}"
    );
}

#[test]
fn unframed_line_content_is_logged_in_the_message() {
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let writer = SharedBuf(buffer.clone());
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer),
    );
    test_support::with_scoped_subscriber(subscriber, || {
        reemit_line("agent-1", "libfoo: something odd\n");
    });
    let out = String::from_utf8(buffer.lock().unwrap().clone()).unwrap();
    assert!(out.contains("WARN"), "{out}");
    assert!(
        out.contains("agent process stderr: libfoo: something odd"),
        "{out}"
    );
    assert!(out.contains("agent_id=agent-1"), "{out}");
}

#[test]
fn future_framing_version_degrades_to_passthrough() {
    let entries = capture(|| {
        reemit_line(
            "agent-1",
            "@termihub-log/9 {\"ts\":\"t\",\"level\":\"DEBUG\",\"target\":\"a\",\"msg\":\"m\"}",
        );
    });
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].level, "WARN");
}

#[test]
fn unknown_level_is_surfaced_as_warn() {
    assert_eq!(frame_level("NOTICE"), Level::WARN);
    assert_eq!(frame_level("info"), Level::INFO);
    assert_eq!(frame_level("Warning"), Level::WARN);
}

#[test]
fn control_characters_cannot_forge_a_log_line() {
    assert_eq!(sanitize("a\nb\r\x1b[31m\tc", 100), "a\\nb\\r\\u{1b}[31m\tc");
    let entries = capture(|| {
        reemit_line(
            "agent-1",
            &framed("INFO", "termihub_agent::x\\nevil", "one\\nINFO forged", ""),
        );
    });
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].message.contains('\n'), "{entries:?}");
    assert!(!entries[0].target.contains('\n'), "{entries:?}");
}

#[test]
fn malformed_correlation_id_and_secret_fields_are_not_logged() {
    let entries = capture(|| {
        reemit_line(
            "agent-1",
            &framed(
                "INFO",
                "termihub_agent::x",
                "m",
                ",\"cid\":\"has space\",\"fields\":{\"password\":\"hunter2\"}",
            ),
        );
    });
    assert_eq!(entries.len(), 1);
    let m = &entries[0].message;
    assert!(!m.contains("correlation_id"), "{m}");
    assert!(!m.contains("hunter2"), "{m}");
    assert!(m.contains("password=[REDACTED]"), "{m}");
}

#[test]
fn pending_partial_line_is_bounded() {
    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-1");
        d.push(&vec![b'x'; MAX_PENDING_BYTES + 1]);
        assert!(d.pending.is_empty());
    });
    assert_eq!(entries.len(), 1);
}

/// End-to-end contract: the agent's real encoder layer produces the bytes, the
/// desktop decoder re-emits them — level, target and correlation id survive.
#[test]
fn agent_encoder_output_round_trips_through_the_desktop() {
    let bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
    let agent = tracing_subscriber::registry().with(
        termihub_agent::log_frame::FramedStderrLayer::new(SharedBuf(bytes.clone())),
    );
    test_support::with_scoped_subscriber(agent, || {
        let span = tracing::info_span!("agent_session", correlation_id = "desk-sid-7");
        span.in_scope(|| {
            tracing::debug!(target: "termihub_agent::session::manager", pid = 42, "daemon up");
        });
    });
    let stderr = bytes.lock().unwrap().clone();

    let entries = capture(|| {
        let mut d = AgentStderr::new("agent-7");
        d.push(&stderr);
    });
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].level, "DEBUG");
    assert_eq!(entries[0].target, "termihub_agent::session::manager");
    assert!(entries[0].message.starts_with("daemon up"));
    assert!(entries[0].message.contains("correlation_id=desk-sid-7"));
    assert!(entries[0].message.contains("pid=42"));
}

#[derive(Clone)]
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl io::Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for SharedBuf {
    type Writer = SharedBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
