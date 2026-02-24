//! SSH Authentication Integration Tests (SSH-AUTH-01 through SSH-AUTH-12).
//!
//! Tests termiHub's SSH authentication handling against Docker containers:
//! - `ssh-password` on port 2201 (password auth)
//! - `ssh-keys` on port 2203 (key-based auth, all key types)
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{
    require_docker, ssh_exec, ssh_key_config, ssh_key_passphrase_config, ssh_password_config,
    PORT_SSH_KEYS, PORT_SSH_PASSWORD,
};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-AUTH-01: Password authentication ─────────────────────────────

#[test]
fn ssh_auth_01_password_login() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = ssh_password_config(PORT_SSH_PASSWORD);
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-01: Password auth should succeed");

    assert!(session.authenticated(), "Session should be authenticated");

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-02: RSA-2048 key ────────────────────────────────────────

#[test]
fn ssh_auth_02_rsa_2048_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "rsa_2048");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-02: RSA-2048 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-03: RSA-4096 key ────────────────────────────────────────

#[test]
fn ssh_auth_03_rsa_4096_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "rsa_4096");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-03: RSA-4096 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-04: Ed25519 key ─────────────────────────────────────────

#[test]
fn ssh_auth_04_ed25519_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ed25519");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-04: Ed25519 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-05: ECDSA-256 key ───────────────────────────────────────

#[test]
fn ssh_auth_05_ecdsa_256_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_256");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-05: ECDSA-256 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-06: ECDSA-384 key ───────────────────────────────────────

#[test]
fn ssh_auth_06_ecdsa_384_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_384");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-06: ECDSA-384 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-07: ECDSA-521 key ───────────────────────────────────────

#[test]
fn ssh_auth_07_ecdsa_521_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_521");
    let session =
        connect_and_authenticate(&config).expect("SSH-AUTH-07: ECDSA-521 key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-08: RSA-2048 with passphrase ────────────────────────────

#[test]
fn ssh_auth_08_rsa_2048_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "rsa_2048_passphrase");
    let session = connect_and_authenticate(&config)
        .expect("SSH-AUTH-08: RSA-2048 passphrase key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-09: Ed25519 with passphrase ─────────────────────────────

#[test]
fn ssh_auth_09_ed25519_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ed25519_passphrase");
    let session = connect_and_authenticate(&config)
        .expect("SSH-AUTH-09: Ed25519 passphrase key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-10: ECDSA-256 with passphrase ───────────────────────────

#[test]
fn ssh_auth_10_ecdsa_256_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ecdsa_256_passphrase");
    let session = connect_and_authenticate(&config)
        .expect("SSH-AUTH-10: ECDSA-256 passphrase key auth should succeed");

    assert!(session.authenticated());

    let output = ssh_exec(&session, "whoami").expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-11: Wrong password rejected ─────────────────────────────

#[test]
fn ssh_auth_11_wrong_password_rejected() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_PASSWORD,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("wrongpassword".to_string()),
        ..Default::default()
    };

    let result = connect_and_authenticate(&config);
    assert!(
        result.is_err(),
        "SSH-AUTH-11: Wrong password should be rejected"
    );
}

// ── SSH-AUTH-12: Non-matching key rejected ───────────────────────────

#[test]
fn ssh_auth_12_wrong_key_rejected() {
    require_docker!(PORT_SSH_KEYS);

    // Generate a temporary key that is not in the container's authorized_keys.
    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let key_path = temp_dir.path().join("wrong_key");

    // Generate a throwaway Ed25519 key.
    let key =
        ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519).unwrap();
    let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
    std::fs::write(&key_path, openssh_pem.as_bytes()).expect("Failed to write temp key");

    // Set permissions on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
            .expect("Failed to set key permissions");
    }

    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_KEYS,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(key_path.to_str().unwrap().to_string()),
        ..Default::default()
    };

    let result = connect_and_authenticate(&config);
    assert!(
        result.is_err(),
        "SSH-AUTH-12: Non-matching key should be rejected"
    );
}
