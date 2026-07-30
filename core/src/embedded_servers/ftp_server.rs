//! FTP server powered by [`libunftp`].
//!
//! Replaces the former hand-rolled RFC 959 implementation with the actively
//! maintained [`libunftp`] crate backed by [`unftp_sbe_fs::Filesystem`].
//! Authentication and optional read-only mode are preserved.

use std::fmt::Debug;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use libunftp::auth::{AuthenticationError, Authenticator, Credentials, DefaultUser, UserDetail};
use libunftp::notification::{DataEvent, DataListener, EventMeta, PresenceEvent, PresenceListener};
use libunftp::storage::{ErrorKind as StorageErrorKind, Fileinfo, StorageBackend};
use libunftp::ServerBuilder;
use unftp_sbe_fs::Filesystem;

use super::config::{AtomicServerStats, EmbeddedServerConfig, FtpAuth};
use super::service::BindSignal;

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the FTP server in the current thread, blocking until `shutdown` is set.
///
/// Internally this creates a single-threaded tokio runtime so that the async
/// libunftp server can run inside the OS thread that the `EmbeddedServerManager`
/// already spawned. `ready` is signalled exactly once once the control port is
/// confirmed bindable (or if binding fails), so the manager only reports
/// `Running` after the bind is confirmed (GAP G3, #1145).
pub fn start_ftp_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build tokio runtime for FTP server")
    {
        Ok(rt) => rt,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    rt.block_on(run_ftp_server(config, shutdown, stats, ready))
}

async fn run_ftp_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let root: PathBuf = config.root_directory.clone().into();
    let addr = format!("{}:{}", config.bind_host, config.port);
    let read_only = config.read_only;

    let root_for_factory = root.clone();
    let server = match ServerBuilder::new(Box::new(move || MaybeReadOnlyFilesystem {
        inner: Filesystem::new(root_for_factory.clone()),
        read_only,
    }))
    .authenticator(Arc::new(FtpAuthenticator::new(config.ftp_auth.clone())))
    .passive_ports(49152..65535)
    .greeting("termiHub FTP Server ready.")
    .notify_data(StatsTracker {
        stats: Arc::clone(&stats),
    })
    .notify_presence(StatsTracker {
        stats: Arc::clone(&stats),
    })
    .build()
    .context("Failed to build libunftp server")
    {
        Ok(server) => server,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    // libunftp binds the control port inside `listen`, with no bound-callback.
    // Probe-bind the control port ourselves so we can confirm (or fail) the
    // bind before reporting Running; drop the probe immediately so libunftp can
    // take the port (GAP G3, #1145).
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(probe) => {
            drop(probe);
            ready.confirm();
        }
        Err(e) => {
            let msg = format!("Failed to bind FTP server to {addr}: {e}");
            ready.fail(&msg);
            return Err(anyhow::anyhow!(msg));
        }
    }

    tracing::info!(addr, "FTP server listening (libunftp)");

    tokio::select! {
        result = server.listen(&addr) => {
            result.map_err(|e| anyhow::anyhow!("FTP server error: {e}"))?;
        }
        _ = poll_shutdown(shutdown) => {
            tracing::info!("FTP server shutting down");
        }
    }

    Ok(())
}

