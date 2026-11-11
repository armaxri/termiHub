//! Two SFTP sessions to one server as one user reach one filesystem
//! (#5355), driven over the in-process SFTP-only test server so the real
//! handshake and the server's `realpath` run.
//!
//! A copy between them of a file onto itself is refused before the
//! destination is opened; the same path on another server is not.

use async_trait::async_trait;

use super::*;
use crate::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier};
use crate::backends::ssh::sftp_only_test_server::{serve, PASSWORD, USER};
use crate::files::transfer::remote_copy::{ensure_copy_across_allowed, RemoteCopyEndpoint};

/// Trusts the test server's key without consulting any trust store.
struct TrustAll;

#[async_trait]
impl HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &HostKeyInfo) -> bool {
        true
    }
}

fn config(host: &str, port: u16) -> SshConfig {
    SshConfig {
        host: host.to_string(),
        port,
        username: USER.to_string(),
        auth_method: "password".to_string(),
        password: Some(PASSWORD.to_string()),
        ..SshConfig::default()
    }
}

/// An SFTP session to its own in-process server, as `config` names it.
async fn sftp_end(config: SshConfig) -> RemoteCopyEndpoint {
    let (stream, _observed) = serve();
    let (session, _registry, _liveness) = super::super::auth::handshake_and_authenticate_with(
        &config,
        stream,
        Some(Arc::new(TrustAll)),
    )
    .await
    .expect("login");
    let session = Arc::new(session);
    let sftp = sftp::open_sftp_subsystem(&session)
        .await
        .expect("sftp subsystem");
    let browser = SftpFileBrowser {
        config,
        state: Arc::new(Mutex::new(Some(SftpState {
            session,
            _gateway: None,
            sftp,
        }))),
    };
    RemoteCopyEndpoint::Sftp(Arc::new(browser))
}

/// Two sessions with the same server, port and user are one filesystem: a
/// copy onto the source, however it is spelled on the other session, is
/// refused, and the source keeps its bytes.
#[tokio::test]
async fn two_sessions_to_one_server_refuse_a_copy_onto_itself() {
    let a = sftp_end(config("files-5355.invalid", 22)).await;
    let b = sftp_end(config("FILES-5355.invalid", 22)).await;
    // `etc/hostname` only the server resolves (relative to its root).
    for dest in ["/etc/hostname", "/etc/../etc/hostname", "etc/hostname"] {
        let err = ensure_copy_across_allowed(&a, "/etc/hostname", &b, dest)
            .await
            .expect_err(&format!("{dest} is the source"));
        assert_eq!(
            err.to_string(),
            format!(
                "Operation failed: copy /etc/hostname to {dest} refused: \
                 source and destination are the same file"
            )
        );
    }
    let RemoteCopyEndpoint::Sftp(browser) = &a else {
        panic!("an SFTP end")
    };
    // The server is read-only and cannot open a file; its size shows the
    // source untouched.
    assert_eq!(
        browser.stat("/etc/hostname").await.expect("stat").size,
        b"sftp-only\n".len() as u64
    );
    ensure_copy_across_allowed(&a, "/etc/hostname", &b, "/etc/hosts.bak")
        .await
        .expect("another file on the same server copies");
}

/// Another port, user or host is another filesystem as far as the guard can
/// tell: the same path there copies normally.
#[tokio::test]
async fn the_same_path_on_another_server_is_never_refused() {
    let a = sftp_end(config("files-5355.invalid", 22)).await;
    let mut other_user = config("files-5355.invalid", 22);
    other_user.username = "someone-else".to_string();
    for other in [
        config("files-5355.invalid", 2222),
        config("other-5355.invalid", 22),
    ] {
        let b = sftp_end(other).await;
        ensure_copy_across_allowed(&a, "/etc/hostname", &b, "/etc/hostname")
            .await
            .expect("another server");
    }
    // The identity alone decides: a different login is not checked at all.
    let b = RemoteCopyEndpoint::Sftp(Arc::new(SftpFileBrowser::new(other_user)));
    ensure_copy_across_allowed(&a, "/etc/hostname", &b, "/etc/hostname")
        .await
        .expect("another user");
}
