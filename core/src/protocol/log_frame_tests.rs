//! Tests for the stderr log framing wire format (#2854, OBS-004).

use super::*;

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
