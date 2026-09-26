//! Tests for the telnet auto-login state machine.

use super::*;

const SECRET: &str = "s3cr3t-pa55";

fn config(username: &str, password: Option<&str>) -> AutoLoginConfig {
    AutoLoginConfig::new(
        username.to_string(),
        password.map(str::to_string),
        DEFAULT_LOGIN_PROMPT,
        DEFAULT_PASSWORD_PROMPT,
        Duration::from_secs(5),
    )
}

#[test]
fn full_login_sends_username_then_password() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    assert_eq!(al.on_output(b"Welcome to switch-1\r\n", t0), None);
    assert_eq!(
        al.on_output(b"switch-1 login: ", t0),
        Some(b"admin\r\n".to_vec())
    );
    assert!(!al.is_done());
    // Echoed username, then the password prompt.
    assert_eq!(al.on_output(b"admin\r\n", t0), None);
    assert_eq!(
        al.on_output(b"Password: ", t0),
        Some(format!("{SECRET}\r\n").into_bytes())
    );
    assert_eq!(al.outcome(), Some(Outcome::Completed));
    // Done: later prompts are ignored.
    assert_eq!(al.on_output(b"login: ", t0), None);
}

#[test]
fn prompts_match_case_insensitively_and_across_chunks() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    assert_eq!(al.on_output(b"User", t0), None);
    assert_eq!(al.on_output(b"NAME:", t0), Some(b"admin\r\n".to_vec()));
    assert_eq!(al.on_output(b"PASS", t0), None);
    assert!(al.on_output(b"WORD:  \r\n", t0).is_some());
}

#[test]
fn password_only_device_gets_password_at_first_prompt() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("", Some(SECRET)), t0);
    assert_eq!(
        al.on_output(b"User Access Verification\r\n\r\nPassword: ", t0),
        Some(format!("{SECRET}\r\n").into_bytes())
    );
    assert_eq!(al.outcome(), Some(Outcome::Completed));
}

#[test]
fn username_without_password_stops_after_username() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", None), t0);
    assert_eq!(al.on_output(b"login: ", t0), Some(b"admin\r\n".to_vec()));
    assert_eq!(al.outcome(), Some(Outcome::Completed));
    assert_eq!(al.on_output(b"Password: ", t0), None);
}

#[test]
fn empty_password_is_treated_as_none() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some("")), t0);
    assert!(al.on_output(b"login:", t0).is_some());
    assert_eq!(al.outcome(), Some(Outcome::Completed));
}

#[test]
fn login_prompt_without_username_abandons() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("", Some(SECRET)), t0);
    assert_eq!(al.on_output(b"login: ", t0), None);
    assert_eq!(al.outcome(), Some(Outcome::Abandoned));
}

#[test]
fn rejected_login_is_not_retried() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    al.on_output(b"login: ", t0);
    // The server re-prompts for the login instead of asking for a password.
    assert_eq!(al.on_output(b"\r\nLogin incorrect\r\nlogin: ", t0), None);
    assert_eq!(al.outcome(), Some(Outcome::Abandoned));
}

#[test]
fn times_out_waiting_for_login_prompt() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    assert!(!al.on_tick(t0 + Duration::from_secs(4)));
    assert!(al.on_tick(t0 + Duration::from_secs(5)));
    assert_eq!(al.outcome(), Some(Outcome::TimedOut));
    // A late prompt no longer triggers anything — the session is interactive.
    assert_eq!(al.on_output(b"login: ", t0 + Duration::from_secs(6)), None);
}

#[test]
fn password_stage_gets_a_fresh_timeout() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    let t1 = t0 + Duration::from_secs(4);
    assert!(al.on_output(b"login: ", t1).is_some());
    // 4 s + 4 s is past the first deadline but within the refreshed one.
    assert!(!al.on_tick(t1 + Duration::from_secs(4)));
    assert!(al
        .on_output(b"Password:", t1 + Duration::from_secs(4))
        .is_some());
}

#[test]
fn late_output_after_deadline_times_out_instead_of_sending() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    assert_eq!(al.on_output(b"login: ", t0 + Duration::from_secs(10)), None);
    assert_eq!(al.outcome(), Some(Outcome::TimedOut));
}

#[test]
fn custom_prompts_are_used() {
    let t0 = Instant::now();
    let cfg = AutoLoginConfig::new(
        "op".into(),
        Some(SECRET.into()),
        "Benutzer: | Account>",
        "Kennwort:",
        Duration::from_secs(5),
    );
    let mut al = AutoLogin::new(cfg, t0);
    assert_eq!(
        al.on_output(b"login: ", t0),
        None,
        "default no longer applies"
    );
    assert!(al.on_output(b"ACCOUNT>", t0).is_some());
    assert!(al.on_output(b"kennwort:", t0).is_some());
    assert_eq!(al.outcome(), Some(Outcome::Completed));
}

#[test]
fn blank_prompt_settings_fall_back_to_defaults() {
    let cfg = AutoLoginConfig::new("u".into(), None, " | ", "", Duration::from_secs(1));
    let dbg = format!("{cfg:?}");
    assert!(dbg.contains("\"login:\""), "{dbg}");
    assert!(dbg.contains("\"password:\""), "{dbg}");
}

#[test]
fn prompt_in_middle_of_output_does_not_match() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    assert_eq!(
        al.on_output(b"Last login: Mon Sep 1 from 10.0.0.1\r\n", t0),
        None
    );
    assert!(!al.is_done());
}

#[test]
fn credentials_are_iac_escaped() {
    // A byte of 0xFF cannot occur in valid UTF-8, so exercise the escaping
    // through the line builder directly.
    assert_eq!(line_bytes("a"), b"a\r\n".to_vec());
    let mut expected = escape_iac(&[0xFF]);
    expected.extend_from_slice(b"\r\n");
    assert_eq!(expected, vec![0xFF, 0xFF, b'\r', b'\n']);
}

#[test]
fn debug_output_never_contains_the_password() {
    let t0 = Instant::now();
    let cfg = config("admin", Some(SECRET));
    let dbg = format!("{cfg:?}");
    assert!(!dbg.contains(SECRET), "password leaked into Debug: {dbg}");
    assert!(dbg.contains("<redacted>"));
    let al = AutoLogin::new(cfg, t0);
    let dbg = format!("{al:?}");
    assert!(!dbg.contains(SECRET), "password leaked into Debug: {dbg}");
}

#[test]
fn credentials_are_dropped_once_done() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    al.on_output(b"login: ", t0);
    al.on_output(b"Password: ", t0);
    assert!(al.config.is_none(), "password must not outlive the login");
}

#[test]
fn tail_is_bounded_and_utf8_safe() {
    let t0 = Instant::now();
    let mut al = AutoLogin::new(config("admin", Some(SECRET)), t0);
    for _ in 0..100 {
        al.on_output("ääääääää".as_bytes(), t0);
    }
    assert!(al.tail.len() <= TAIL_LIMIT);
    assert!(al.on_output(b"login:", t0).is_some());
}
