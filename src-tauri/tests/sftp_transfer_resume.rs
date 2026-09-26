//! Live SFTP resume-correctness tests for the transfer queue (PARITY-004, #3567).
//!
//! Against the `sftp-stress` fixture (Docker Compose `stress` profile) these
//! prove the queue's SFTP executor recovers without corrupting the file:
//!
//! 1. **upload pause/resume** — a paused upload resumes from its offset and
//!    lands byte-exact.
//! 2. **download / upload channel drop** — the container's `sftp-server` serving
//!    the transfer is killed mid-flight; the executor auto-retries on a fresh
//!    channel and **resumes** from the verified offset (progress never falls
//!    back to zero) and the result is byte-exact — including the upload case,
//!    where pipelined writes lost in flight must not leave a hole.
//! 3. **source changed while paused** — the remote source is rewritten during a
//!    pause; the resume detects the changed fingerprint and restarts from zero,
//!    so the download equals the *new* file rather than a splice of both.
//!
//! Skips gracefully when the fixture is absent (hard-fails under
//! `TERMIHUB_REQUIRE_DOCKER=1`). The drop tests additionally need `docker exec`
//! into the fixture container (`$TERMIHUB_TEST_PROJECT-sftp-stress`); without it
//! they print `SKIPPED:` unless Docker is required.

#![cfg(unix)]

#[macro_use]
mod common;

use common::*;

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::files::FileBrowser;
use termihub_lib::files::transfer::registry::TransferHandle;
use termihub_lib::files::transfer::sftp::{run_sftp_transfer, ResumeMode};
use termihub_lib::files::transfer::state::TransferStateTag;
use termihub_lib::files::transfer::{TransferDirection, TransferPhase, TransferRegistry};

/// Size of the files the drop/pause tests move: large enough that a loopback
/// transfer is still in flight when the fault is injected.
const BIG: usize = 64 * 1024 * 1024;

/// Bytes that must have moved before a fault is injected, so the resume has a
/// real non-zero offset to continue from.
const FAULT_AFTER: u64 = 4 * 1024 * 1024;

/// A root shell kept open inside the fixture container, so a fault lands within
/// milliseconds of the trigger (a fresh `docker exec` takes ~100 ms, long enough
/// for a loopback transfer to finish first).
struct ContainerShell {
    child: Child,
}

impl ContainerShell {
    /// Open the shell, or `None` when Docker / the container is unavailable.
    fn open() -> Option<Self> {
        let project = std::env::var("TERMIHUB_TEST_PROJECT").unwrap_or_else(|_| "termihub".into());
        let container = format!("{project}-sftp-stress");
        let running = Command::new("docker")
            .args(["inspect", "-f", "{{.State.Running}}", &container])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
            .unwrap_or(false);
        if !running {
            return None;
        }
        let child = Command::new("docker")
            .args(["exec", "-i", "--privileged", &container, "sh"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        Some(Self { child })
    }

    /// Kill (SIGKILL) every `sftp-server` holding a file whose path contains
    /// `needle` — i.e. exactly the channel serving this test's transfer, never
    /// a concurrently running test's channel or the browsing channel. The shell
    /// is `--privileged` because OpenSSH marks `sftp-server` non-dumpable, so
    /// its `/proc/<pid>/fd` is unreadable without `CAP_SYS_PTRACE`.
    fn kill_sftp_server_holding(&mut self, needle: &str) {
        let script = format!(
            "for p in /proc/[0-9]*; do \
               if [ \"$(cat $p/comm 2>/dev/null)\" = sftp-server ] && \
                  ls -l $p/fd 2>/dev/null | grep -q '{needle}'; then kill -9 ${{p#/proc/}}; fi; \
             done\n"
        );
        let stdin = self.child.stdin.as_mut().expect("shell stdin");
        stdin
            .write_all(script.as_bytes())
            .expect("write kill script");
        stdin.flush().expect("flush kill script");
    }
}

impl Drop for ContainerShell {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

/// Open the fault-injection shell, or skip (hard-fail when Docker is required).
fn container_shell_or_skip() -> Option<ContainerShell> {
    let shell = ContainerShell::open();
    if shell.is_none() {
        assert!(
            !docker_required(),
            "REQUIRED: cannot `docker exec` into the sftp-stress fixture container"
        );
        eprintln!("SKIPPED: cannot `docker exec` into the sftp-stress fixture container");
    }
    shell
}

/// A unique remote path under the test user's home.
fn remote_path(tag: &str) -> String {
    format!(
        "/home/testuser/termihub-parity004-{tag}-{}.bin",
        uuid::Uuid::new_v4()
    )
}

/// A unique local temp path.
fn local_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "termihub-parity004-{tag}-{}.bin",
        uuid::Uuid::new_v4()
    ))
}

/// Seed `remote` with `content` over a dedicated channel.
async fn seed_remote(session: &Arc<SftpFileBrowser>, remote: &str, content: &[u8]) {
    let channel = open_dedicated(session.clone()).await;
    write_remote(&channel, remote, content).await;
}

