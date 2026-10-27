#![cfg(feature = "ssh")]
//! SSH Banner Integration Tests (SSH-BANNER-01 through SSH-BANNER-03).
//!
//! Tests that termiHub correctly handles SSH pre-authentication banners
//! and distinguishes banner-enabled servers from standard ones.
//!
//! Docker containers used:
//! - `ssh-banner` on port 2206 (pre-auth banner + MOTD)
//! - `ssh-password` on port 2201 (standard server, no banner)
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{port_ssh_banner, port_ssh_password, require_docker, ssh_exec, ssh_password_config};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-BANNER-01: Pre-auth banner delivered ─────────────────────────

/// Verify that the ssh-banner container accepts connections and allows
/// command execution. Banner text is part of the server's MOTD/welcome
/// and is surfaced when running a shell command.
#[tokio::test]
async fn ssh_banner_01_banner_received() {
    require_docker!(port_ssh_banner());

    let config = ssh_password_config(port_ssh_banner());
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-BANNER-01: Should authenticate to the banner server");

    // Execute a command to confirm the session is functional.
    let output = ssh_exec(&session, "echo connected")
        .await
        .expect("SSH-BANNER-01: Command execution should succeed");
    assert!(
        output.contains("connected"),
        "SSH-BANNER-01: Session to banner server should be functional, got: {output}"
    );
}

// ── SSH-BANNER-02: Standard server sends no banner ───────────────────

/// Verify that the standard ssh-password container accepts connections
/// and commands work normally (no banner interference).
#[tokio::test]
async fn ssh_banner_02_no_banner_on_standard_server() {
    require_docker!(port_ssh_password());

    let config = ssh_password_config(port_ssh_password());
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-BANNER-02: Should authenticate to the standard server");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("SSH-BANNER-02: Command execution should succeed");
    assert!(
        output.trim() == "testuser",
        "SSH-BANNER-02: Standard SSH server should execute commands normally, got: {output}"
    );
}

// ── SSH-BANNER-03: Authentication fails with wrong credentials ────────

/// Verify that the SSH server correctly rejects authentication with
/// wrong credentials.
#[tokio::test]
async fn ssh_banner_03_failed_auth_rejected() {
    require_docker!(port_ssh_banner());

    use termihub_core::config::SshConfig;

    let config = SshConfig {
        host: "127.0.0.1".to_string(),
        port: port_ssh_banner(),
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("definitely-wrong-password".to_string()),
        ..Default::default()
    };

    let result = connect_and_authenticate(&config).await;
    assert!(
        result.is_err(),
        "SSH-BANNER-03: Authentication with wrong password should fail"
    );
}

// ── SSH-BANNER-04: startup output shown, typed setup hidden (#5009) ──

/// The login's own startup output, printed by the user's rc file while the
/// test runs (the container's `PrintMotd` is overridden by Ubuntu's default
/// `PrintMotd no`, so it prints no MOTD).
const STARTUP_LINE: &str = "Welcome to the termiHub test environment (5009)";

