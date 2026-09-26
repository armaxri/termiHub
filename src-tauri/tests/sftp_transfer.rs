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

#[macro_use]
mod common;

use common::*;

use std::time::{Duration, Instant};

use termihub_core::backends::ssh::SftpAdvancedOps;
use termihub_core::files::FileBrowser;
use termihub_lib::files::sftp::Writability;
use termihub_lib::files::transfer::sftp::{run_sftp_remote_copy, run_sftp_transfer, ResumeMode};
use termihub_lib::files::transfer::state::TransferStateTag;
use termihub_lib::files::transfer::{TransferDirection, TransferPhase, TransferRegistry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Cancel-mid-transfer: the partial local file is removed and the terminal
/// `cancelled` event fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_mid_transfer_cleans_up_partial_file() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;

    let dest = std::env::temp_dir().join(format!("termihub-cancel-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let transfer_id = "cancel-test".to_string();
    let handle = registry.enqueue(
        &transfer_id,
        "s",
        TransferDirection::Download,
        "100mb.bin",
        "/home/testuser/sftp-test/large-files/100mb.bin",
        100 * 1024 * 1024,
    );
    let sink = RecordingSink::default();

    // Cancel almost immediately so the copy stops after an early chunk boundary
    // with the destination only partially written.
    let cancel_reg = registry.clone();
    let cancel_id = transfer_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel_reg.cancel(&cancel_id);
    });

    run_sftp_transfer(
        session,
        TransferDirection::Download,
        "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
        dest_str.clone(),
        handle,
        registry.clone(),
        sink.as_sink(),
        ResumeMode::Resume,
        0,
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

/// The write-open probe classifies a user-owned file as writable and a
/// root-owned `/etc` file as read-only — the owner-mismatch case the cheap
/// permission hint cannot catch (issue #1324). Never modifies either file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn check_writable_distinguishes_owner_from_root_owned() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;

    // A file the connecting user owns: create it fresh under $HOME, probe it,
    // then clean up. The probe must never truncate it.
    let user_path = format!(
        "/home/testuser/termihub-writable-{}.txt",
        uuid::Uuid::new_v4()
    );
    let user_writable = {
        session
            .write_file(&user_path, b"probe-content")
            .await
            .expect("writing the user-owned probe file should succeed");
        let writability = session
            .check_writable(&user_path)
            .await
            .expect("probe on a user-owned file should not error");
        // Content must survive the probe unchanged (no truncate/write).
        let content = session
            .read_file(&user_path)
            .await
            .expect("reading the probe file back should succeed");
        let _ = session.delete(&user_path).await;
        (writability, String::from_utf8(content).expect("utf-8"))
    };
    assert_eq!(
        user_writable.0,
        Writability::Writable,
        "a file owned by the connecting user must probe as writable"
    );
    assert_eq!(
        user_writable.1, "probe-content",
        "the write-open probe must not modify the file's contents"
    );

    // A root-owned file the user cannot write (mode 644, owned by root).
    let root_writability = session
        .check_writable("/etc/hostname")
        .await
        .expect("probe on a root-owned file should not error");
    assert_eq!(
        root_writability,
        Writability::ReadOnly,
        "a root-owned /etc file must probe as read-only for a non-root user"
    );
}

/// Concurrent-transfer-while-browsing liveness: a `list_dir` on the browsing
/// session completes promptly while a large transfer runs on a dedicated
/// channel.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browsing_stays_live_during_transfer() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;

    let dest = std::env::temp_dir().join(format!("termihub-live-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "live-test",
        "s",
        TransferDirection::Download,
        "100mb.bin",
        "/home/testuser/sftp-test/large-files/100mb.bin",
        100 * 1024 * 1024,
    );
    let sink = RecordingSink::default();

    // Start the large transfer in the background; the executor copies on its
    // own dedicated channel, never the browsing session's.
    let transfer = tokio::spawn({
        let session = session.clone();
        async move {
            run_sftp_transfer(
                session,
                TransferDirection::Download,
                "/home/testuser/sftp-test/large-files/100mb.bin".to_string(),
                dest_str,
                handle,
                registry,
                sink.as_sink(),
                ResumeMode::Resume,
                0,
            )
            .await;
        }
    });

    // While it runs, a directory listing on the browsing session must complete
    // promptly (the copy does not hold the session mutex).
    let start = Instant::now();
    let entries = session
        .list_dir("/home/testuser/sftp-test/large-files")
        .await
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

// --- Resume primitives + rich-executor pause/resume (PROD-0012) ---

/// `open_read_at` returns exactly the tail of the file from `offset` onward, and
/// `remote_file_size` reports the true size — the read half of resume.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_read_at_returns_the_exact_tail() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let content = known_bytes(120_000);
    let remote = format!(
        "/home/testuser/termihub-prod0012-read-{}.bin",
        uuid::Uuid::new_v4()
    );

    let channel = open_dedicated(session.clone()).await;
    write_remote(&channel, &remote, &content).await;

    // Size probe used to byte-verify a resume offset.
    let size = channel.remote_file_size(&remote).await;
    assert_eq!(
        size,
        Some(content.len() as u64),
        "remote_file_size reports the true size"
    );

    // A tail read from a non-zero offset returns only the not-yet-fetched bytes.
    let offset = 50_000u64;
    let mut reader = channel
        .open_read_at(&remote, offset)
        .await
        .expect("open_read_at should open and seek");
    let mut tail = Vec::new();
    reader.read_to_end(&mut tail).await.expect("read the tail");
    assert_eq!(
        tail,
        &content[offset as usize..],
        "open_read_at must return exactly the bytes from the offset onward"
    );

    let cleanup = open_dedicated(session).await;
    let _ = cleanup.remove_file(&remote).await;
}

/// `open_write_at` appends at `offset` without truncating the existing partial,
/// so a create-then-append reconstructs the whole file byte-exact — the write
/// half of resume.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_write_at_appends_without_truncating() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let content = known_bytes(120_000);
    let split = 50_000usize;
    let remote = format!(
        "/home/testuser/termihub-prod0012-write-{}.bin",
        uuid::Uuid::new_v4()
    );

    // Write the first half via the truncating create_write.
    let channel = open_dedicated(session.clone()).await;
    write_remote(&channel, &remote, &content[..split]).await;

    // Append the tail via open_write_at at the split offset (no truncation).
    let channel2 = open_dedicated(session.clone()).await;
    let mut w = channel2
        .open_write_at(&remote, split as u64)
        .await
        .expect("open_write_at should open and seek");
    w.write_all(&content[split..])
        .await
        .expect("append the tail");
    w.flush().await.expect("flush");
    w.shutdown().await.expect("shutdown");

    // The reconstructed file must equal the full known content, byte-for-byte.
    let readback = session
        .read_file(&remote)
        .await
        .expect("read back the file");
    assert_eq!(
        readback, content,
        "create + append-at-offset must reconstruct the whole file byte-exact"
    );

    let _ = session.delete(&remote).await;
}

