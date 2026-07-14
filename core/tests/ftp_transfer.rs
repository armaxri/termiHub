#![cfg(feature = "ftp")]
//! FTP live transfer integration tests (issue #1507).
//!
//! Exercises the streaming data-plane primitive
//! [`termihub_core::backends::ftp::run_attempt`] (issue #1336) against the seeded
//! FTP Docker fixture. Where the unit tests in
//! `core/src/backends/ftp/transfer.rs` only cover the value types, these tests
//! drive real bytes over a real ProFTPD server and assert:
//!
//!   * **byte-exact download** of a known 1 MiB fixture file (RETR),
//!   * **byte-exact upload** of a deterministic payload (STOR) verified by a
//!     download round-trip,
//!   * **`REST`-based resume** in both directions — a transfer is interrupted
//!     mid-flight via the `should_stop` probe, then resumed from the partial
//!     offset, and the final file is byte-identical to a full transfer,
//!   * **concurrent transfers use separate data connections** — two downloads
//!     and a live directory listing all run at once, because every
//!     `run_attempt` (and the browser) opens its own control+data connection.
//!
//! ## Fixture
//!
//! Container `ftp-server` (ProFTPD), plain FTP on host port **2401** → container
//! `:21`. Login `ftpuser` / `ftppass` reads the whole tree and writes into
//! `/uploads`. The read-only `/pub` tree has fixed sizes + fixed content; keep
//! the constants below in sync with
//! `tests/docker/ftp-server/generate-test-data.sh`. `REST`-based upload resume
//! additionally requires `AllowStoreRestart on` in
//! `tests/docker/ftp-server/proftpd.conf.tmpl` (RETR restart is on by default).
//!
//! ## Running
//!
//! ```bash
//! # Bring the fixture up (waits for the port-21 healthcheck):
//! docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
//!
//! # Run this suite (the `ftp` feature gates the whole file):
//! cargo test -p termihub-core --features ftp --test ftp_transfer -- --nocapture
//!
//! # Tear down when done:
//! docker compose -f tests/docker/docker-compose.yml --profile ftp down -v
//! ```
//!
//! Without the fixture up, every test **skips cleanly** via `require_docker!`
//! (a runtime port-reachability check), so a plain `cargo test` never fails
//! here.

mod common;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use common::{port_ftp, require_docker};

use termihub_core::backends::ftp::{
    probe_remote_size, run_attempt, AttemptOutcome, Ftp, FtpDirection, StopReason,
};
use termihub_core::config::FtpConfig;
use termihub_core::connection::ConnectionType;

// ── Known seeded fixture facts (must match generate-test-data.sh) ────────────

/// `/pub/data/dataset-1m.bin` — 1 MiB, zero-filled.
const DATASET_1M: &str = "/pub/data/dataset-1m.bin";
const DATASET_1M_SIZE: u64 = 1_048_576;

/// `/pub/data/dataset-64k.bin` — 64 KiB, zero-filled.
const DATASET_64K: &str = "/pub/data/dataset-64k.bin";
const DATASET_64K_SIZE: u64 = 65_536;

/// `/pub/readme.txt` — fixed text content (61 bytes incl. trailing newline).
const README_PATH: &str = "/pub/readme.txt";
const README_BYTES: &[u8] = b"termiHub FTP test server. See pub/docs for more information.\n";

/// Number of entries at the top of `/pub` (2 files + 3 directories).
const PUB_TOP_COUNT: usize = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// `FtpConfig` for the `ftpuser` account (plain FTP, passive, binary).
fn ftpuser_config() -> FtpConfig {
    FtpConfig {
        host: "127.0.0.1".to_string(),
        port: port_ftp(),
        username: "ftpuser".to_string(),
        password: Some("ftppass".to_string()),
        ..Default::default()
    }
}

/// Settings JSON for the `ftpuser` account (for the browser session).
fn ftpuser_settings() -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port_ftp(),
        "tlsMode": "none",
        "username": "ftpuser",
        "password": "ftppass",
    })
}

