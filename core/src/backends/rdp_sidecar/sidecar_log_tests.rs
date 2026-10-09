//! Tests for the RDP sidecar stderr forwarder (#4320, OBS2-003).

use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

use super::*;

/// One captured tracing event.
#[derive(Debug, Clone)]
struct Captured {
    target: String,
    level: Level,
    message: String,
    panic: bool,
}

/// A minimal subscriber that records every event (no span support needed).
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<Captured>>>);

#[derive(Default)]
struct EventVisitor {
    message: String,
    panic: bool,
}

impl Visit for EventVisitor {
    fn record_bool(&mut self, field: &Field, value: bool) {
        if field.name() == "panic" {
            self.panic = value;
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        }
    }
}

impl Subscriber for Capture {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut visitor = EventVisitor::default();
        event.record(&mut visitor);
        self.0.lock().unwrap().push(Captured {
            target: event.metadata().target().to_string(),
            level: *event.metadata().level(),
            message: visitor.message,
            panic: visitor.panic,
        });
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

/// Feed `bytes` through [`forward_stderr`] as the sidecar's stderr and return
/// every event it emitted.
fn forward(bytes: Vec<u8>) -> Vec<Captured> {
    let capture = Capture::default();
    let events = capture.0.clone();
    tracing::subscriber::with_default(capture, || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let (mut sidecar_stderr, host_read) = tokio::io::duplex(64 * 1024);
            let forwarder = tokio::spawn(forward_stderr(host_read));
            sidecar_stderr.write_all(&bytes).await.unwrap();
            drop(sidecar_stderr);
            forwarder.await.unwrap();
        });
    });
    let out = events.lock().unwrap().clone();
    out
}

#[test]
fn sidecar_stderr_lines_reach_the_log_under_the_sidecar_target() {
    let events = forward(
        b"  WARN termihub_rdp_helper::rdp: clipboard event failed; ending the session\n\
          ERROR termihub_rdp_helper::rdp: rdp process error\n\
          INFO termihub_rdp_helper: connected\n"
            .to_vec(),
    );
    assert_eq!(events.len(), 3, "{events:?}");
    assert!(events.iter().all(|e| e.target == SIDECAR_LOG_TARGET));
    assert_eq!(events[0].level, Level::WARN);
    assert_eq!(
        events[0].message,
        "termihub_rdp_helper::rdp: clipboard event failed; ending the session"
    );
    assert_eq!(events[1].level, Level::ERROR);
    assert_eq!(events[2].level, Level::INFO);
    assert!(events.iter().all(|e| !e.panic));
}

/// The sidecar's panic hook reports a panic as one `ERROR` line; it is
/// captured as an error entry carrying the panic message.
#[test]
fn a_sidecar_panic_line_is_captured_as_an_error_with_its_message() {
    let events = forward(
        b"ERROR termihub_rdp_helper::panic: rdp sidecar panicked at src/rdp.rs:850:9: boom\n"
            .to_vec(),
    );
    assert_eq!(events.len(), 1, "{events:?}");
    let panic = &events[0];
    assert_eq!(panic.target, SIDECAR_LOG_TARGET);
    assert_eq!(panic.level, Level::ERROR);
    assert!(panic.panic);
    assert!(panic.message.contains("boom"), "{}", panic.message);
}

/// A panic printed by Rust's default hook (before the sidecar's own hook is
/// installed) spans a header and a payload line; both are errors.
#[test]
fn a_default_hook_panic_and_its_payload_are_both_errors() {
    let events = forward(
        b"thread 'main' panicked at src/main.rs:12:5:\nboom\nnote: run with RUST_BACKTRACE=1\n"
            .to_vec(),
    );
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[0].level, Level::ERROR);
    assert!(events[0].panic);
    assert_eq!(events[1].level, Level::ERROR);
    assert_eq!(events[1].message, "boom");
    assert!(events[1].panic);
    // The trailing note is ordinary unformatted output.
    assert_eq!(events[2].level, Level::WARN);
    assert!(!events[2].panic);
}

#[test]
fn unformatted_output_is_a_warning_and_blank_lines_are_skipped() {
    let events = forward(b"some C library print\n\n   \n".to_vec());
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].level, Level::WARN);
    assert_eq!(events[0].message, "some C library print");
}

#[test]
fn control_characters_are_escaped_so_a_line_cannot_forge_another() {
    let events = forward(b"WARN x: a\x1b[31mred\rforged\n".to_vec());
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(!events[0].message.contains('\x1b'));
    assert!(
        events[0].message.contains("\\u{1b}"),
        "{}",
        events[0].message
    );
}

#[test]
fn an_overlong_line_is_capped_and_the_rest_discarded() {
    let mut bytes = b"WARN x: ".to_vec();
    bytes.extend(std::iter::repeat_n(b'a', MAX_LINE_BYTES * 3));
    bytes.extend_from_slice(b"\nWARN x: next\n");
    let events = forward(bytes);
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0].message.len() <= MAX_LINE_BYTES);
    assert_eq!(events[1].message, "x: next");
}

#[test]
fn a_trailing_line_without_newline_is_still_forwarded() {
    let events = forward(b"ERROR x: last words".to_vec());
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].message, "x: last words");
}

/// A log storm is bounded: past the window budget lines are dropped and
/// reported once as a single suppressed-count warning — but a panic still
/// gets through.
#[test]
fn a_log_storm_is_rate_limited_and_reported_once() {
    let mut bytes = Vec::new();
    for i in 0..(LINES_PER_WINDOW + 50) {
        bytes.extend_from_slice(format!("INFO x: line {i}\n").as_bytes());
    }
    bytes.extend_from_slice(b"ERROR x: rdp sidecar panicked at a.rs:1:1: late\n");
    let events = forward(bytes);
    let forwarded = events
        .iter()
        .filter(|e| e.message.starts_with("x: line"))
        .count();
    assert_eq!(forwarded, LINES_PER_WINDOW as usize);
    assert!(events.iter().any(|e| e.panic && e.message.contains("late")));
    let reports: Vec<_> = events
        .iter()
        .filter(|e| e.message.contains("suppressed"))
        .collect();
    assert_eq!(reports.len(), 1, "{events:?}");
    assert!(reports[0].message.contains("50"), "{}", reports[0].message);
    assert!(events.iter().all(|e| e.target == SIDECAR_LOG_TARGET));
}

/// The budget refills once the window has passed, and the earlier window's
/// suppressed count is reported when it does.
#[test]
fn the_budget_refills_after_the_window() {
    let mut state = SidecarStderr::new();
    let start = Instant::now();
    for _ in 0..LINES_PER_WINDOW {
        assert!(matches!(
            state.process("INFO x: y", start).0,
            Forward::Line(_)
        ));
    }
    assert_eq!(state.process("INFO x: y", start).0, Forward::Suppressed);
    let (verdict, reported) = state.process("INFO x: y", start + RATE_WINDOW);
    assert!(matches!(verdict, Forward::Line(_)));
    assert_eq!(reported, Some(1));
}
