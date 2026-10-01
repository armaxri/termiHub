#![cfg(feature = "ftp")]
//! FTP transfer-queue fault tests against the live FTP fixture (#1336, #4006).
//!
//! `ftp_transfer.rs` drives the queue executor ([`run_ftp_transfer`]) and the
//! streaming primitive on a healthy server. These tests break the server
//! **mid-transfer** and assert what the queue does about it:
//!
//!   * **FTP-FAULT-01** — the server drops the session mid-download: attempt 1
//!     fails (`failed 1/3`), the retry resumes from the partial offset via
//!     `REST`, and the file lands byte-exact.
//!   * **FTP-FAULT-02** — the container is stopped mid-download: every attempt
//!     fails until the budget is spent (`failed 3/3`, permanent). Once the
//!     container is back, a manual retry resumes and completes.
//!   * **FTP-FAULT-03** — cancelling an active download removes the partial
//!     local file.
//!   * **FTP-FAULT-04** — a user pause mid-download releases the transfer;
//!     resume continues from the offset and completes byte-exact.
//!
//! ## Mid-transfer, deterministically
//!
//! Downloads log in as the fixture's throttled `ftpslow` account (ProFTPD
//! `TransferRate` 256 KiB/s, see `tests/docker/ftp-server/proftpd.conf.tmpl`),
//! so a 1 MiB file takes ~4 s and the test can act after the first chunks land.
//! The payload is a non-repeating pattern uploaded first at full speed as
//! `ftpuser`, so a wrong resume offset cannot go unnoticed (the seeded `/pub`
//! binaries are zero-filled).
//!
//! These tests disturb the shared `ftp-server` container (they kill sessions
//! and stop/start it), so they are serialized in-source with
//! `#[serial(ftp_server)]`. Every container change is undone by a drop guard,
//! also when an assertion fails.
//!
//! ## Running
//!
//! ```bash
//! docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
//! cargo test -p termihub-core --features ftp --test ftp_transfer_faults -- --nocapture
//! ```
//!
//! Skips cleanly without the fixture (hard-fails under `TERMIHUB_REQUIRE_DOCKER=1`).

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{docker_cli, fixture_container, is_port_reachable, port_ftp, require_docker};
use serial_test::serial;

use termihub_core::backends::ftp::Ftp;
use termihub_core::backends::ftp::FtpDirection;
use termihub_core::config::FtpConfig;
use termihub_core::connection::ConnectionType;
use termihub_core::files::transfer::ftp::run_ftp_transfer;
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferHandle, TransferPhase, TransferProgress,
    TransferRegistry, TransferStateTag,
};

/// Payload size: ~4 s through the 256 KiB/s `ftpslow` throttle.
const PAYLOAD_LEN: usize = 1024 * 1024;
/// Act once this much has landed: clearly mid-flight, far from the end.
const MID_FLIGHT: u64 = 192 * 1024;
/// Upper bound for a whole faulted transfer (throttled bytes + retry backoff).
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(90);

// ── Helpers ──────────────────────────────────────────────────────────────────

fn config(username: &str) -> FtpConfig {
    FtpConfig {
        host: "127.0.0.1".to_string(),
        port: port_ftp(),
        username: username.to_string(),
        password: Some("ftppass".to_string()),
        // A stopped container must fail an attempt fast, not after 30 s.
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

fn settings(username: &str) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port_ftp(),
        "tlsMode": "none",
        "username": username,
        "password": "ftppass",
    })
}

/// A deterministic, non-repeating-per-chunk payload.
fn payload() -> Vec<u8> {
    (0..PAYLOAD_LEN).map(|i| (i % 251) as u8).collect()
}

/// The `ftp-server` container of this checkout.
fn ftp_container() -> String {
    fixture_container("ftp-server")
}

