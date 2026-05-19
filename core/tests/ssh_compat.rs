//! SSH Compatibility Integration Tests (SSH-COMPAT-01, SSH-COMPAT-02).
//!
//! Tests termiHub's SSH backend against a legacy OpenSSH 7.x server to verify
//! backward compatibility with older SSH implementations.
//!
//! Container: `ssh-legacy` on port 2202 (Ubuntu 18.04, OpenSSH 7.x).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{require_docker, ssh_exec, ssh_key_config, ssh_password_config, PORT_SSH_LEGACY};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-COMPAT-01: Legacy OpenSSH 7.x password auth ─────────────────

#[tokio::test]
async fn ssh_compat_01_legacy_password_auth() {
    require_docker!(PORT_SSH_LEGACY);

    let config = ssh_password_config(PORT_SSH_LEGACY);
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-COMPAT-01: Legacy SSH password auth should succeed");

    // Verify we can execute commands on the legacy server.
    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-COMPAT-02: Legacy OpenSSH 7.x key auth ──────────────────────

#[tokio::test]
async fn ssh_compat_02_legacy_key_auth() {
    require_docker!(PORT_SSH_LEGACY);

    let config = ssh_key_config(PORT_SSH_LEGACY, "ed25519");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-COMPAT-02: Legacy SSH key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}