/// An interactive session with shell integration on: what the login prints
/// before the prompt reaches the terminal, the typed shell-integration setup
/// never does, and the first command runs in the integrated shell.
#[tokio::test]
async fn ssh_banner_04_startup_output_shown_but_setup_hidden() {
    use std::time::Duration;
    use termihub_core::backends::ssh::Ssh;
    use termihub_core::connection::ConnectionType;

    require_docker!(port_ssh_banner());

    // Make the login print a line, like a MOTD or an rc greeting. Only this
    // test opens an interactive shell on this container; the marker file
    // gates the rc line so it is inert once removed.
    let config = ssh_password_config(port_ssh_banner());
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-BANNER-04: authenticate for the rc setup");
    let rc_line = r#"[ -f ~/.th5009 ] && cat ~/.th5009"#;
    ssh_exec(
        &session,
        &format!(
            "printf '%s\\n' '{STARTUP_LINE}' > ~/.th5009; \
             grep -qF '{rc_line}' ~/.bashrc || echo '{rc_line}' >> ~/.bashrc"
        ),
    )
    .await
    .expect("SSH-BANNER-04: install the rc greeting");

    let mut settings = common::ssh_password_settings(port_ssh_banner());
    settings["shellIntegration"] = serde_json::Value::Bool(true);
    let mut ssh = Ssh::new();
    ssh.connect(settings)
        .await
        .expect("SSH-BANNER-04: shell session connects");
    let mut rx = ssh.subscribe_output();
    ssh.write(b"echo TH_$((40+2))_DONE\n")
        .expect("SSH-BANNER-04: write the first command");

    let mut seen = String::new();
    let ok = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(chunk) = rx.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains("TH_42_DONE") && seen.contains("\x1b]133;D;0") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    ssh.disconnect().await.ok();
    let _ = ssh_exec(&session, "rm -f ~/.th5009").await;

    assert!(ok, "SSH-BANNER-04: the first command did not run: {seen:?}");
    assert!(
        seen.contains(STARTUP_LINE),
        "SSH-BANNER-04: the login's startup output must stay visible: {seen:?}"
    );
    for leak in ["__termihub", "PROMPT_COMMAND", "precmd_functions", "6973;"] {
        assert!(
            !seen.contains(leak),
            "SSH-BANNER-04: setup text {leak:?} shown: {seen:?}"
        );
    }
}

// ── SSH-BANNER-05: default session — follows cwd, types nothing (#5009) ──

/// With default settings nothing is typed into the remote shell: the
/// login's startup output is shown, none of termiHub's setup is, and the file
/// browser still follows the shell — the backend reads the directory from
/// `/proc` over a side exec channel and reports it as OSC 7.
#[tokio::test]
async fn ssh_banner_05_default_session_follows_cwd_without_typing() {
    use std::time::Duration;
    use termihub_core::backends::ssh::Ssh;
    use termihub_core::connection::ConnectionType;

    require_docker!(port_ssh_banner());

    let config = ssh_password_config(port_ssh_banner());
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-BANNER-05: authenticate for the rc setup");
    let rc_line = r#"[ -f ~/.th5009b ] && cat ~/.th5009b"#;
    ssh_exec(
        &session,
        &format!(
            "printf '%s\\n' '{STARTUP_LINE}' > ~/.th5009b; \
             grep -qF '{rc_line}' ~/.bashrc || echo '{rc_line}' >> ~/.bashrc"
        ),
    )
    .await
    .expect("SSH-BANNER-05: install the rc greeting");

    let mut ssh = Ssh::new();
    ssh.connect(common::ssh_password_settings(port_ssh_banner()))
        .await
        .expect("SSH-BANNER-05: shell session connects");
    let mut rx = ssh.subscribe_output();
    let mut seen = String::new();
    let mut wait = async |seen: &mut String, what: &str, needle: &str| {
        let ok = tokio::time::timeout(Duration::from_secs(60), async {
            while !seen.contains(needle) {
                match rx.recv().await {
                    Some(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk)),
                    None => return false,
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        assert!(ok, "SSH-BANNER-05: timed out waiting for {what}: {seen:?}");
    };
    wait(
        &mut seen,
        "the start directory",
        "\x1b]7;file:///home/testuser\x07",
    )
    .await;
    ssh.write(b"cd /tmp\n").expect("SSH-BANNER-05: write");
    wait(&mut seen, "the new directory", "\x1b]7;file:///tmp\x07").await;
    ssh.disconnect().await.ok();
    let _ = ssh_exec(&session, "rm -f ~/.th5009b").await;

    assert!(
        seen.contains(STARTUP_LINE),
        "SSH-BANNER-05: the login's startup output must stay visible: {seen:?}"
    );
    for leak in [
        "__termihub",
        "PROMPT_COMMAND",
        "precmd_functions",
        "6973;",
        "\x1b]133;",
    ] {
        assert!(
            !seen.contains(leak),
            "SSH-BANNER-05: {leak:?} reached the terminal: {seen:?}"
        );
    }
}