/// End-to-end rich-executor resume: upload a known file, then download it while
/// pausing and resuming mid-flight — the result is byte-exact. Proves
/// `transfer_pause`/`resume` now drive the SFTP path (PROD-0012).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_pause_resume_is_byte_exact() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    // ~16 MiB so the transfer spans many chunks and a pause lands mid-flight.
    let content = known_bytes(16 * 1024 * 1024);
    let remote = format!(
        "/home/testuser/termihub-prod0012-rt-{}.bin",
        uuid::Uuid::new_v4()
    );

    // Seed the remote file via a dedicated channel.
    let seed = open_dedicated(session.clone()).await;
    write_remote(&seed, &remote, &content).await;

    let dest = std::env::temp_dir().join(format!("termihub-prod0012-{}.bin", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();

    let registry = TransferRegistry::new();
    let transfer_id = "prod0012-resume".to_string();
    let handle = registry.enqueue(
        &transfer_id,
        "s",
        TransferDirection::Download,
        "rt.bin",
        &remote,
        0,
    );
    let sink = RecordingSink::default();

    // Pause shortly after start, then resume — driving the pause→release-slot
    // →resume-from-offset path.
    let pause_reg = registry.clone();
    let pause_id = transfer_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        pause_reg.pause(&pause_id);
        tokio::time::sleep(Duration::from_millis(200)).await;
        pause_reg.resume(&pause_id);
    });

    let run = tokio::spawn({
        let sink = sink.clone();
        let registry = registry.clone();
        let remote = remote.clone();
        async move {
            run_sftp_transfer(
                session,
                TransferDirection::Download,
                remote,
                dest_str,
                handle,
                registry,
                sink.as_sink(),
                ResumeMode::Resume,
                0,
            )
            .await;
        }
    });

    let _ = tokio::time::timeout(Duration::from_secs(120), run)
        .await
        .expect("transfer should finish within the timeout");

    assert_eq!(
        sink.terminal_phase(),
        Some(TransferPhase::Done),
        "a resumed transfer must complete on the `done` phase"
    );
    let got = std::fs::read(&dest).expect("the downloaded file should exist");
    assert_eq!(
        got.len(),
        content.len(),
        "the resumed download must be the full size"
    );
    assert!(
        got == content,
        "the resumed download must be byte-exact with the source"
    );
    // Best-effort: confirm the pause actually landed (non-fatal — a very fast
    // loopback could finish before the pause).
    if !sink.saw_state(TransferStateTag::Paused) {
        eprintln!("NOTE: pause did not land before completion; resume path not exercised this run");
    }

    let _ = std::fs::remove_file(&dest);
    let cleanup = open_dedicated(connect().await).await;
    let _ = cleanup.remove_file(&remote).await;
}

// --- Direct remote→remote copy (PROD-0013) ---