/// Upload `data` to a fresh per-test path under `/uploads` at full speed.
async fn seed_remote(tag: &str, data: &[u8]) -> String {
    let remote = format!("/uploads/th_fault_{}_{tag}.bin", std::process::id());
    let mut ftp = Ftp::new();
    ftp.connect(settings("ftpuser"))
        .await
        .expect("seed connect");
    let browser = ftp.file_browser().expect("file browser");
    browser
        .write_file(&remote, data)
        .await
        .expect("seed upload");
    ftp.disconnect().await.expect("seed disconnect");
    remote
}

/// Best-effort removal of a seeded remote file.
async fn remove_remote(remote: &str) {
    let mut ftp = Ftp::new();
    if ftp.connect(settings("ftpuser")).await.is_ok() {
        if let Some(browser) = ftp.file_browser() {
            let _ = browser.delete(remote).await;
        }
        let _ = ftp.disconnect().await;
    }
}

/// A queued download running on its own task, plus everything it emitted.
struct Download {
    registry: TransferRegistry,
    handle: Arc<TransferHandle>,
    events: Arc<Mutex<Vec<TransferProgress>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Download {
    /// Enqueue and start a throttled (`ftpslow`) download of `remote` to `local`.
    fn start(id: &str, remote: &str, local: &Path) -> Self {
        let registry = TransferRegistry::new();
        let handle = registry.enqueue(
            id,
            "ftp-fault-session",
            TransferDirection::Download,
            "payload.bin",
            remote,
            PAYLOAD_LEN as u64,
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorder = events.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            recorder.lock().expect("lock").push(p.clone());
        });
        let task = tokio::spawn(run_ftp_transfer(
            config("ftpslow"),
            FtpDirection::Download,
            remote.to_string(),
            local.to_str().expect("utf8 path").to_string(),
            handle.clone(),
            registry.clone(),
            sink,
            0,
        ));
        Self {
            registry,
            handle,
            events,
            task,
        }
    }

    fn id(&self) -> String {
        self.handle.transfer_id.clone()
    }

