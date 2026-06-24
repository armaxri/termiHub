//! SSH Authentication Integration Tests (SSH-AUTH-01 through SSH-AUTH-15).
//!
//! Tests termiHub's SSH authentication handling against Docker containers:
//! - `ssh-password` on port 2201 (password auth)
//! - `ssh-keys` on port 2203 (key-based auth, all key types)
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{
    require_docker, ssh_exec, ssh_key_config, ssh_key_passphrase_config, ssh_keys_dir,
    ssh_password_config, PORT_SSH_KEYS, PORT_SSH_PASSWORD,
};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-AUTH-01: Password authentication ─────────────────────────────

#[tokio::test]
async fn ssh_auth_01_password_login() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = ssh_password_config(PORT_SSH_PASSWORD);
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-01: Password auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-02: RSA-2048 key ────────────────────────────────────────

#[tokio::test]
async fn ssh_auth_02_rsa_2048_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "rsa_2048");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-02: RSA-2048 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-03: RSA-4096 key ────────────────────────────────────────

#[tokio::test]
async fn ssh_auth_03_rsa_4096_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "rsa_4096");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-03: RSA-4096 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-04: Ed25519 key ─────────────────────────────────────────

#[tokio::test]
async fn ssh_auth_04_ed25519_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ed25519");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-04: Ed25519 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-05: ECDSA-256 key ───────────────────────────────────────

#[tokio::test]
async fn ssh_auth_05_ecdsa_256_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_256");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-05: ECDSA-256 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-06: ECDSA-384 key ───────────────────────────────────────

#[tokio::test]
async fn ssh_auth_06_ecdsa_384_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_384");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-06: ECDSA-384 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-07: ECDSA-521 key ───────────────────────────────────────

#[tokio::test]
async fn ssh_auth_07_ecdsa_521_key() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_config(PORT_SSH_KEYS, "ecdsa_521");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-07: ECDSA-521 key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-08: RSA-2048 with passphrase ────────────────────────────

#[tokio::test]
async fn ssh_auth_08_rsa_2048_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "rsa_2048_passphrase");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-08: RSA-2048 passphrase key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-09: Ed25519 with passphrase ─────────────────────────────

#[tokio::test]
async fn ssh_auth_09_ed25519_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ed25519_passphrase");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-09: Ed25519 passphrase key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-10: ECDSA-256 with passphrase ───────────────────────────

#[tokio::test]
async fn ssh_auth_10_ecdsa_256_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ecdsa_256_passphrase");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-10: ECDSA-256 passphrase key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-13: ECDSA-384 with passphrase ───────────────────────────

/// Passphrase-protected ECDSA-384 key in OpenSSH format.
///
/// The fixture is stored as `-----BEGIN OPENSSH PRIVATE KEY-----`, which
/// russh's `load_secret_key` decrypts directly. (An earlier libssh2-era
/// fixture used encrypted PEM/SEC1 `-----BEGIN EC PRIVATE KEY-----`, which the
/// current russh-based loader cannot decrypt — it misparses it as PKCS#1.)
#[tokio::test]
async fn ssh_auth_13_ecdsa_384_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ecdsa_384_passphrase");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-13: ECDSA-384 passphrase key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-14: ECDSA-521 with passphrase ───────────────────────────

/// Passphrase-protected ECDSA-521 key in OpenSSH format.
///
/// See the note on SSH-AUTH-13 regarding the key format.
#[tokio::test]
async fn ssh_auth_14_ecdsa_521_passphrase() {
    require_docker!(PORT_SSH_KEYS);

    let config = ssh_key_passphrase_config(PORT_SSH_KEYS, "ecdsa_521_passphrase");
    let (session, _) = connect_and_authenticate(&config)
        .await
        .expect("SSH-AUTH-14: ECDSA-521 passphrase key auth should succeed");

    let output = ssh_exec(&session, "whoami")
        .await
        .expect("whoami should succeed");
    assert!(
        output.trim().contains("testuser"),
        "Expected 'testuser', got: {output}"
    );
}

// ── SSH-AUTH-11: Wrong password rejected ─────────────────────────────

#[tokio::test]
async fn ssh_auth_11_wrong_password_rejected() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_PASSWORD,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("wrongpassword".to_string()),
        ..Default::default()
    };

    let result = connect_and_authenticate(&config).await;
    assert!(
        result.is_err(),
        "SSH-AUTH-11: Wrong password should be rejected"
    );
}

// ── SSH-AUTH-12: Non-matching key rejected ───────────────────────────

#[tokio::test]
async fn ssh_auth_12_wrong_key_rejected() {
    require_docker!(PORT_SSH_KEYS);

    // A throwaway Ed25519 key that is intentionally NOT in the container's
    // authorized_keys (those come from tests/fixtures/ssh-keys). Embedded as a
    // static fixture so the test does not depend on a key-generation RNG.
    const WRONG_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAP6eRqfIpS5mPIXbpAxb9+kNbkhdwFQbpnwmmLYQ5VFgAAAKB5NZAVeTWQ
FQAAAAtzc2gtZWQyNTUxOQAAACAP6eRqfIpS5mPIXbpAxb9+kNbkhdwFQbpnwmmLYQ5VFg
AAAEAcqb4xWsO2YRZ6lRZ8Z1J403c449E7SmzTqLAlTN97zg/p5Gp8ilLmY8hdukDFv36Q
1uSF3AVBumfCaYthDlUWAAAAF3Rlcm1paHViLXRlc3QtdGhyb3dhd2F5AQIDBAUG
-----END OPENSSH PRIVATE KEY-----
";

    let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
    let key_path = temp_dir.path().join("wrong_key");
    std::fs::write(&key_path, WRONG_KEY).expect("Failed to write temp key file");

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

    let result = connect_and_authenticate(&config).await;
    assert!(
        result.is_err(),
        "SSH-AUTH-12: Non-matching key should be rejected"
    );
}

// ── SSH-AUTH-15: Wrong passphrase on a valid key ─────────────────────

/// Verify that providing the wrong passphrase for a passphrase-protected key
/// is rejected. The key file itself is valid and in the server's
/// authorized_keys, so only the incorrect passphrase causes the failure.
#[tokio::test]
async fn ssh_auth_15_wrong_passphrase_rejected() {
    require_docker!(PORT_SSH_KEYS);

    // rsa_2048_passphrase is a valid key authorized on ssh-keys,
    // but we supply the wrong passphrase.
    let config = termihub_core::config::SshConfig {
        host: "127.0.0.1".to_string(),
        port: PORT_SSH_KEYS,
        username: "testuser".to_string(),
        auth_method: "key".to_string(),
        key_path: Some(
            ssh_keys_dir()
                .join("rsa_2048_passphrase")
                .to_str()
                .unwrap()
                .to_string(),
        ),
        password: Some("this-is-not-the-passphrase".to_string()),
        ..Default::default()
    };

    let result = connect_and_authenticate(&config).await;
    assert!(
        result.is_err(),
        "SSH-AUTH-15: Wrong passphrase should be rejected"
    );
}