/// A deterministic, non-trivial payload of `len` bytes (so a byte-exact
/// comparison is meaningful — unlike the zero-filled fixture binaries).
fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// A per-process remote path under `/uploads` so reruns never collide.
fn upload_path(tag: &str) -> String {
    format!("/uploads/th_xfer_{}_{tag}.bin", std::process::id())
}

/// Best-effort remote cleanup via a browser session.
async fn cleanup_remote(path: &str) {
    let mut ftp = Ftp::new();
    if ftp.connect(ftpuser_settings()).await.is_ok() {
        if let Some(browser) = ftp.file_browser() {
            let _ = browser.delete(path).await;
        }
        let _ = ftp.disconnect().await;
    }
}

/// A no-op progress callback.
fn no_progress(_transferred: u64) {}

/// A `should_stop` probe that never stops.
fn never_stop() -> Option<StopReason> {
    None
}

// ── FTP-XFER-01: byte-exact download (RETR) ──────────────────────────────────

#[tokio::test]
async fn ftp_transfer_01_download_byte_exact() {
    require_docker!(port_ftp());

    let cfg = ftpuser_config();
    let tmp = tempfile::tempdir().expect("tempdir");
    let local = tmp.path().join("dataset-1m.bin");
    let local_str = local.to_str().expect("utf8 path");

    let mut last_progress = 0u64;
    let outcome = run_attempt(
        &cfg,
        FtpDirection::Download,
        DATASET_1M,
        local_str,
        0,
        |t| last_progress = t,
        never_stop,
    )
    .await
    .expect("download attempt");

    assert_eq!(
        outcome,
        AttemptOutcome::Completed {
            transferred: DATASET_1M_SIZE
        },
        "download should complete with the full byte count"
    );
    assert_eq!(
        last_progress, DATASET_1M_SIZE,
        "progress must reach EOF byte count"
    );

    let bytes = tokio::fs::read(&local).await.expect("read downloaded file");
    assert_eq!(bytes.len() as u64, DATASET_1M_SIZE, "downloaded size");
    assert!(
        bytes.iter().all(|&b| b == 0),
        "dataset-1m.bin is zero-filled"
    );

    // A text file must round-trip byte-for-byte too.
    let readme = tmp.path().join("readme.txt");
    run_attempt(
        &cfg,
        FtpDirection::Download,
        README_PATH,
        readme.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    )
    .await
    .expect("download readme");
    let content = tokio::fs::read(&readme).await.expect("read readme");
    assert_eq!(content, README_BYTES, "readme.txt content byte-exact");
}

// ── FTP-XFER-02: byte-exact upload (STOR), verified by download round-trip ───

#[tokio::test]
async fn ftp_transfer_02_upload_byte_exact() {
    require_docker!(port_ftp());

    let cfg = ftpuser_config();
    let tmp = tempfile::tempdir().expect("tempdir");

    // Deterministic, non-trivial payload (~300 KiB spans multiple chunks).
    let data = payload(307_200);
    let src = tmp.path().join("upload_src.bin");
    tokio::fs::write(&src, &data).await.expect("write src");

    let remote = upload_path("simple");
    cleanup_remote(&remote).await;

    let outcome = run_attempt(
        &cfg,
        FtpDirection::Upload,
        &remote,
        src.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    )
    .await
    .expect("upload attempt");
    assert_eq!(
        outcome,
        AttemptOutcome::Completed {
            transferred: data.len() as u64
        },
        "upload should complete with the full byte count"
    );

    // Download it back and compare byte-for-byte.
    let verify = tmp.path().join("upload_verify.bin");
    run_attempt(
        &cfg,
        FtpDirection::Download,
        &remote,
        verify.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    )
    .await
    .expect("download-back attempt");
    let got = tokio::fs::read(&verify).await.expect("read verify");
    assert_eq!(got, data, "uploaded bytes round-trip exactly");

    cleanup_remote(&remote).await;
}

// ── FTP-XFER-03: REST-based download resume ──────────────────────────────────

