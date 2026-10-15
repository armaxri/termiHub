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
fn camel_case_secret_field_names_are_recognised() {
    // Connection settings keys are camelCase: the VNC SSH-gateway
    // `sshPassword` must be redacted like `ssh_password` (#4289).
    for name in ["sshPassword", "keyPassphrase", "apiToken", "clientSecret"] {
        assert!(is_secret_field(name), "{name}");
    }
    for name in ["sessionId", "keyCount", "typeId", "hostName"] {
        assert!(!is_secret_field(name), "{name}");
    }
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldVectors {
    secret: Vec<String>,
    structured_secret: Vec<String>,
    not_secret: Vec<String>,
}

/// The same vectors run against the free-text redactors (#4701), so the
/// structured and free-text classifications share one word list.
#[test]
fn shared_secret_field_vectors_match() {
    let raw = include_str!("../../../src/test/fixtures/redaction/secret-field-vectors.json");
    let vectors: FieldVectors = serde_json::from_str(raw).unwrap();
    assert!(vectors.secret.len() > 50);
    for name in vectors.secret.iter().chain(&vectors.structured_secret) {
        assert!(is_secret_field(name), "{name} should be a secret field");
    }
    for name in &vectors.not_secret {
        assert!(
            !is_secret_field(name),
            "{name} should not be a secret field"
        );
    }
}

/// Every term in the shared list `src/data/secret-key-words.json` is a secret
/// field name in every spelling (#4701): adding a word there without the
/// structured classifier honouring it fails here.
#[test]
fn every_shared_secret_word_is_a_secret_field() {
    let raw = include_str!("../../../src/data/secret-key-words.json");
    let spec: serde_json::Value = serde_json::from_str(raw).unwrap();
    let mut terms: Vec<Vec<String>> = spec["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| vec![w.as_str().unwrap().to_string()])
        .collect();
    for t in spec["compoundWords"].as_array().unwrap() {
        terms.push(
            t.as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().to_string())
                .collect(),
        );
    }
    assert!(terms.iter().any(|t| t == &["pin"]));
    let cap = |s: &str| {
        let mut c = s.chars();
        c.next()
            .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
            .unwrap_or_default()
    };
    for parts in &terms {
        let snake = parts.join("_");
        let camel_tail: String = parts.iter().map(|p| cap(p)).collect();
        let camel = parts[0].clone() + &parts[1..].iter().map(|p| cap(p)).collect::<String>();
        let names = [
            snake.clone(),
            format!("{snake}s"),
            snake.to_ascii_uppercase(),
            parts.join("-"),
            parts.concat(),
            camel.clone(),
            format!("ssh_{snake}"),
            format!("ssh-{}", parts.join("-")),
            format!("SSH_{}", snake.to_ascii_uppercase()),
            format!("ssh{camel_tail}"),
            format!("ssh{}", parts.concat()),
            format!("key.{snake}"),
        ];
        for name in names {
            assert!(is_secret_field(&name), "{name} (from {parts:?})");
        }
    }
}

/// Every name the classifier caught before it was driven by the shared list
/// (#4701) is still caught: the shared list may only add secrets.
#[test]
fn pre_shared_list_secret_names_stay_secret() {
    for name in [
        "password",
        "passwd",
        "passphrase",
        "pwd",
        "secret",
        "token",
        "credential",
        "credentials",
        "cookie",
        "otp",
        "totp",
        "private_key",
        "privatekey",
        "api_key",
        "apikey",
        "secret_key",
        "access_key",
        "authorization",
        "xprivate_key",
        "my.api-key",
        "token_count",
        "cookie_jar",
        "credentials_path",
        "secretKey",
        "AccessKey",
    ] {
        assert!(is_secret_field(name), "{name}");
    }
}