    /// Wait until at least `bytes` have landed (and the transfer is still
    /// short of the end, so the caller acts mid-flight).
    async fn wait_for_bytes(&self, bytes: u64) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let snap = self.handle.snapshot();
            if snap.transferred >= bytes {
                assert!(
                    snap.transferred < PAYLOAD_LEN as u64,
                    "the transfer finished before the test could act (throttle missing?)"
                );
                return snap.transferred;
            }
            assert!(
                Instant::now() < deadline,
                "transfer never reached {bytes} bytes: {snap:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Wait until the handle reports `state` (and, if given, `attempt`).
    async fn wait_for_state(&self, state: TransferStateTag, attempt: Option<u32>) {
        let deadline = Instant::now() + TRANSFER_TIMEOUT;
        loop {
            let snap = self.handle.snapshot();
            if snap.state == state && attempt.is_none_or(|a| snap.attempt == a) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "transfer never reached {state:?} (attempt {attempt:?}): {snap:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Wait for the executor task to finish.
    async fn finish(self) -> (Arc<TransferHandle>, Vec<TransferProgress>) {
        tokio::time::timeout(TRANSFER_TIMEOUT, self.task)
            .await
            .expect("the transfer task finishes in time")
            .expect("the transfer task does not panic");
        let events = self.events.lock().expect("lock").clone();
        (self.handle, events)
    }

    fn events(&self) -> Vec<TransferProgress> {
        self.events.lock().expect("lock").clone()
    }
}

/// Kill every live `ftpslow` session process in the container — a server-side
/// drop of the control and data connections. The daemon keeps accepting.
fn kill_slow_sessions() {
    let out = docker_cli(&[
        "exec",
        &ftp_container(),
        "pkill",
        "-KILL",
        "-f",
        "^proftpd: ftpslow",
    ]);
    assert!(
        out.is_ok(),
        "no ftpslow session to kill ({out:?}); processes:\n{}",
        docker_cli(&["exec", &ftp_container(), "ps", "-eo", "pid,args"]).unwrap_or_default()
    );
}

/// Wait until the FTP fixture accepts a login again.
async fn wait_for_login() {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if is_port_reachable("127.0.0.1", port_ftp()) {
            let mut ftp = Ftp::new();
            if ftp.connect(settings("ftpuser")).await.is_ok() {
                let _ = ftp.disconnect().await;
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the FTP fixture did not come back"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Starts the `ftp-server` container on drop, so a stopped fixture never
/// outlives the test that stopped it — also when an assertion panics.
struct RestartOnDrop;

impl Drop for RestartOnDrop {
    fn drop(&mut self) {
        let _ = docker_cli(&["start", &ftp_container()]);
    }
}

/// The local file holds exactly `expected`.
fn assert_local_bytes(local: &Path, expected: &[u8]) {
    let got = std::fs::read(local).expect("read the downloaded file");
    assert_eq!(got.len(), expected.len(), "downloaded size");
    assert!(got == expected, "the downloaded file is byte-exact");
}

/// Every event after the first failure reports at least the offset the failure
/// left behind: the retry resumed from the partial instead of restarting.
fn assert_resumed_after_failure(events: &[TransferProgress]) {
    let failed_at = events
        .iter()
        .position(|e| e.state == TransferStateTag::Failed)
        .expect("a failed attempt was reported");
    let offset = events[failed_at].transferred;
    assert!(offset > 0, "the failure left a partial behind");
    for e in &events[failed_at..] {
        assert!(
            e.transferred >= offset,
            "progress went back to {} after failing at {offset}: the retry restarted",
            e.transferred
        );
        if let Some(msg) = &e.message {
            assert!(!msg.contains("restarting"), "no restart from zero: {msg}");
        }
    }
}

// ── FTP-FAULT-01: session drop mid-download → retry resumes (failed 1/3) ─────

#[tokio::test]
#[serial(ftp_server)]
async fn ftp_fault_01_session_drop_retries_and_resumes() {
    require_docker!(port_ftp());

    let data = payload();
    let remote = seed_remote("drop", &data).await;
    let tmp = tempfile::tempdir().expect("tempdir");
    let local = tmp.path().join("payload.bin");

    let download = Download::start("fault-01", &remote, &local);
    download.wait_for_bytes(MID_FLIGHT).await;
    kill_slow_sessions();
    let (handle, events) = download.finish().await;
    remove_remote(&remote).await;

    let snap = handle.snapshot();
    assert_eq!(snap.state, TransferStateTag::Completed, "{snap:?}");
    assert_eq!(
        snap.attempt, 2,
        "one failed attempt, then a successful retry"
    );
    let failure = events
        .iter()
        .find(|e| e.state == TransferStateTag::Failed)
        .expect("the dropped attempt is reported");
    assert_eq!(
        failure.attempt, 1,
        "reported as failed 1/{}",
        failure.max_attempts
    );
    assert_eq!(failure.max_attempts, 3);
    assert!(failure.message.is_some(), "the failure carries its error");
    assert_resumed_after_failure(&events);
    assert_eq!(
        events.last().map(|e| e.phase),
        Some(TransferPhase::Done),
        "the row ends Done"
    );
    assert_local_bytes(&local, &data);
}

// ── FTP-FAULT-02: container stopped mid-download → permanent failure (3/3) ───

#[tokio::test]
#[serial(ftp_server)]
async fn ftp_fault_02_container_down_exhausts_retries_then_manual_retry_resumes() {
    require_docker!(port_ftp());

    let data = payload();
    let remote = seed_remote("down", &data).await;
    let tmp = tempfile::tempdir().expect("tempdir");
    let local = tmp.path().join("payload.bin");

    let download = Download::start("fault-02", &remote, &local);
    let restart = RestartOnDrop;
    download.wait_for_bytes(MID_FLIGHT).await;
    docker_cli(&["stop", "-t", "1", &ftp_container()]).expect("stop the FTP fixture");

    // Every attempt fails against the stopped server until the budget is spent.
    download
        .wait_for_state(TransferStateTag::Failed, Some(3))
        .await;
    let events = download.events();
    let permanent = events
        .iter()
        .find(|e| e.phase == TransferPhase::Error)
        .expect("a permanent failure is reported");
    assert_eq!(permanent.state, TransferStateTag::Failed);
    assert_eq!(permanent.attempt, 3, "reported as failed 3/3");
    assert!(permanent.message.is_some(), "the failure carries its error");
    let attempts: Vec<u32> = events
        .iter()
        .filter(|e| e.state == TransferStateTag::Failed)
        .map(|e| e.attempt)
        .collect();
    assert_eq!(attempts, vec![1, 2, 3], "failed 1/3, 2/3, then 3/3");
    let partial = std::fs::metadata(&local).map(|m| m.len()).unwrap_or(0);
    assert!(
        partial > 0 && partial < PAYLOAD_LEN as u64,
        "the partial download is kept for a retry ({partial} bytes)"
    );

    // Bring the server back; a manual retry resumes and completes.
    docker_cli(&["start", &ftp_container()]).expect("start the FTP fixture");
    drop(restart);
    wait_for_login().await;
    assert!(
        download.registry.retry(&download.id()),
        "manual retry accepted"
    );
    let (handle, events) = download.finish().await;
    remove_remote(&remote).await;

    assert_eq!(
        handle.snapshot().state,
        TransferStateTag::Completed,
        "events: {:#?}",
        events
            .iter()
            .map(|e| (
                e.state,
                e.phase,
                e.attempt,
                e.transferred,
                e.message.clone()
            ))
            .collect::<Vec<_>>()
    );
    assert_resumed_after_failure(&events);
    assert_local_bytes(&local, &data);
}

// ── FTP-FAULT-03: cancel mid-download removes the partial ────────────────────

#[tokio::test]
#[serial(ftp_server)]
async fn ftp_fault_03_cancel_removes_partial_download() {
    require_docker!(port_ftp());

    let data = payload();
    let remote = seed_remote("cancel", &data).await;
    let tmp = tempfile::tempdir().expect("tempdir");
    let local = tmp.path().join("payload.bin");

    let download = Download::start("fault-03", &remote, &local);
    download.wait_for_bytes(MID_FLIGHT).await;
    assert!(local.exists(), "the partial exists while downloading");
    assert!(download.registry.cancel(&download.id()), "cancel accepted");
    let (handle, events) = download.finish().await;
    remove_remote(&remote).await;

    assert_eq!(handle.snapshot().state, TransferStateTag::Cancelled);
    assert_eq!(
        events.last().map(|e| e.phase),
        Some(TransferPhase::Cancelled),
        "the row ends Cancelled"
    );
    assert!(!local.exists(), "cancel removed the partial download");
}

// ── FTP-FAULT-04: user pause mid-download, then resume ───────────────────────

#[tokio::test]
#[serial(ftp_server)]
async fn ftp_fault_04_pause_then_resume_completes() {
    require_docker!(port_ftp());

    let data = payload();
    let remote = seed_remote("pause", &data).await;
    let tmp = tempfile::tempdir().expect("tempdir");
    let local = tmp.path().join("payload.bin");

    let download = Download::start("fault-04", &remote, &local);
    download.wait_for_bytes(MID_FLIGHT).await;
    assert!(download.registry.pause(&download.id()), "pause accepted");
    download
        .wait_for_state(TransferStateTag::Paused, None)
        .await;
    let paused_at = download.handle.snapshot().transferred;
    assert!(
        paused_at > 0 && paused_at < PAYLOAD_LEN as u64,
        "paused mid-flight at {paused_at}"
    );
    // Nothing moves while paused.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(download.handle.snapshot().transferred, paused_at);

    assert!(download.registry.resume(&download.id()), "resume accepted");
    let (handle, events) = download.finish().await;
    remove_remote(&remote).await;

    assert_eq!(handle.snapshot().state, TransferStateTag::Completed);
    let resumed_from = events
        .iter()
        .skip_while(|e| e.state != TransferStateTag::Paused)
        .find(|e| e.state == TransferStateTag::Active)
        .map(|e| e.transferred)
        .expect("an Active event after the pause");
    assert!(
        resumed_from >= paused_at,
        "resumed from {resumed_from}, not from the pause offset {paused_at}"
    );
    assert_local_bytes(&local, &data);
}
