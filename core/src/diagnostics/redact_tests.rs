use super::*;

fn plain() -> Redactor {
    Redactor::new(RedactionContext::default())
}

fn with_ctx() -> Redactor {
    Redactor::new(RedactionContext {
        home_dirs: vec!["/Users/alice".into(), r"C:\Users\alice".into()],
        usernames: vec!["alice".into()],
        hostnames: vec!["alice-mbp.local".into(), "alice-mbp".into()],
    })
}

/// Assert that `secret` does not survive redaction of `input`.
fn assert_masked(r: &Redactor, input: &str, secret: &str) -> String {
    let out = r.redact(input);
    assert!(
        !out.contains(secret),
        "`{secret}` leaked through redaction: {input:?} -> {out:?}"
    );
    out
}

// ── credentials, keys, tokens ────────────────────────────────────────────

#[test]
fn masks_key_value_secrets_in_every_common_shape() {
    let r = plain();
    for input in [
        "password=hunter2secret",
        "password: hunter2secret",
        r#"{"password":"hunter2secret"}"#,
        "passphrase='hunter2secret'",
        r#"SshConfig { password: Some("hunter2secret") }"#,
        "api_key=hunter2secret",
        "client-secret: hunter2secret",
        "refresh_token=hunter2secret",
        "Cookie: hunter2secret",
        "otp=hunter2secret",
    ] {
        let out = assert_masked(&r, input, "hunter2secret");
        assert!(out.contains(REDACTED), "{input:?} -> {out:?}");
    }
}

#[test]
fn keeps_non_secret_words_that_contain_a_keyword() {
    let r = plain();
    assert_eq!(r.redact("keyboard layout = de"), "keyboard layout = de");
    assert_eq!(r.redact("tokenizer: ready"), "tokenizer: ready");
}

#[test]
fn masks_pem_private_keys_even_when_truncated() {
    let r = plain();
    let full = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter";
    let out = assert_masked(&r, full, "b3BlbnNzaC1rZXk");
    assert!(out.starts_with("before\n") && out.ends_with("\nafter"));
    let truncated = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA";
    assert_masked(&r, truncated, "MIIEpAIBAAKCAQEA");
}

#[test]
fn masks_authorization_and_bearer_credentials() {
    let r = plain();
    let out = assert_masked(&r, "Authorization: Bearer abc.def.ghi", "abc.def.ghi");
    assert!(out.contains("Bearer"));
    assert_masked(&r, "sent bearer sEcReT-t0ken_value", "sEcReT-t0ken_value");
}

#[test]
fn masks_url_credentials_and_host() {
    let r = plain();
    let out = r.redact("connecting to ssh://bob:pa55w0rd@db.internal.example.com:22/x");
    assert!(!out.contains("pa55w0rd") && !out.contains("bob") && !out.contains("example"));
    assert!(out.contains("ssh://[REDACTED]@[host]:22"), "{out}");
    // Loopback dev URLs stay readable.
    assert_eq!(
        r.redact("http://localhost:1420/index.html"),
        "http://localhost:1420/index.html"
    );
}

#[test]
fn masks_token_shaped_strings() {
    let r = plain();
    for token in [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        "ghp_0123456789abcdefghijABCDEFGHIJ",
        "AKIAABCDEFGHIJKLMNOP",
        "sk-proj0123456789abcdefXYZ",
        "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==",
        "0123456789abcdef0123456789abcdef01234567",
    ] {
        let out = assert_masked(&r, &format!("value {token} end"), token);
        assert!(out.contains(REDACTED_TOKEN), "{token} -> {out}");
    }
}

#[test]
fn keeps_uuids_identifiers_and_source_paths() {
    let r = plain();
    for keep in [
        "session 550e8400-e29b-41d4-a716-446655440000 closed",
        "at termihub_lib::session_projection::redrive_resume_tests::fresh_agent",
        "panic at src-tauri/src/utils/panic_hook.rs:42:9",
        "3: std::panicking::begin_panic_handler::h8a7b6c5d4e3f2a1b",
        "library/std/src/sys/backtrace.rs",
    ] {
        assert_eq!(r.redact(keep), keep);
    }
}

// ── identity: users, hosts, IPs, home dirs ────────────────────────────────