#[tokio::test]
async fn ftp_transfer_03_download_rest_resume() {
    require_docker!(port_ftp());

    let cfg = ftpuser_config();
    let tmp = tempfile::tempdir().expect("tempdir");

    // Reference: a full, uninterrupted download of the same file.
    let full = tmp.path().join("full.bin");
    run_attempt(
        &cfg,
        FtpDirection::Download,
        DATASET_1M,
        full.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    )
    .await
    .expect("full download");
    let reference = tokio::fs::read(&full).await.expect("read reference");
    assert_eq!(reference.len() as u64, DATASET_1M_SIZE);

    // Interrupted download: stop after the first chunk lands.
    let partial = tmp.path().join("partial.bin");
    let partial_str = partial.to_str().expect("utf8 path");
    let seen = Arc::new(AtomicU64::new(0));
    let stop_after: u64 = 200_000;

    let outcome = {
        let progress_seen = seen.clone();
        let stop_seen = seen.clone();
        run_attempt(
            &cfg,
            FtpDirection::Download,
            DATASET_1M,
            partial_str,
            0,
            move |t| progress_seen.store(t, Ordering::SeqCst),
            move || {
                if stop_seen.load(Ordering::SeqCst) >= stop_after {
                    Some(StopReason::Pause)
                } else {
                    None
                }
            },
        )
        .await
        .expect("interrupted download")
    };

    let transferred = match outcome {
        AttemptOutcome::Stopped {
            transferred,
            reason,
        } => {
            assert_eq!(reason, StopReason::Pause, "stop reason is Pause");
            transferred
        }
        AttemptOutcome::Completed { .. } => panic!("expected a mid-flight stop, got Completed"),
    };
    assert!(
        transferred >= stop_after && transferred < DATASET_1M_SIZE,
        "partial offset {transferred} should be mid-flight (>= {stop_after}, < {DATASET_1M_SIZE})"
    );
    let partial_len = tokio::fs::metadata(&partial)
        .await
        .expect("stat partial")
        .len();
    assert_eq!(
        partial_len, transferred,
        "partial file on disk holds exactly the reported offset"
    );

    // Resume from the partial offset via REST; the result must be complete and
    // byte-identical to the full download.
    let outcome2 = run_attempt(
        &cfg,
        FtpDirection::Download,
        DATASET_1M,
        partial_str,
        transferred,
        no_progress,
        never_stop,
    )
    .await
    .expect("resumed download");
    assert_eq!(
        outcome2,
        AttemptOutcome::Completed {
            transferred: DATASET_1M_SIZE
        },
        "resume should complete to EOF"
    );

    let resumed = tokio::fs::read(&partial).await.expect("read resumed");
    assert_eq!(
        resumed, reference,
        "REST-resumed file is byte-identical to a full download"
    );
}

// ── FTP-XFER-04: REST-based upload resume ────────────────────────────────────

