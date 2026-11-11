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

/// Run `test` against the in-process servers, failing instead of hanging
/// when a server stops answering.
async fn bounded(test: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(std::time::Duration::from_secs(30), test)
        .await
        .expect("the test server answers");
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
        identity: None,
    };
    RemoteCopyEndpoint::Sftp(Arc::new(browser))
}

/// Two sessions with the same server, port and user are one filesystem: a
/// copy onto the source, however it is spelled on the other session, is
/// refused, and the source keeps its bytes.
#[tokio::test]
async fn two_sessions_to_one_server_refuse_a_copy_onto_itself() {
    bounded(async {
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
    })
    .await;
}

/// Another port, user or host is another filesystem as far as the guard can
/// tell: the same path there copies normally.
#[tokio::test]
async fn the_same_path_on_another_server_is_never_refused() {
    bounded(async {
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
    })
    .await;
}

/// One loopback server under two of its names (#5430) is only a hint: the
/// guard refuses once the source shows the same entry through both
/// sessions. Both sessions here reach servers serving one fixed tree, so
/// they show one entry.
#[tokio::test]
async fn a_loopback_server_under_two_names_refuses_a_copy_onto_itself() {
    bounded(async {
        let a = sftp_end(config("localhost", 2222)).await;
        let b = sftp_end(config("127.0.0.1", 2222)).await;
        let err = ensure_copy_across_allowed(&a, "/etc/hostname", &b, "/etc/hostname")
            .await
            .expect_err("the same entry through both names");
        assert!(err.to_string().ends_with("same file"), "{err}");
        ensure_copy_across_allowed(&a, "/etc/hostname", &b, "/etc/hosts.bak")
            .await
            .expect("another file copies");
        // Another port is another server, entry or not.
        let c = sftp_end(config("127.0.0.1", 2200)).await;
        ensure_copy_across_allowed(&a, "/etc/hostname", &c, "/etc/hostname")
            .await
            .expect("another port");
    })
    .await;
}

/// A browser riding a session another owner dialled (a VNC tunnel's, a
/// linked saved connection's), identified with `config` or not (#5439).
async fn riding_end(config: &SshConfig, identified: bool) -> RemoteCopyEndpoint {
    let (stream, _observed) = serve();
    let (session, _registry, _liveness) = super::super::auth::handshake_and_authenticate_with(
        config,
        stream,
        Some(Arc::new(TrustAll)),
    )
    .await
    .expect("login");
    let session = Arc::new(session);
    let browser = if identified {
        SftpFileBrowser::from_session_identified(
            session,
            crate::files::shared_fs::FilesystemIdentity::ssh(config),
        )
        .await
    } else {
        SftpFileBrowser::from_session(session).await
    }
    .expect("sftp on the borrowed session");
    RemoteCopyEndpoint::Sftp(Arc::new(browser))
}

/// A side-channel browser identified with its owner's config is the server
/// a direct session reaches: a copy onto itself between them is refused.
/// Unidentified, or identified as another server, it is never refused.
#[tokio::test]
async fn a_side_channel_browser_is_the_server_its_owner_dialled() {
    bounded(async {
        let server = config("files-5439.invalid", 22);
        let direct = sftp_end(server.clone()).await;
        let side = riding_end(&server, true).await;
        let err = ensure_copy_across_allowed(&side, "/etc/hostname", &direct, "/etc/hostname")
            .await
            .expect_err("the same file through the side channel");
        assert!(err.to_string().ends_with("same file"), "{err}");
        let RemoteCopyEndpoint::Sftp(browser) = &side else {
            panic!("an SFTP end")
        };
        assert_eq!(
            browser.filesystem_id(),
            crate::files::shared_fs::FilesystemId::ssh(&server)
        );

        let anonymous = riding_end(&server, false).await;
        ensure_copy_across_allowed(&anonymous, "/etc/hostname", &direct, "/etc/hostname")
            .await
            .expect("no identity, no refusal");
        let elsewhere = riding_end(&config("other-5439.invalid", 22), true).await;
        ensure_copy_across_allowed(&elsewhere, "/etc/hostname", &direct, "/etc/hostname")
            .await
            .expect("another server");
    })
    .await;
}