#[test]
fn collapses_the_local_home_directory_and_masks_the_user() {
    let r = with_ctx();
    assert_eq!(
        r.redact("log at /Users/alice/Library/Logs/com.termihub.app/termihub.log"),
        "log at ~/Library/Logs/com.termihub.app/termihub.log"
    );
    assert_eq!(
        r.redact(r"C:\Users\alice\AppData\Local"),
        r"~\AppData\Local"
    );
    let out = assert_masked(&r, "whoami: alice", "alice");
    assert!(out.contains(USER));
}

#[test]
fn masks_other_users_home_paths_on_every_platform() {
    let r = plain();
    assert_masked(&r, "/home/bob/.ssh/id_ed25519", "bob");
    assert_masked(&r, "/Users/carol/work", "carol");
    assert_masked(&r, r"C:\Users\dave\Documents", "dave");
}

#[test]
fn masks_the_local_hostname() {
    let r = with_ctx();
    assert_masked(&r, "running on alice-mbp.local since boot", "alice-mbp");
    assert_masked(&r, "ALICE-MBP ready", "ALICE-MBP");
}

#[test]
fn masks_host_and_user_fields() {
    let r = plain();
    let out = r.redact(r#"Connect { host: "prod-db", username: "root", port: 22 }"#);
    assert_eq!(out, r#"Connect { host: "[host]", username: "[user]", port: 22 }"#);
    assert_eq!(r.redact("host=jumpbox user=eve"), "host=[host] user=[user]");
}

#[test]
fn masks_user_at_host_and_emails() {
    let r = plain();
    assert_eq!(r.redact("ssh eve@jumpbox"), "ssh [user]@[host]");
    assert_masked(&r, "mail frank@example.org", "frank");
}

#[test]
fn masks_ip_addresses_but_keeps_loopback() {
    let r = plain();
    assert_eq!(r.redact("peer 192.168.1.20:22 down"), "peer [ip]:22 down");
    assert_eq!(r.redact("bound 127.0.0.1:1420"), "bound 127.0.0.1:1420");
    assert_eq!(r.redact("listen 0.0.0.0"), "listen 0.0.0.0");
    assert_eq!(r.redact("addr 2001:db8::1 up"), "addr [ip] up");
    assert_eq!(r.redact("addr fe80::1%en0"), "addr [ip]%en0");
    assert_eq!(r.redact("loopback ::1"), "loopback ::1");
    assert_eq!(r.redact("mac aa:bb:cc:dd:ee:ff"), "mac [mac]");
}

#[test]
fn does_not_mistake_timestamps_or_rust_paths_for_ips() {
    let r = plain();
    let line = "2026-09-26T12:34:56.123456Z INFO termihub_lib::panic: std::backtrace ok";
    assert_eq!(r.redact(line), line);
}

#[test]
fn masks_dotted_host_names_but_keeps_file_names() {
    let r = plain();
    assert_eq!(
        r.redact("resolve build.corp.example.com failed"),
        "resolve [host] failed"
    );
    assert_eq!(r.redact("wrote termihub.log"), "wrote termihub.log");
    assert_eq!(r.redact("read tauri.conf.json"), "read tauri.conf.json");
}

// ── properties ───────────────────────────────────────────────────────────

#[test]
fn redaction_is_idempotent() {
    let r = with_ctx();
    let input = "alice@alice-mbp host=prod password=x ssh://u:p@h.example.com \
                 10.0.0.1 /home/bob Authorization: Bearer tok \
                 ghp_0123456789abcdefghijABCDEFGHIJ aa:bb:cc:dd:ee:ff";
    let once = r.redact(input);
    assert_eq!(r.redact(&once), once);
}

#[test]
fn empty_and_plain_text_pass_through() {
    let r = plain();
    assert_eq!(r.redact(""), "");
    assert_eq!(
        r.redact("terminal resized to 80x24"),
        "terminal resized to 80x24"
    );
}

#[test]
fn short_or_placeholder_usernames_are_not_literal_replaced() {
    let r = Redactor::new(RedactionContext {
        usernames: vec!["pi".into(), "user".into()],
        ..RedactionContext::default()
    });
    assert_eq!(r.redact("pipe to user"), "pipe to user");
}

#[test]
fn from_environment_collects_the_current_user_context() {
    temp_env::with_vars(
        [
            ("HOME", Some("/home/zed")),
            ("USER", Some("zed")),
            ("HOSTNAME", Some("zbox.lan")),
        ],
        || {
            let ctx = RedactionContext::from_environment();
            assert!(ctx.home_dirs.contains(&"/home/zed".to_string()));
            assert!(ctx.usernames.contains(&"zed".to_string()));
            assert!(ctx.hostnames.contains(&"zbox".to_string()));
        },
    );
}