/// Spawn the SFTP executor for `handle` and return its join handle.
fn spawn_transfer(
    session: Arc<SftpFileBrowser>,
    direction: TransferDirection,
    remote: &str,
    local: &std::path::Path,
    handle: Arc<TransferHandle>,
    registry: &TransferRegistry,
    sink: &RecordingSink,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run_sftp_transfer(
        session,
        direction,
        remote.to_string(),
        local.to_string_lossy().to_string(),
        handle,
        registry.clone(),
        sink.as_sink(),
        ResumeMode::Resume,
        0,
    ))
}

/// Wait until `handle` has moved at least `bytes`. Returns `false` when the
/// transfer finished first (the fault could not land mid-flight).
async fn wait_for_progress(
    handle: &TransferHandle,
    run: &tokio::task::JoinHandle<()>,
    bytes: u64,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        if handle.snapshot().transferred >= bytes {
            return true;
        }
        if run.is_finished() {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    false
}

/// Await the executor, bounded.
async fn finish(run: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(180), run)
        .await
        .expect("transfer should finish within the timeout")
        .expect("transfer task should not panic");
}

/// The recorded `transferred` values, in emission order.
fn transferred_series(sink: &RecordingSink) -> Vec<u64> {
    sink.events
        .lock()
        .expect("sink mutex")
        .iter()
        .map(|p| p.transferred)
        .collect()
}

/// Whether any recorded event carried a message containing `needle`.
fn saw_message(sink: &RecordingSink, needle: &str) -> bool {
    sink.events
        .lock()
        .expect("sink mutex")
        .iter()
        .any(|p| p.message.as_deref().is_some_and(|m| m.contains(needle)))
}

/// Assert the transfer resumed after its fault rather than restarting: after the
/// first `Failed` event, progress never drops back below `FAULT_AFTER / 2`.
fn assert_resumed_not_restarted(sink: &RecordingSink) {
    let events = sink.events.lock().expect("sink mutex").clone();
    let first_fail = events
        .iter()
        .position(|p| p.state == TransferStateTag::Failed)
        .expect("the dropped channel must surface a failed attempt before the retry");
    let min_after = events[first_fail..]
        .iter()
        .map(|p| p.transferred)
        .min()
        .unwrap_or(0);
    assert!(
        min_after >= FAULT_AFTER / 2,
        "after the drop the transfer must resume from its offset, not restart \
         (lowest progress after the failure: {min_after})"
    );
}

/// A paused upload resumes from its offset and lands byte-exact.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_pause_resume_is_byte_exact() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let content = known_bytes(BIG);
    let local = local_path("up-pause");
    std::fs::write(&local, &content).expect("seed local source");
    let remote = remote_path("up-pause");

    let registry = TransferRegistry::new();
    let id = "parity004-up-pause";
    let handle = registry.enqueue(id, "s", TransferDirection::Upload, "u.bin", &remote, 0);
    let sink = RecordingSink::default();
    let run = spawn_transfer(
        session.clone(),
        TransferDirection::Upload,
        &remote,
        &local,
        handle.clone(),
        &registry,
        &sink,
    );

    let landed = wait_for_progress(&handle, &run, FAULT_AFTER).await;
    if landed {
        registry.pause(id);
        tokio::time::sleep(Duration::from_millis(300)).await;
        registry.resume(id);
    }
    finish(run).await;

    assert_eq!(sink.terminal_phase(), Some(TransferPhase::Done));
    let readback = session.read_file(&remote).await.expect("read back upload");
    assert!(
        readback == content,
        "resumed upload must be byte-exact (got {} of {} bytes)",
        readback.len(),
        content.len()
    );
    if !(landed && sink.saw_state(TransferStateTag::Paused)) {
        eprintln!("NOTE: pause did not land before completion; resume path not exercised");
    }

    let _ = std::fs::remove_file(&local);
    let _ = session.delete(&remote).await;
}

/// Killing the `sftp-server` serving a download mid-flight → the executor
/// retries on a fresh channel and resumes from the verified local partial.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_resumes_after_channel_drop() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);
    let Some(mut shell) = container_shell_or_skip() else {
        return;
    };

    let session = connect().await;
    let content = known_bytes(BIG);
    let remote = remote_path("down-drop");
    seed_remote(&session, &remote, &content).await;
    let local = local_path("down-drop");
    let needle = remote.rsplit('/').next().expect("file name").to_string();

    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "parity004-down-drop",
        "s",
        TransferDirection::Download,
        "d.bin",
        &remote,
        0,
    );
    let sink = RecordingSink::default();
    let run = spawn_transfer(
        session.clone(),
        TransferDirection::Download,
        &remote,
        &local,
        handle.clone(),
        &registry,
        &sink,
    );

    let landed = wait_for_progress(&handle, &run, FAULT_AFTER).await;
    if landed {
        shell.kill_sftp_server_holding(&needle);
    }
    finish(run).await;

    assert_eq!(sink.terminal_phase(), Some(TransferPhase::Done));
    let got = std::fs::read(&local).expect("downloaded file exists");
    assert!(
        got == content,
        "download resumed after a drop must be byte-exact (got {} of {} bytes)",
        got.len(),
        content.len()
    );
    if landed && sink.saw_state(TransferStateTag::Failed) {
        assert_resumed_not_restarted(&sink);
    } else {
        eprintln!("NOTE: the drop did not land before completion; resume path not exercised");
    }

    let _ = std::fs::remove_file(&local);
    let _ = session.delete(&remote).await;
}

