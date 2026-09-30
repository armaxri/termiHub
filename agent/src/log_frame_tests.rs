//! Tests for the stderr log framing (#2854, OBS-004).

use std::io;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::layer::SubscriberExt;

use super::*;

/// A `MakeWriter` that appends into a shared buffer.
#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Buf {
    fn lines(&self) -> Vec<String> {
        let bytes = self.0.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

impl io::Write for Buf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Buf {
    type Writer = Buf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Install the framed layer as this thread's default subscriber. Pins two
/// no-op dispatchers so a parallel test cannot cache a shared callsite's
/// interest as `never` for this subscriber.
fn install() -> (Buf, tracing::subscriber::DefaultGuard) {
    use tracing::subscriber::NoSubscriber;
    use tracing::Dispatch;
    static PINNED: OnceLock<[Dispatch; 2]> = OnceLock::new();
    PINNED.get_or_init(|| {
        [
            Dispatch::new(NoSubscriber::default()),
            Dispatch::new(NoSubscriber::default()),
        ]
    });
    let buf = Buf::default();
    let subscriber = tracing_subscriber::registry().with(FramedStderrLayer::new(buf.clone()));
    (buf, tracing::subscriber::set_default(subscriber))
}

fn only_frame(buf: &Buf) -> LogFrame {
    let lines = buf.lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    match parse_line(&lines[0]) {
        StderrLine::Framed(f) => f,
        other => panic!("expected a framed line, got {other:?}"),
    }
}

#[test]
fn event_is_written_as_one_framed_line_with_level_and_target() {
    let (buf, _g) = install();
    tracing::warn!(target: "termihub_agent::io::stdio", peer = 7, "stdin closed");

    let lines = buf.lines();
    assert!(lines[0].starts_with("@termihub-log/1 {"), "{lines:?}");
    let f = only_frame(&buf);
    assert_eq!(f.level, "WARN");
    assert_eq!(f.target, "termihub_agent::io::stdio");
    assert_eq!(f.msg, "stdin closed");
    assert_eq!(f.fields.get("peer").map(String::as_str), Some("7"));
    assert!(
        chrono::DateTime::parse_from_rfc3339(&f.ts).is_ok(),
        "{}",
        f.ts
    );
}

#[test]
fn each_level_round_trips() {
    let (buf, _g) = install();
    tracing::error!("e");
    tracing::info!("i");
    tracing::debug!("d");
    tracing::trace!("t");
    let levels: Vec<String> = buf
        .lines()
        .iter()
        .map(|l| match parse_line(l) {
            StderrLine::Framed(f) => f.level,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(levels, ["ERROR", "INFO", "DEBUG", "TRACE"]);
}

#[test]
fn correlation_id_is_hoisted_from_the_enclosing_span() {
    let (buf, _g) = install();
    let span = tracing::info_span!(
        "agent_session",
        correlation_id = "desk-sid-1",
        type_id = "ssh",
        session_id = tracing::field::Empty,
    );
    span.record("session_id", "agent-sid-9");
    span.in_scope(|| tracing::info!("agent session created"));

    let f = only_frame(&buf);
    assert_eq!(f.cid.as_deref(), Some("desk-sid-1"));
    assert!(!f.fields.contains_key("correlation_id"), "{:?}", f.fields);
    assert_eq!(f.fields.get("type_id").map(String::as_str), Some("ssh"));
    assert_eq!(
        f.fields.get("session_id").map(String::as_str),
        Some("agent-sid-9")
    );
}

#[test]
fn nested_span_field_wins_over_outer_and_event_wins_over_both() {
    let (buf, _g) = install();
    let outer = tracing::info_span!("outer", step = "outer", keep = "o");
    let _o = outer.enter();
    let inner = tracing::info_span!("inner", step = "inner");
    let _i = inner.enter();
    tracing::info!(step = "event", "x");
    tracing::info!("y");

    let lines = buf.lines();
    let frames: Vec<LogFrame> = lines
        .iter()
        .map(|l| match parse_line(l) {
            StderrLine::Framed(f) => f,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(frames[0].fields["step"], "event");
    assert_eq!(frames[1].fields["step"], "inner");
    assert_eq!(frames[1].fields["keep"], "o");
}

#[test]
fn malformed_correlation_id_is_not_carried() {
    let (buf, _g) = install();
    tracing::info!(correlation_id = "evil\nforged", "x");
    let f = only_frame(&buf);
    assert_eq!(f.cid, None);
    assert!(!f.fields.contains_key("correlation_id"));
}

#[test]
fn secret_fields_are_redacted_in_events_and_spans() {
    let (buf, _g) = install();
    let span = tracing::info_span!("auth", passphrase = "hunter2");
    span.in_scope(|| {
        tracing::info!(
            password = "p@ss",
            auth_token = "tok",
            user_count = 3,
            "login"
        )
    });

    let raw = buf.lines().join("\n");
    assert!(!raw.contains("hunter2"), "{raw}");
    assert!(!raw.contains("p@ss"), "{raw}");
    assert!(!raw.contains("\"tok\""), "{raw}");
    let f = only_frame(&buf);
    assert_eq!(f.fields["password"], REDACTED);
    assert_eq!(f.fields["auth_token"], REDACTED);
    assert_eq!(f.fields["passphrase"], REDACTED);
    assert_eq!(f.fields["user_count"], "3");
}

#[test]
fn a_message_with_newlines_stays_on_one_line() {
    let (buf, _g) = install();
    tracing::info!("line one\nline two\r\n{{\"jsonrpc\":\"2.0\"}}");
    let f = only_frame(&buf);
    assert_eq!(f.msg, "line one\nline two\r\n{\"jsonrpc\":\"2.0\"}");
}

#[test]
fn oversized_message_and_fields_are_truncated() {
    let (buf, _g) = install();
    let big = "x".repeat(MAX_MESSAGE_BYTES * 2);
    let field = "y".repeat(MAX_FIELD_BYTES * 2);
    tracing::info!(big_field = %field, "{}", big);
    let f = only_frame(&buf);
    assert!(f.msg.len() <= MAX_MESSAGE_BYTES + '…'.len_utf8());
    assert!(f.fields["big_field"].len() <= MAX_FIELD_BYTES + '…'.len_utf8());
    assert!(f.msg.ends_with('…'));
}