/// End-to-end remote→remote copy: seed a known file on the source session, copy
/// it directly to a destination path — streamed through the desktop with **no
/// local staging file** — and assert it lands byte-exact as ONE completed
/// transfer (PROD-0013).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_to_remote_copy_is_byte_exact() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    // Two independent browsers, as the command layer resolves (src + dst
    // sessions); both point at the loopback fixture but at distinct paths.
    let src_session = connect().await;
    let dst_session = connect().await;

    let content = known_bytes(4 * 1024 * 1024);
    let src = format!(
        "/home/testuser/termihub-prod0013-src-{}.bin",
        uuid::Uuid::new_v4()
    );
    let dst = format!(
        "/home/testuser/termihub-prod0013-dst-{}.bin",
        uuid::Uuid::new_v4()
    );

    // Seed the source file via a dedicated channel.
    let seed = open_dedicated(src_session.clone()).await;
    write_remote(&seed, &src, &content).await;

    let registry = TransferRegistry::new();
    let transfer_id = "prod0013-copy".to_string();
    let handle = registry.enqueue(
        &transfer_id,
        "s",
        TransferDirection::Upload,
        "dst.bin",
        &dst,
        0,
    );
    let sink = RecordingSink::default();

    run_sftp_remote_copy(
        src_session.clone(),
        dst_session.clone(),
        src.clone(),
        dst.clone(),
        handle,
        registry.clone(),
        sink.as_sink(),
        ResumeMode::Resume,
    )
    .await;

    assert_eq!(
        sink.terminal_phase(),
        Some(TransferPhase::Done),
        "a completed remote→remote copy must end on the `done` phase"
    );
    let got = dst_session
        .read_file(&dst)
        .await
        .expect("the destination file should exist");
    assert_eq!(
        got.len(),
        content.len(),
        "the copied file must be the full size"
    );
    assert!(
        got == content,
        "the copied file must be byte-exact with the source"
    );
    assert!(
        !registry_contains(&registry, &transfer_id),
        "the registry entry must be dropped after the copy settles"
    );

    // Clean up both remote paths (best-effort).
    let cleanup = open_dedicated(src_session).await;
    let _ = cleanup.remove_file(&src).await;
    let cleanup2 = open_dedicated(dst_session).await;
    let _ = cleanup2.remove_file(&dst).await;
}

/// Cancel-mid-copy: a large remote→remote copy is cancelled while in flight; the
/// partial destination file is removed and the terminal `cancelled` event fires
/// (PROD-0013).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_to_remote_cancel_removes_partial_destination() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let src_session = connect().await;
    let dst_session = connect().await;

    // A large pre-populated source so the copy spans many chunks and the cancel
    // lands mid-flight, leaving a partial destination to clean up.
    let src = "/home/testuser/sftp-test/large-files/100mb.bin".to_string();
    let dst = format!(
        "/home/testuser/termihub-prod0013-cancel-{}.bin",
        uuid::Uuid::new_v4()
    );

    let registry = TransferRegistry::new();
    let transfer_id = "prod0013-cancel".to_string();
    let handle = registry.enqueue(
        &transfer_id,
        "s",
        TransferDirection::Upload,
        "dst.bin",
        &dst,
        0,
    );
    let sink = RecordingSink::default();

    // Cancel shortly after start.
    let cancel_reg = registry.clone();
    let cancel_id = transfer_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(40)).await;
        cancel_reg.cancel(&cancel_id);
    });

    run_sftp_remote_copy(
        src_session,
        dst_session.clone(),
        src,
        dst.clone(),
        handle,
        registry,
        sink.as_sink(),
        ResumeMode::Resume,
    )
    .await;

    assert_eq!(
        sink.terminal_phase(),
        Some(TransferPhase::Cancelled),
        "a cancelled remote→remote copy must end on the `cancelled` phase"
    );
    // The partial destination must have been removed (best-effort cleanup), so a
    // size probe finds nothing.
    let probe = open_dedicated(dst_session).await;
    assert_eq!(
        probe.remote_file_size(&dst).await,
        None,
        "the partial destination must be removed on cancel"
    );
}

// --- require_sftp_stress! gate logic (TBE-006) ---
//
// These verify the skip-vs-hard-fail decision the macro switches on, without
// touching Docker or the network, so they always run in the ordinary test
// gate — the path that must never regress to a silent return-as-pass.

#[test]
fn parse_required_recognizes_truthy_values() {
    for v in ["1", "true", "TRUE", "yes", "on", " 1 "] {
        assert!(parse_required(Some(v)), "{v:?} should be truthy");
    }
}

#[test]
fn parse_required_treats_unset_and_falsey_as_not_required() {
    assert!(!parse_required(None), "unset should be falsey");
    for v in ["", "0", "false", "no", "off"] {
        assert!(!parse_required(Some(v)), "{v:?} should be falsey");
    }
}

#[test]
fn require_fixture_runs_when_reachable() {
    assert!(require_fixture(true, false, 2210));
    assert!(require_fixture(true, true, 2210));
}

#[test]
fn require_fixture_skips_when_absent_and_not_required() {
    assert!(!require_fixture(false, false, 2210));
}

#[test]
fn require_fixture_panics_when_absent_but_required() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(|| require_fixture(false, true, 2210));
    std::panic::set_hook(prev);
    assert!(
        outcome.is_err(),
        "require_fixture must panic when the fixture is absent but required"
    );
}