/// Killing the `sftp-server` serving an upload mid-flight → the executor
/// retries and resumes from the bytes that actually landed remotely (pipelined
/// writes lost in flight are re-sent, never skipped), byte-exact.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_resumes_after_channel_drop() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);
    let Some(mut shell) = container_shell_or_skip() else {
        return;
    };

    let session = connect().await;
    let content = known_bytes(BIG);
    let local = local_path("up-drop");
    std::fs::write(&local, &content).expect("seed local source");
    let remote = remote_path("up-drop");
    let needle = remote.rsplit('/').next().expect("file name").to_string();

    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "parity004-up-drop",
        "s",
        TransferDirection::Upload,
        "u.bin",
        &remote,
        0,
    );
    let sink = RecordingSink::default();
    let run = spawn_transfer(
        session.clone(),
        TransferDirection::Upload,
        &remote,
        &local,
        handle.clone(),
        &registry,
        &sink,
    );

    let landed = wait_for_progress(&handle, &run, FAULT_AFTER).await;
    if landed {
        shell.kill_sftp_server_holding(&needle);
    }
    finish(run).await;

    assert_eq!(sink.terminal_phase(), Some(TransferPhase::Done));
    let readback = session.read_file(&remote).await.expect("read back upload");
    assert!(
        readback == content,
        "upload resumed after a drop must be byte-exact (got {} of {} bytes)",
        readback.len(),
        content.len()
    );
    if landed && sink.saw_state(TransferStateTag::Failed) {
        assert_resumed_not_restarted(&sink);
    } else {
        eprintln!("NOTE: the drop did not land before completion; resume path not exercised");
    }

    let _ = std::fs::remove_file(&local);
    let _ = session.delete(&remote).await;
}

/// The remote source is rewritten while a download is paused → the resume
/// detects the changed fingerprint and restarts from zero, so the result is the
/// new file byte-exact (never a splice of the old head and the new tail).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_restarts_when_source_changes_while_paused() {
    let port = sftp_stress_port();
    require_sftp_stress!(port);

    let session = connect().await;
    let original = known_bytes(BIG);
    // Same size, different bytes: only the mtime + content differ, so this
    // exercises the fingerprint's mtime half, not just a size mismatch.
    let replacement: Vec<u8> = original.iter().map(|b| b.wrapping_add(7)).collect();
    let remote = remote_path("down-changed");
    seed_remote(&session, &remote, &original).await;
    let local = local_path("down-changed");

    let registry = TransferRegistry::new();
    let id = "parity004-down-changed";
    let handle = registry.enqueue(id, "s", TransferDirection::Download, "d.bin", &remote, 0);
    let sink = RecordingSink::default();
    let run = spawn_transfer(
        session.clone(),
        TransferDirection::Download,
        &remote,
        &local,
        handle.clone(),
        &registry,
        &sink,
    );

    let landed = wait_for_progress(&handle, &run, FAULT_AFTER).await;
    let mut paused = false;
    if landed {
        registry.pause(id);
        // Wait for the pause to settle before rewriting the source.
        for _ in 0..500 {
            if handle.snapshot().state == TransferStateTag::Paused {
                paused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        if paused {
            // SFTP mtimes have one-second resolution.
            tokio::time::sleep(Duration::from_millis(1100)).await;
            seed_remote(&session, &remote, &replacement).await;
        }
        registry.resume(id);
    }
    finish(run).await;

    assert_eq!(sink.terminal_phase(), Some(TransferPhase::Done));
    let got = std::fs::read(&local).expect("downloaded file exists");
    if paused {
        assert!(
            got == replacement,
            "a download whose source changed while paused must restart and equal \
             the new source byte-exact (got {} bytes)",
            got.len()
        );
        assert!(
            saw_message(&sink, "source file changed"),
            "the restart must be surfaced to the user"
        );
        let series = transferred_series(&sink);
        assert!(
            series.windows(2).any(|w| w[1] < w[0]),
            "progress must visibly restart after the source changed"
        );
    } else {
        assert!(got == original, "an uninterrupted download is byte-exact");
        eprintln!("NOTE: pause did not land before completion; source-change path not exercised");
    }

    let _ = std::fs::remove_file(&local);
    let _ = session.delete(&remote).await;
}
