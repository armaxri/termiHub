//! Regression tests for the FTP credential check (CORE2-003, #4292): the
//! comparison runs through the constant-time path, and failed logins are
//! throttled per client IP across sessions.

use super::*;
use crate::embedded_servers::auth_guard::{LoginThrottle, MAX_FAILED_LOGINS};

fn alice() -> Option<FtpAuth> {
    Some(FtpAuth::Credentials {
        username: "alice".to_string(),
        password: "secret".to_string(),
    })
}

fn creds(password: Option<&str>) -> Credentials {
    Credentials {
        password: password.map(str::to_owned),
        certificate_chain: None,
        source_ip: "127.0.0.1".parse().expect("ip"),
        command_channel_security: unftp_core::auth::ChannelEncryptionState::Plaintext,
    }
}

/// One session's authenticator, sharing the server-wide `throttle`.
fn session(
    throttle: &Arc<LoginThrottle>,
    activity: &Arc<ServerActivity>,
    client: &str,
) -> FtpAuthenticator {
    FtpAuthenticator::new(
        alice(),
        Arc::clone(activity),
        client.parse().expect("ip"),
        Arc::clone(throttle),
    )
}

#[test]
fn credential_check_goes_through_the_constant_time_path() {
    // `credentials_match` returns a `subtle::Choice`: the comparison is the
    // constant-time digest comparison, never an early-exit `==`.
    let ok: subtle::Choice = credentials_match("alice", Some("secret"), "alice", "secret");
    assert!(bool::from(ok));
    let wrong_pass: subtle::Choice = credentials_match("alice", Some("secreT"), "alice", "secret");
    assert!(!bool::from(wrong_pass));
    let wrong_user: subtle::Choice = credentials_match("alicE", Some("secret"), "alice", "secret");
    assert!(!bool::from(wrong_user));
    let no_pass: subtle::Choice = credentials_match("alice", None, "alice", "secret");
    assert!(!bool::from(no_pass));
    // An empty expected password is not matched by a missing one.
    let empty: subtle::Choice = credentials_match("alice", None, "alice", "");
    assert!(!bool::from(empty));
}

#[tokio::test]
async fn correct_password_is_accepted_and_clears_earlier_failures() {
    let throttle = Arc::new(LoginThrottle::new());
    let activity = ServerActivity::new();
    let auth = session(&throttle, &activity, "198.51.100.7");
    for _ in 0..MAX_FAILED_LOGINS - 1 {
        assert!(auth
            .authenticate("alice", &creds(Some("nope")))
            .await
            .is_err());
    }
    assert!(auth
        .authenticate("alice", &creds(Some("secret")))
        .await
        .is_ok());
    // The success reset the count: one more failure does not lock out.
    assert!(auth
        .authenticate("alice", &creds(Some("nope")))
        .await
        .is_err());
    assert!(auth
        .authenticate("alice", &creds(Some("secret")))
        .await
        .is_ok());
}

#[tokio::test]
async fn failed_logins_are_throttled_across_sessions() {
    let throttle = Arc::new(LoginThrottle::new());
    let activity = ServerActivity::new();
    // Every attempt on a fresh authenticator, as on a fresh control connection
    // (one libunftp server per session, #3996).
    for _ in 0..MAX_FAILED_LOGINS {
        let auth = session(&throttle, &activity, "198.51.100.7");
        assert!(auth
            .authenticate("alice", &creds(Some("nope")))
            .await
            .is_err());
    }

    // Now even the correct password is refused for that client …
    let auth = session(&throttle, &activity, "198.51.100.7");
    assert!(matches!(
        auth.authenticate("alice", &creds(Some("secret")))
            .await
            .unwrap_err(),
        AuthenticationError::BadPassword
    ));
    let log = super::tests::entries(&activity);
    let last = log.last().expect("an entry");
    assert_eq!(last.method, "LOGIN");
    assert_eq!(last.status, "throttled");
    assert!(!last.success);

    // … while another client still logs in.
    let other = session(&throttle, &activity, "198.51.100.8");
    assert!(other
        .authenticate("alice", &creds(Some("secret")))
        .await
        .is_ok());
}

#[tokio::test]
async fn anonymous_logins_are_not_counted_as_failures() {
    let throttle = Arc::new(LoginThrottle::new());
    let auth = FtpAuthenticator::new(
        None,
        ServerActivity::new(),
        "198.51.100.7".parse().expect("ip"),
        Arc::clone(&throttle),
    );
    for _ in 0..MAX_FAILED_LOGINS * 2 {
        assert!(auth.authenticate("anyone", &creds(None)).await.is_ok());
    }
    assert!(!throttle.is_locked("198.51.100.7".parse().expect("ip")));
}
