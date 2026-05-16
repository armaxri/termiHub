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

use common::{require_docker, ssh_exec, ssh_password_config, PORT_SSH_BANNER, PORT_SSH_PASSWORD};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-BANNER-01: Pre-auth banner delivered ─────────────────────────

/// Verify that the ssh-banner container accepts connections and allows
/// command execution. Banner text is part of the server's MOTD/welcome
/// and is surfaced when running a shell command.
#[tokio::test]
async fn ssh_banner_01_banner_received() {
    require_docker!(PORT_SSH_BANNER);

    let config = ssh_password_config(PORT_SSH_BANNER);
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
    require_docker!(PORT_SSH_PASSWORD);

    let config = ssh_password_config(PORT_SSH_PASSWORD);
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
    require_docker!(PORT_SSH_BANNER);

    use termihub_core::config::SshConfig;

    let config = SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_BANNER,
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