async fn poll_shutdown(shutdown: Arc<AtomicBool>) {
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ─── Storage backend: optional read-only wrapper ──────────────────────────────

/// Wraps `Filesystem` and optionally rejects all write operations.
#[derive(Debug)]
struct MaybeReadOnlyFilesystem {
    inner: Filesystem,
    read_only: bool,
}

#[async_trait]
impl<User: UserDetail> StorageBackend<User> for MaybeReadOnlyFilesystem {
    type Metadata = unftp_sbe_fs::Meta;

    fn enter(&mut self, user_detail: &User) -> io::Result<()> {
        self.inner.enter(user_detail)
    }

    async fn metadata<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<Self::Metadata> {
        self.inner.metadata(user, path).await
    }

    async fn list<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<Vec<Fileinfo<PathBuf, Self::Metadata>>> {
        self.inner.list(user, path).await
    }

    async fn get<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
        start_pos: u64,
    ) -> libunftp::storage::Result<Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin>> {
        self.inner.get(user, path, start_pos).await
    }

    async fn put<
        P: AsRef<Path> + Send + Debug,
        R: tokio::io::AsyncRead + Send + Sync + Unpin + 'static,
    >(
        &self,
        user: &User,
        input: R,
        path: P,
        start_pos: u64,
    ) -> libunftp::storage::Result<u64> {
        if self.read_only {
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        self.inner.put(user, input, path, start_pos).await
    }

    async fn del<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<()> {
        if self.read_only {
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        self.inner.del(user, path).await
    }

    async fn mkd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<()> {
        if self.read_only {
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        self.inner.mkd(user, path).await
    }

    async fn rename<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        from: P,
        to: P,
    ) -> libunftp::storage::Result<()> {
        if self.read_only {
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        self.inner.rename(user, from, to).await
    }

    async fn rmd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<()> {
        if self.read_only {
            return Err(StorageErrorKind::PermissionDenied.into());
        }
        self.inner.rmd(user, path).await
    }

    async fn cwd<P: AsRef<Path> + Send + Debug>(
        &self,
        user: &User,
        path: P,
    ) -> libunftp::storage::Result<()> {
        self.inner.cwd(user, path).await
    }
}

// ─── Authentication ───────────────────────────────────────────────────────────

#[derive(Debug)]
struct FtpAuthenticator {
    auth: Option<FtpAuth>,
}

impl FtpAuthenticator {
    fn new(auth: Option<FtpAuth>) -> Self {
        Self { auth }
    }
}

#[async_trait]
impl Authenticator<DefaultUser> for FtpAuthenticator {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<DefaultUser, AuthenticationError> {
        match &self.auth {
            None | Some(FtpAuth::Anonymous) => Ok(DefaultUser),
            Some(FtpAuth::Credentials {
                username: expected_user,
                password: expected_pass,
            }) => {
                let pass_ok = creds
                    .password
                    .as_deref()
                    .map(|pw| pw == expected_pass.as_str())
                    .unwrap_or(false);
                if username == expected_user.as_str() && pass_ok {
                    Ok(DefaultUser)
                } else {
                    Err(AuthenticationError::BadPassword)
                }
            }
        }
    }
}

// ─── Stats tracking ───────────────────────────────────────────────────────────

#[derive(Debug)]
struct StatsTracker {
    stats: Arc<AtomicServerStats>,
}

#[async_trait]
impl DataListener for StatsTracker {
    async fn receive_data_event(&self, e: DataEvent, _m: EventMeta) {
        match e {
            DataEvent::Got { bytes, .. } => {
                self.stats.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
            }
            DataEvent::Put { bytes, .. } => {
                self.stats
                    .bytes_received
                    .fetch_add(bytes, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

#[async_trait]
impl PresenceListener for StatsTracker {
    async fn receive_presence_event(&self, e: PresenceEvent, _m: EventMeta) {
        match e {
            PresenceEvent::LoggedIn => {
                self.stats
                    .active_connections
                    .fetch_add(1, Ordering::Relaxed);
                self.stats.total_connections.fetch_add(1, Ordering::Relaxed);
            }
            PresenceEvent::LoggedOut => {
                self.stats
                    .active_connections
                    .fetch_sub(1, Ordering::Relaxed);
            }
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_servers::config::AtomicServerStats;

    // ── FtpAuthenticator ──────────────────────────────────────────────────────

    fn creds(password: Option<&str>) -> Credentials {
        Credentials {
            password: password.map(str::to_owned),
            certificate_chain: None,
            source_ip: "127.0.0.1".parse().unwrap(),
        }
    }

    #[tokio::test]
    async fn auth_no_config_allows_any() {
        let auth = FtpAuthenticator::new(None);
        assert!(auth.authenticate("anyone", &creds(None)).await.is_ok());
        assert!(auth
            .authenticate("anyone", &creds(Some("anything")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn auth_anonymous_allows_any() {
        let auth = FtpAuthenticator::new(Some(FtpAuth::Anonymous));
        assert!(auth.authenticate("anonymous", &creds(None)).await.is_ok());
        assert!(auth.authenticate("bob", &creds(Some("pass"))).await.is_ok());
    }

    #[tokio::test]
    async fn auth_credentials_correct_pass() {
        let auth = FtpAuthenticator::new(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(auth
            .authenticate("alice", &creds(Some("secret")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn auth_credentials_wrong_pass() {
        let auth = FtpAuthenticator::new(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("alice", &creds(Some("wrong")))
                .await
                .unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    #[tokio::test]
    async fn auth_credentials_wrong_user() {
        let auth = FtpAuthenticator::new(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("eve", &creds(Some("secret")))
                .await
                .unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    #[tokio::test]
    async fn auth_credentials_no_password() {
        let auth = FtpAuthenticator::new(Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }));
        assert!(matches!(
            auth.authenticate("alice", &creds(None)).await.unwrap_err(),
            AuthenticationError::BadPassword
        ));
    }

    // ── StatsTracker ─────────────────────────────────────────────────────────

    fn meta() -> EventMeta {
        EventMeta {
            username: "user".into(),
            trace_id: "trace".into(),
            sequence_number: 0,
        }
    }

    #[tokio::test]
    async fn stats_login_logout() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };

        tracker
            .receive_presence_event(PresenceEvent::LoggedIn, meta())
            .await;
        tracker
            .receive_presence_event(PresenceEvent::LoggedIn, meta())
            .await;

        let snap = stats.snapshot();
        assert_eq!(snap.active_connections, 2);
        assert_eq!(snap.total_connections, 2);

        tracker
            .receive_presence_event(PresenceEvent::LoggedOut, meta())
            .await;
        assert_eq!(stats.active_connections.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn stats_data_bytes() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };

        tracker
            .receive_data_event(
                DataEvent::Got {
                    path: "file.txt".into(),
                    bytes: 1024,
                },
                meta(),
            )
            .await;
        tracker
            .receive_data_event(
                DataEvent::Put {
                    path: "upload.txt".into(),
                    bytes: 512,
                },
                meta(),
            )
            .await;

        let snap = stats.snapshot();
        assert_eq!(snap.bytes_sent, 1024);
        assert_eq!(snap.bytes_received, 512);
    }

    #[tokio::test]
    async fn stats_untracked_events_do_not_panic() {
        let stats = AtomicServerStats::new();
        let tracker = StatsTracker {
            stats: Arc::clone(&stats),
        };
        // Should simply do nothing for non-byte events.
        tracker
            .receive_data_event(DataEvent::Deleted { path: "x".into() }, meta())
            .await;
        tracker
            .receive_data_event(
                DataEvent::Renamed {
                    from: "a".into(),
                    to: "b".into(),
                },
                meta(),
            )
            .await;
        let snap = stats.snapshot();
        assert_eq!(snap.bytes_sent, 0);
        assert_eq!(snap.bytes_received, 0);
    }
}
