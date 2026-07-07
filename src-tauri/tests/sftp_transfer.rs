//! Docker SFTP integration tests for the cancellable chunked transfer
//! subsystem (issue #1245).
//!
//! These exercise the real D1 behaviour against the pre-populated
//! `sftp-stress` container (Docker Compose `stress` profile, port 2210):
//!
//! 1. **cancel-mid-transfer** — a download of a large file is cancelled while
//!    in flight; the partial destination file is removed and the terminal
//!    `cancelled` progress event fires.
//! 2. **concurrent-transfer-while-browsing liveness** — a `list_dir` on the
//!    browsing session completes promptly while a large transfer runs on a
//!    dedicated channel, proving the copy does not hold the session mutex.
//!
//! The tests skip gracefully when the container is not reachable, mirroring
//! `core/tests`' runtime skip convention. Requires:
//! `docker compose -f tests/docker/docker-compose.yml --profile stress up -d`.

#![cfg(unix)]

use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_core::config::SshConfig;
use termihub_lib::files::sftp::{lock_session, SftpManager, SftpSession};
use termihub_lib::files::transfer::{
    run_download, ProgressSink, TransferContext, TransferDirection, TransferPhase,
    TransferProgress, TransferRegistry,
};

/// Resolve the sftp-stress container port (per-checkout offset aware), matching
/// `core/tests/common`'s `port_sftp_stress`.
fn sftp_stress_port() -> u16 {
    if let Some(p) = std::env::var("TERMIHUB_TEST_SFTP_STRESS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return p;
    }
    let offset: u16 = std::env::var("TERMIHUB_TEST_PORT_OFFSET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    2210 + offset
}

fn is_port_reachable(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok())
        .unwrap_or(false)
}

/// Skip the current test if the sftp-stress container is not reachable.
macro_rules! require_sftp_stress {
    ($port:expr) => {
        if !is_port_reachable($port) {
            eprintln!(
                "SKIPPED: sftp-stress container not reachable on port {} \
                 (start with `docker compose -f tests/docker/docker-compose.yml --profile stress up -d`)",
                $port
            );
            return;
        }
    };
}

fn stress_config(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "testuser".to_string(),
        auth_method: "password".to_string(),
        password: Some("testpass".to_string()),
        ..SshConfig::default()
    }
}

/// A progress sink that records every emitted payload, so tests can assert on
/// the transfer lifecycle without a Tauri `AppHandle`.
#[derive(Clone, Default)]
struct RecordingSink {
    events: Arc<Mutex<Vec<TransferProgress>>>,
}

impl RecordingSink {
    fn as_sink(&self) -> ProgressSink {
        let events = self.events.clone();
        Arc::new(move |p: &TransferProgress| {
            events.lock().expect("sink mutex").push(p.clone());
        })
    }

    fn terminal_phase(&self) -> Option<TransferPhase> {
        self.events
            .lock()
            .expect("sink mutex")
            .last()
            .map(|p| p.phase)
    }
}

/// Open a session against the container and return the manager (kept alive) and
/// the session Arc.
async fn connect() -> (SftpManager, Arc<Mutex<SftpSession>>) {
    let manager = SftpManager::new();
    let config = stress_config(sftp_stress_port());
    let mgr = manager.clone();
    let session_id = tokio::task::spawn_blocking(move || mgr.open_session(&config))
        .await
        .expect("join")
        .expect("SFTP session should open");
    let session = manager
        .get_session(&session_id)
        .expect("session should exist");
    (manager, session)
}

/// Open a dedicated SFTP channel off `session` (mirrors the command layer):
/// lock briefly and drive the async open under `block_in_place` so the std
/// guard never spans an `.await`.
async fn open_dedicated(
    session: Arc<Mutex<SftpSession>>,
) -> russh_sftp::client::SftpSession {
    tokio::task::spawn_blocking(move || {
        let guard = lock_session(&session).expect("lock");
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(async { guard.open_dedicated_sftp().await })
        })
    })
    .await
    .expect("join")
    .expect("dedicated SFTP channel should open")
}

/// Cancel-mid-transfer: the partial local file is removed and the terminal
/// `cancelled` event fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_mid_transfer_cleans_up_partial_file() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let (_manager, session) = connect().await;
    let dedicated = open_dedicated(session).await;

    let dest = std::env::temp_dir().join(format!("termihub-cancel-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let transfer_id = "cancel-test".to_string();
    let token = registry.register(&transfer_id);
    let sink = RecordingSink::default();
    let ctx = TransferContext {
        transfer_id: transfer_id.clone(),
        session_id: "s".to_string(),
        direction: TransferDirection::Download,
        file_name: "100mb.bin".to_string(),
        total: 100 * 1024 * 1024,
    };

    // Cancel almost immediately so the copy stops after an early chunk boundary
    // with the destination only partially written.
    let cancel_token = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_token.cancel();
    });

    run_download(
        dedicated,
        "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
        dest_str.clone(),
        ctx,
        token,
        registry.clone(),
        sink.as_sink(),
    )
    .await;

    assert_eq!(
        sink.terminal_phase(),
        Some(TransferPhase::Cancelled),
        "a cancelled transfer must end on the `cancelled` phase"
    );
    assert!(
        !dest.exists(),
        "the partial destination file must be removed on cancel"
    );
    assert!(
        !registry_contains(&registry, &transfer_id),
        "the registry entry must be dropped after the transfer settles"
    );
}

/// Helper: registry has no public `contains` outside tests, so probe via cancel
/// (a dropped entry returns false).
fn registry_contains(registry: &TransferRegistry, id: &str) -> bool {
    registry.cancel(id)
}

/// Concurrent-transfer-while-browsing liveness: a `list_dir` on the browsing
/// session completes promptly while a large transfer runs on a dedicated
/// channel.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browsing_stays_live_during_transfer() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let (_manager, session) = connect().await;
    let dedicated = open_dedicated(session.clone()).await;

    let dest = std::env::temp_dir().join(format!("termihub-live-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let token = registry.register("live-test");
    let sink = RecordingSink::default();
    let ctx = TransferContext {
        transfer_id: "live-test".to_string(),
        session_id: "s".to_string(),
        direction: TransferDirection::Download,
        file_name: "100mb.bin".to_string(),
        total: 100 * 1024 * 1024,
    };

    // Start the large transfer in the background on the dedicated channel.
    let transfer = tokio::spawn(async move {
        run_download(
            dedicated,
            "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
            dest_str,
            ctx,
            token,
            registry,
            sink.as_sink(),
        )
        .await;
    });

    // While it runs, a directory listing on the browsing session must complete
    // promptly (the copy does not hold the session mutex).
    let list_session = session.clone();
    let start = Instant::now();
    let entries = tokio::task::spawn_blocking(move || {
        lock_session(&list_session)?.list_dir("/home/testuser/sftp-test/large-files")
    })
    .await
    .expect("join")
    .expect("list_dir on the browsing session should succeed during a transfer");
    let elapsed = start.elapsed();

    assert!(
        !entries.is_empty(),
        "the large-files directory should list entries"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "list_dir should complete promptly while a transfer runs, took {elapsed:?}"
    );

    // Let the transfer finish / clean up.
    let _ = tokio::time::timeout(Duration::from_secs(60), transfer).await;
    let _ = std::fs::remove_file(&dest);
}
