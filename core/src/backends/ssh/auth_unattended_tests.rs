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
