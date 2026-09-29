//! Host-key handling of an unattended connect (#3527), driven over the
//! in-process test server so the real handshake runs.
//!
//! No host-key verifier is registered in the core test process, so the strict
//! headless default applies: a key not in `~/.ssh/known_hosts` is refused. The
//! test host name never appears there.

use super::*;
use crate::backends::ssh::ki_test_server::{serve, PasswordPolicy, Round, Script};
use crate::backends::ssh::unattended::run_unattended;

fn config() -> SshConfig {
    SshConfig {
        host: "unattended-3527.invalid".to_string(),
        port: 2222,
        username: "alice".to_string(),
        auth_method: "password".to_string(),
        password: Some("hunter2".to_string()),
        ..SshConfig::default()
    }
}

fn script() -> Script {
    Script {
        rounds: vec![Round::new(vec![("Password: ", false)], vec!["hunter2"])],
        password: PasswordPolicy::Disabled,
    }
}

/// An untrusted host key refuses an unattended connect with the typed
/// `HostKeyUntrusted`, before any credential is sent.
#[tokio::test]
async fn unattended_untrusted_host_key_is_a_typed_refusal() {
    let (stream, observed) = serve(script());
    let err = match run_unattended(handshake_and_authenticate(&config(), stream)).await {
        Ok(_) => panic!("an untrusted host key must be refused"),
        Err(e) => e,
    };
    assert_eq!(
        err.connect_failure_kind(),
        Some(ConnectFailureKind::HostKeyUntrusted),
        "got {err:?}"
    );
    assert!(err.to_string().contains("unattended-3527.invalid:2222"));
    assert!(observed.lock().unwrap().responses.is_empty());
}

/// The same refusal on an attended connect keeps its previous, untyped
/// handshake error — the new kind is reserved for unattended connects.
#[tokio::test]
async fn attended_host_key_refusal_is_unchanged() {
    let (stream, _observed) = serve(script());
    let err = match handshake_and_authenticate(&config(), stream).await {
        Ok(_) => panic!("the headless default refuses an unknown key"),
        Err(e) => e,
    };
    assert_eq!(err.connect_failure_kind(), None, "got {err:?}");
    assert!(err.to_string().contains("SSH handshake failed"));
}

// ── Secrets an unattended connect would have to ask for (#3877) ───────

/// A passphrase-protected OpenSSH ed25519 key (passphrase `test-passphrase`),
/// generated with `ssh-keygen` for these tests only.
pub(crate) const ENCRYPTED_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDz+qoxRm
PRuT9RT+9nY3kKAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIEsXaGR99x2rYAVH
8Hw7/9v0HmirT1qZiqc6Ra2ZUKepAAAAoGyTgSPczR6S6nfJOKMR+46phR7Zl6ODz34tzi
NMiyjsy8QU/ijez0gwQ6/bprtmUtpw04UPPlLxAw1qRH6Smb65jCIkQWAL/CSxS3l5cBPl
Yf8Xbz1lqDO+8W4yxlk6j5mMu81CK4jWG6yogLfwxDi6fbuXSdqj4Z5l2POC316MIaLXK+
KAIjHsGOT4hxy4zo0ITbSG7fXX+BK1Ou973wY=
-----END OPENSSH PRIVATE KEY-----
";

fn trusted_key_config(auth_method: &str, password: Option<&str>) -> SshConfig {
    SshConfig {
        auth_method: auth_method.to_string(),
        password: password.map(str::to_string),
        ..config()
    }
}

/// Password auth with no stored password never sends an empty one when
/// unattended: it fails fast as `InteractionRequired`.
#[tokio::test]
async fn unattended_password_auth_without_a_password_needs_interaction() {
    use crate::backends::ssh::ki_test_server::connect as ki_connect;
    for password in [None, Some("")] {
        let (mut session, observed) = ki_connect(script()).await;
        let err = run_unattended(authenticate_with_prompter(
            &mut session,
            &trusted_key_config("password", password),
            None,
        ))
        .await
        .expect_err("a missing password must be refused");
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::InteractionRequired),
            "{password:?}: {err:?}"
        );
        assert!(observed.lock().unwrap().responses.is_empty());
    }
}

/// An encrypted key with no stored passphrase fails fast as
/// `InteractionRequired` when unattended — an empty stored passphrase too.
#[tokio::test]
async fn unattended_encrypted_key_without_a_passphrase_needs_interaction() {
    use crate::backends::ssh::ki_test_server::connect as ki_connect;
    let dir = tempfile::tempdir().expect("tempdir");
    let key_path = dir.path().join("id_ed25519");
    std::fs::write(&key_path, ENCRYPTED_KEY).expect("write key");
    let mut cfg = trusted_key_config("key", None);
    cfg.key_path = Some(key_path.to_string_lossy().into_owned());

    for passphrase in [None, Some(String::new())] {
        cfg.password = passphrase.clone();
        let (mut session, _observed) = ki_connect(script()).await;
        let err = run_unattended(authenticate_with_prompter(&mut session, &cfg, None))
            .await
            .expect_err("an encrypted key without a passphrase must be refused");
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::InteractionRequired),
            "{passphrase:?}: {err:?}"
        );
    }
}

/// Attended, the same encrypted key keeps its previous, untyped error.
#[tokio::test]
async fn attended_encrypted_key_without_a_passphrase_is_unchanged() {
    use crate::backends::ssh::ki_test_server::connect as ki_connect;
    let dir = tempfile::tempdir().expect("tempdir");
    let key_path = dir.path().join("id_ed25519");
    std::fs::write(&key_path, ENCRYPTED_KEY).expect("write key");
    let mut cfg = trusted_key_config("key", None);
    cfg.key_path = Some(key_path.to_string_lossy().into_owned());

    let (mut session, _observed) = ki_connect(script()).await;
    let err = authenticate_with_prompter(&mut session, &cfg, None)
        .await
        .expect_err("no passphrase");
    assert_eq!(err.connect_failure_kind(), None, "got {err:?}");
}