#[tokio::test]
async fn ftp_transfer_04_upload_rest_resume() {
    require_docker!(port_ftp());

    let cfg = ftpuser_config();
    let tmp = tempfile::tempdir().expect("tempdir");

    let data = payload(800_000);
    let src = tmp.path().join("resume_src.bin");
    tokio::fs::write(&src, &data).await.expect("write src");
    let src_str = src.to_str().expect("utf8 path");

    let remote = upload_path("resume");
    cleanup_remote(&remote).await;

    // Interrupted upload: stop after the first chunk is written.
    let seen = Arc::new(AtomicU64::new(0));
    let stop_after: u64 = 200_000;
    let outcome = {
        let progress_seen = seen.clone();
        let stop_seen = seen.clone();
        run_attempt(
            &cfg,
            FtpDirection::Upload,
            &remote,
            src_str,
            0,
            move |t| progress_seen.store(t, Ordering::SeqCst),
            move || {
                if stop_seen.load(Ordering::SeqCst) >= stop_after {
                    Some(StopReason::Pause)
                } else {
                    None
                }
            },
        )
        .await
        .expect("interrupted upload")
    };
    let transferred = match outcome {
        AttemptOutcome::Stopped {
            transferred,
            reason,
        } => {
            assert_eq!(reason, StopReason::Pause);
            transferred
        }
        AttemptOutcome::Completed { .. } => panic!("expected a mid-flight stop, got Completed"),
    };
    assert!(transferred >= stop_after, "upload stopped mid-flight");

    // The server retained the partial STOR; resume from its actual size (this is
    // what a real queue does — REST from the server-reported offset).
    let remote_size = probe_remote_size(&cfg, &remote)
        .await
        .expect("SIZE of partial upload");
    assert!(
        remote_size > 0 && remote_size <= transferred,
        "server retained a partial upload ({remote_size} bytes, <= reported {transferred})"
    );

    let outcome2 = run_attempt(
        &cfg,
        FtpDirection::Upload,
        &remote,
        src_str,
        remote_size,
        no_progress,
        never_stop,
    )
    .await
    .expect("resumed upload");
    assert_eq!(
        outcome2,
        AttemptOutcome::Completed {
            transferred: data.len() as u64
        },
        "resumed upload completes to the full size"
    );

    // Download the resumed remote file and confirm it matches the source.
    let verify = tmp.path().join("resume_verify.bin");
    run_attempt(
        &cfg,
        FtpDirection::Download,
        &remote,
        verify.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    )
    .await
    .expect("download resumed upload");
    let got = tokio::fs::read(&verify).await.expect("read verify");
    assert_eq!(
        got, data,
        "REST-resumed upload is byte-identical to the source"
    );

    cleanup_remote(&remote).await;
}

// ── FTP-XFER-05: concurrent transfers + live browsing ────────────────────────
//
// Two downloads and a directory listing run at once. Each `run_attempt` and the
// browser open their own control+data connection, so browsing stays responsive
// while transfers are in flight. If transfers shared one data connection this
// would deadlock or serialize; instead all three complete together.

#[tokio::test]
async fn ftp_transfer_05_concurrent_separate_connections() {
    require_docker!(port_ftp());

    let cfg = ftpuser_config();
    let tmp = tempfile::tempdir().expect("tempdir");
    let a = tmp.path().join("concurrent_1m.bin");
    let b = tmp.path().join("concurrent_64k.bin");

    let mut ftp = Ftp::new();
    ftp.connect(ftpuser_settings())
        .await
        .expect("browser connect");

    let dl_a = run_attempt(
        &cfg,
        FtpDirection::Download,
        DATASET_1M,
        a.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    );
    let dl_b = run_attempt(
        &cfg,
        FtpDirection::Download,
        DATASET_64K,
        b.to_str().expect("utf8 path"),
        0,
        no_progress,
        never_stop,
    );
    let browse = async {
        let browser = ftp.file_browser().expect("FTP exposes a browser");
        browser.list_dir("/pub").await
    };

    let (res_a, res_b, res_listing) = tokio::join!(dl_a, dl_b, browse);

    assert_eq!(
        res_a.expect("concurrent download A"),
        AttemptOutcome::Completed {
            transferred: DATASET_1M_SIZE
        },
    );
    assert_eq!(
        res_b.expect("concurrent download B"),
        AttemptOutcome::Completed {
            transferred: DATASET_64K_SIZE
        },
    );

    // Browsing stayed live and returned the seeded tree during the transfers.
    let listing = res_listing.expect("concurrent list_dir");
    assert_eq!(
        listing.len(),
        PUB_TOP_COUNT,
        "live listing sees the full /pub tree while transfers run"
    );

    // Both downloads are byte-exact.
    let bytes_a = tokio::fs::read(&a).await.expect("read A");
    assert_eq!(bytes_a.len() as u64, DATASET_1M_SIZE);
    assert!(bytes_a.iter().all(|&x| x == 0), "A zero-filled");
    let bytes_b = tokio::fs::read(&b).await.expect("read B");
    assert_eq!(bytes_b.len() as u64, DATASET_64K_SIZE);
    assert!(bytes_b.iter().all(|&x| x == 0), "B zero-filled");

    ftp.disconnect().await.expect("disconnect");
}
