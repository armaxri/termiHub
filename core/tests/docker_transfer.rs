#![cfg(feature = "docker")]
//! Live integration tests for the streaming Docker transfer executor
//! (PARITY-004, #3567).
//!
//! Each test starts its own throwaway `alpine:3` container (busybox userland —
//! the minimal-tools case), streams a multi-MiB file through
//! `run_docker_transfer`, and byte-verifies the result against `sha256sum`
//! inside the container. The container is force-removed afterwards even when
//! the test body panics. Skips when no Linux-capable container daemon is
//! reachable — including a Windows-container-mode daemon (see `client()`; see
//! `docker_spawn.rs` for why it observes through bollard, not the CLI).
//!
//! Killing the streaming process is made deterministic by arming an in-
//! container killer loop *before* resuming: it SIGKILLs the first `tail` /
//! `cat` that appears — which can only be the resumed attempt's exec.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bollard::container::{Config, CreateContainerOptions, RemoveContainerOptions};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use futures_util::StreamExt;
use termihub_core::backends::docker::DockerTransferTarget;
use termihub_core::files::transfer::docker::run_docker_transfer;
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferPhase, TransferProgress, TransferRegistry,
    TransferStateTag,
};

const IMAGE: &str = "alpine:3";
const MIB: u64 = 1024 * 1024;
/// Generous: covers a 1 s + 2 s retry backoff on a slow CI daemon.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

/// A running throwaway container plus a local scratch directory.
struct Fixture {
    client: bollard::Docker,
    id: String,
    target: DockerTransferTarget,
    dir: tempfile::TempDir,
}

impl Fixture {
    /// Run `cmd` via `sh -c` in the container and return its stdout.
    async fn sh(&self, cmd: &str) -> String {
        let exec = self
            .client
            .create_exec(
                &self.id,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    cmd: Some(vec!["sh", "-c", cmd]),
                    ..Default::default()
                },
            )
            .await
            .expect("create exec");
        let mut out = String::new();
        if let StartExecResults::Attached { mut output, .. } = self
            .client
            .start_exec(&exec.id, None::<StartExecOptions>)
            .await
            .expect("start exec")
        {
            while let Some(Ok(frame)) = output.next().await {
                out.push_str(&frame.to_string());
            }
        }
        out
    }

    /// Start `cmd` detached (fire-and-forget) in the container.
    async fn sh_detached(&self, cmd: &str) {
        let exec = self
            .client
            .create_exec(
                &self.id,
                CreateExecOptions {
                    cmd: Some(vec!["sh", "-c", cmd]),
                    ..Default::default()
                },
            )
            .await
            .expect("create exec");
        self.client
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: true,
                    ..Default::default()
                }),
            )
            .await
            .expect("start detached exec");
    }

    /// `sha256sum` of a container file (hash only).
    async fn remote_sha(&self, path: &str) -> String {
        let out = self.sh(&format!("sha256sum '{path}'")).await;
        out.split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    fn local(&self, name: &str) -> String {
        self.dir
            .path()
            .join(name)
            .to_str()
            .expect("utf8 temp path")
            .to_string()
    }

    /// Arm a loop that SIGKILLs the first process named `name` to appear.
    async fn arm_killer(&self, name: &str) {
        self.sh_detached(&format!(
            "timeout 60 sh -c 'until pkill -9 -x {name}; do sleep 0.01; done'"
        ))
        .await;
    }
}

