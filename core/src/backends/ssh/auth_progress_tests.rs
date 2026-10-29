//! Connect-stage reporting of the SSH handshake (#5068), driven over the
//! in-process test server so the real handshake runs.

use super::*;
use crate::backends::ssh::ki_test_server::{serve, PasswordPolicy, Round, Script};
use crate::connection::connect_progress::{with_reporter, ConnectProgressReporter};
use std::sync::Mutex;

fn config(auth_method: &str) -> SshConfig {
    SshConfig {
        host: "progress-5068.invalid".to_string(),
        port: 2222,
        username: "alice".to_string(),
        auth_method: auth_method.to_string(),
        password: Some("hunter2".to_string()),
        key_path: Some("~/.ssh/id_ed25519".to_string()),
        ..SshConfig::default()
    }
}

/// A handshake refused at the host key stops at `HostKey`: `Authenticate` is
/// never reported, so the stepper marks the right stage as failed.
#[tokio::test]
async fn host_key_refusal_stops_at_the_host_key_stage() {
    let (stream, _observed) = serve(Script {
        rounds: vec![Round::new(vec![("Password: ", false)], vec!["hunter2"])],
        password: PasswordPolicy::Disabled,
    });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let reporter = ConnectProgressReporter::new(move |u| sink.lock().unwrap().push(u));

    let result = with_reporter(
        reporter,
        handshake_and_authenticate(&config("password"), stream),
    )
    .await;

    assert!(
        result.is_err(),
        "the headless default refuses an unknown key"
    );
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.iter().map(|u| u.stage).collect::<Vec<_>>(),
        vec![ConnectStage::HostKey]
    );
    assert_eq!(
        seen[0].status.as_deref(),
        Some("Verifying host key of progress-5068.invalid:2222")
    );
}

/// The authenticate status line names the method the connect is trying.
#[test]
fn auth_status_names_the_method() {
    assert_eq!(
        auth_status(&config("key")),
        "Trying public key ~/.ssh/id_ed25519 for alice@progress-5068.invalid"
    );
    assert_eq!(
        auth_status(&config("password")),
        "Password login as alice@progress-5068.invalid"
    );
    assert_eq!(
        auth_status(&config("agent")),
        "Trying SSH agent keys for alice@progress-5068.invalid"
    );
    assert_eq!(
        auth_status(&config(AUTH_METHOD_KEYBOARD_INTERACTIVE)),
        "Keyboard-interactive login as alice@progress-5068.invalid"
    );
}
