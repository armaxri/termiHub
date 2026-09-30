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

#[test]
fn truncate_respects_char_boundaries() {
    assert_eq!(truncate("héllo".to_string(), 2), "h…");
    assert_eq!(truncate("abc".to_string(), 3), "abc");
}

#[test]
fn parse_line_passes_unframed_output_through() {
    let panic = "thread 'main' panicked at src/main.rs:1:1:\n";
    assert_eq!(
        parse_line(panic),
        StderrLine::Unframed("thread 'main' panicked at src/main.rs:1:1:".to_string())
    );
    assert_eq!(
        parse_line("libfoo: warning\r\n"),
        StderrLine::Unframed("libfoo: warning".to_string())
    );
}

#[test]
fn parse_line_degrades_unknown_versions_and_bad_bodies_to_unframed() {
    let future = "@termihub-log/2 {\"ts\":\"t\",\"level\":\"INFO\",\"target\":\"a\",\"msg\":\"m\"}";
    assert_eq!(parse_line(future), StderrLine::Unframed(future.to_string()));
    let bad = "@termihub-log/1 {not json";
    assert_eq!(parse_line(bad), StderrLine::Unframed(bad.to_string()));
    let no_space = "@termihub-log/1{}";
    assert_eq!(
        parse_line(no_space),
        StderrLine::Unframed(no_space.to_string())
    );
}

#[test]
fn parse_line_ignores_unknown_members() {
    let line = "@termihub-log/1 {\"ts\":\"t\",\"level\":\"INFO\",\"target\":\"a\",\"msg\":\"m\",\"new\":1}";
    match parse_line(line) {
        StderrLine::Framed(f) => {
            assert_eq!(f.msg, "m");
            assert!(f.fields.is_empty());
            assert_eq!(f.cid, None);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn encode_then_parse_round_trips() {
    let frame = LogFrame {
        ts: "2026-09-30T00:00:00.000000Z".into(),
        level: "DEBUG".into(),
        target: "termihub_agent::x".into(),
        msg: "hello\nworld".into(),
        cid: Some("abc-1".into()),
        fields: [("k".to_string(), "v".to_string())].into_iter().collect(),
    };
    let line = encode_line(&frame);
    assert!(!line.contains('\n'));
    assert_eq!(parse_line(&line), StderrLine::Framed(frame));
}

#[test]
fn secret_field_names_are_recognised() {
    for name in [
        "password",
        "ssh_password",
        "Passphrase",
        "auth-token",
        "api_key",
        "private_key",
        "key.passphrase",
        "client_secret",
        "otp",
    ] {
        assert!(is_secret_field(name), "{name}");
    }
    for name in [
        "session_id",
        "key_count",
        "hotplug",
        "type_id",
        "correlation_id",
        "host",
    ] {
        assert!(!is_secret_field(name), "{name}");
    }
}