/// Reach a daemon that can run Linux containers, or `Err(reason)` to skip.
///
/// Two legitimate skip cases, both environments where `alpine:3` cannot run:
/// no reachable daemon at all, and a daemon in *Windows-container* mode
/// (the GitHub `windows-latest` runner — its Docker reports `OSType:
/// windows` and refuses to pull any Linux image with "no matching
/// manifest"). A Linux-capable daemon (Linux, Docker Desktop / Podman on
/// macOS) always runs the tests, so a real failure there stays a failure.
async fn client() -> Result<bollard::Docker, String> {
    let client = bollard::Docker::connect_with_local_defaults()
        .map_err(|e| format!("no container daemon configured ({e})"))?;
    client
        .ping()
        .await
        .map_err(|e| format!("container daemon unreachable ({e})"))?;
    let info = client
        .info()
        .await
        .map_err(|e| format!("container daemon info failed ({e})"))?;
    match info.os_type.as_deref() {
        Some("linux") => Ok(client),
        other => Err(format!(
            "container daemon cannot run Linux containers (OSType: {})",
            other.unwrap_or("unknown")
        )),
    }
}

async fn ensure_image(client: &bollard::Docker) {
    if client.inspect_image(IMAGE).await.is_ok() {
        return;
    }
    let mut pull = client.create_image(
        Some(CreateImageOptions {
            from_image: IMAGE,
            ..Default::default()
        }),
        None,
        None,
    );
    while let Some(step) = pull.next().await {
        step.expect("pull alpine:3");
    }
}

/// Start a container, run `body`, then force-remove the container whether
/// or not `body` panicked.
async fn with_container<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Arc<Fixture>) -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    let client = match client().await {
        Ok(client) => client,
        Err(reason) => {
            eprintln!("SKIPPED: {reason} ({test})");
            return;
        }
    };
    ensure_image(&client).await;
    let name = format!("termihub-xfer-{}-{test}", std::process::id());
    let created = client
        .create_container(
            Some(CreateContainerOptions {
                name: name.as_str(),
                platform: None,
            }),
            Config {
                image: Some(IMAGE),
                cmd: Some(vec!["sleep", "600"]),
                ..Default::default()
            },
        )
        .await
        .expect("create container");
    client
        .start_container::<String>(&created.id, None)
        .await
        .expect("start container");
    let fixture = Arc::new(Fixture {
        client: client.clone(),
        id: created.id.clone(),
        target: DockerTransferTarget::new(client.clone(), created.id.clone()),
        dir: tempfile::tempdir().expect("tempdir"),
    });
    let result = tokio::spawn(body(fixture)).await;
    let _ = client
        .remove_container(
            &created.id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
    if let Err(e) = result {
        std::panic::resume_unwind(e.into_panic());
    }
}

/// One progress event, reduced to what the assertions need.
#[derive(Debug, Clone)]
struct Event {
    transferred: u64,
    phase: TransferPhase,
    message: Option<String>,
}

/// A running transfer and everything it emitted.
struct Run {
    registry: TransferRegistry,
    handle: Arc<termihub_core::files::transfer::TransferHandle>,
    events: Arc<Mutex<Vec<Event>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Run {
    fn start(fx: &Fixture, direction: TransferDirection, remote: &str, local: &str) -> Self {
        let registry = TransferRegistry::new();
        let handle = registry.enqueue("t", "s", direction, "f", remote, 0);
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorder = events.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            recorder.lock().expect("lock").push(Event {
                transferred: p.transferred,
                phase: p.phase,
                message: p.message.clone(),
            });
        });
        let task = tokio::spawn(run_docker_transfer(
            fx.target.clone(),
            direction,
            remote.to_string(),
            local.to_string(),
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

    /// Wait until the transfer has moved at least one byte, then pause it and
    /// wait for the Paused state. Returns the event index at the pause.
    async fn pause_mid_flight(&self) -> usize {
        tokio::time::timeout(TRANSFER_TIMEOUT, async {
            while self.handle.snapshot().transferred == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            assert!(self.registry.pause("t"), "pause accepted");
            while self.handle.snapshot().state != TransferStateTag::Paused {
                assert_ne!(
                    self.handle.snapshot().state,
                    TransferStateTag::Completed,
                    "transfer finished before it could be paused"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("pause in time");
        self.events.lock().expect("lock").len()
    }

    /// Wait for the executor to reach a terminal state.
    async fn finish(self) -> Vec<Event> {
        tokio::time::timeout(TRANSFER_TIMEOUT, self.task)
            .await
            .expect("transfer finished in time")
            .expect("executor task");
        let events = self.events.lock().expect("lock").clone();
        events
    }
}

fn last_phase(events: &[Event]) -> TransferPhase {
    events.last().expect("some events").phase
}

fn messages(events: &[Event]) -> Vec<String> {
    events.iter().filter_map(|e| e.message.clone()).collect()
}

fn local_sha(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let data = std::fs::read(path).expect("read local file");
    hex::encode(Sha256::digest(&data))
}

/// Create a random `mib`-MiB file in the container.
async fn make_remote(fx: &Fixture, path: &str, mib: u64) {
    fx.sh(&format!("head -c {} /dev/urandom > '{path}'", mib * MIB))
        .await;
}

/// Create a random `mib`-MiB local file.
fn make_local(path: &str, mib: u64) {
    let mut data = vec![0u8; (mib * MIB) as usize];
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    for chunk in data.chunks_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        chunk.copy_from_slice(&x.to_le_bytes()[..chunk.len()]);
    }
    std::fs::write(path, data).expect("write local source");
}

#[tokio::test]
async fn large_download_is_byte_exact() {
    with_container("dl-exact", |fx| async move {
        make_remote(&fx, "/tmp/src.bin", 32).await;
        let local = fx.local("dl.bin");
        let run = Run::start(&fx, TransferDirection::Download, "/tmp/src.bin", &local);
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(local_sha(&local), fx.remote_sha("/tmp/src.bin").await);
        assert_eq!(std::fs::metadata(&local).expect("meta").len(), 32 * MIB);
    })
    .await;
}

#[tokio::test]
async fn large_upload_to_a_hostile_path_is_byte_exact() {
    with_container("ul-exact", |fx| async move {
        // Spaces, quotes, `$(...)`, backticks and `;` must all reach `cat`
        // verbatim (as one argument), never be evaluated by a shell.
        let remote = "/tmp/up load $(touch pwned) `touch pwned2`; 'q' \"x\".bin";
        let local = fx.local("src.bin");
        make_local(&local, 32);
        let run = Run::start(&fx, TransferDirection::Upload, remote, &local);
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        let evaluated = fx
            .sh("for f in /pwned /pwned2 /tmp/pwned /tmp/pwned2; do [ -e $f ] && echo $f; done")
            .await;
        assert!(
            evaluated.trim().is_empty(),
            "path was shell-evaluated: {evaluated}"
        );
        // Find the file by listing rather than re-quoting the hostile name.
        let hash = fx.sh("sha256sum /tmp/up\\ load*").await;
        assert_eq!(
            hash.split_whitespace().next().unwrap_or_default(),
            local_sha(&local)
        );
        assert!(hash.contains(remote), "exact name preserved: {hash}");
    })
    .await;
}

#[tokio::test]
async fn upload_to_a_missing_directory_fails_fast_with_the_reason() {
    with_container("ul-missing", |fx| async move {
        let local = fx.local("src.bin");
        make_local(&local, 8);
        let started = std::time::Instant::now();
        let run = Run::start(&fx, TransferDirection::Upload, "/nope/dst.bin", &local);
        // Fails permanently after the retry budget; wait for that, not the task
        // (which then idles awaiting a manual retry).
        tokio::time::timeout(TRANSFER_TIMEOUT, async {
            while run.handle.snapshot().state != TransferStateTag::Failed
                || run.handle.snapshot().attempt < 3
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fails in time");
        // Three attempts with 1 s + 2 s backoff — nowhere near the 60 s stall.
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "{:?}",
            started.elapsed()
        );
        let events = run.events.lock().expect("lock").clone();
        assert!(
            messages(&events)
                .iter()
                .any(|m| m.contains("nonexistent directory")),
            "{:?}",
            messages(&events)
        );
        assert!(run.registry.cancel("t"));
        run.finish().await;
    })
    .await;
}

#[tokio::test]
async fn download_killed_after_resume_retries_and_resumes_byte_exact() {
    with_container("dl-kill", |fx| async move {
        make_remote(&fx, "/tmp/src.bin", 96).await;
        let local = fx.local("dl.bin");
        let run = Run::start(&fx, TransferDirection::Download, "/tmp/src.bin", &local);
        let paused_at = run.pause_mid_flight().await;
        // The resumed attempt reads from the offset with `tail`; kill it.
        fx.arm_killer("tail").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(run.registry.resume("t"));
        let events = run.finish().await;

        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(local_sha(&local), fx.remote_sha("/tmp/src.bin").await);
        let after = &events[paused_at..];
        assert!(
            messages(after)
                .iter()
                .any(|m| m.contains("container read failed")),
            "the killed exec must surface as a retried failure: {:?}",
            messages(after)
        );
        assert!(
            after.iter().all(|e| e.transferred > 0),
            "a verified resume never restarts from zero"
        );
    })
    .await;
}

#[tokio::test]
async fn upload_killed_after_resume_retries_and_resumes_byte_exact() {
    with_container("ul-kill", |fx| async move {
        let local = fx.local("src.bin");
        make_local(&local, 96);
        let run = Run::start(&fx, TransferDirection::Upload, "/tmp/dst.bin", &local);
        let paused_at = run.pause_mid_flight().await;
        // The resumed attempt appends with `cat >>`; kill it.
        fx.arm_killer("cat").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(run.registry.resume("t"));
        let events = run.finish().await;

        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(fx.remote_sha("/tmp/dst.bin").await, local_sha(&local));
        let after = &events[paused_at..];
        assert!(
            !messages(after).is_empty(),
            "the killed exec must surface as a retried failure"
        );
        assert!(
            after.iter().all(|e| e.transferred > 0),
            "a verified resume never restarts from zero"
        );
    })
    .await;
}

#[tokio::test]
async fn cancelled_download_removes_the_local_partial() {
    with_container("dl-cancel", |fx| async move {
        make_remote(&fx, "/tmp/src.bin", 96).await;
        let local = fx.local("dl.bin");
        let run = Run::start(&fx, TransferDirection::Download, "/tmp/src.bin", &local);
        run.pause_mid_flight().await;
        assert!(run.registry.cancel("t"));
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Cancelled);
        assert!(!std::path::Path::new(&local).exists(), "partial removed");
    })
    .await;
}

#[tokio::test]
async fn cancelled_upload_removes_the_container_partial() {
    with_container("ul-cancel", |fx| async move {
        let local = fx.local("src.bin");
        make_local(&local, 96);
        let run = Run::start(&fx, TransferDirection::Upload, "/tmp/dst.bin", &local);
        run.pause_mid_flight().await;
        assert!(run.registry.cancel("t"));
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Cancelled);
        assert_eq!(
            fx.sh("[ -e /tmp/dst.bin ] || echo gone").await.trim(),
            "gone"
        );
    })
    .await;
}

#[tokio::test]
async fn container_without_tail_refuses_resume_and_restarts_byte_exact() {
    with_container("no-tail", |fx| async move {
        make_remote(&fx, "/tmp/src.bin", 64).await;
        // Busybox applets are symlinks; removing it leaves no offset reader.
        fx.sh("rm -f /usr/bin/tail /bin/tail").await;
        let local = fx.local("dl.bin");
        let run = Run::start(&fx, TransferDirection::Download, "/tmp/src.bin", &local);
        run.pause_mid_flight().await;
        assert!(run.registry.resume("t"));
        let events = run.finish().await;

        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert!(
            messages(&events)
                .iter()
                .any(|m| m == "resume not supported by container; restarting from start"),
            "{:?}",
            messages(&events)
        );
        assert_eq!(local_sha(&local), fx.remote_sha("/tmp/src.bin").await);
    })
    .await;
}
