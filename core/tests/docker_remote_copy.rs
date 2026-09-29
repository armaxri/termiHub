#![cfg(all(feature = "docker", feature = "ssh"))]
//! Live integration tests for streamed remote-to-remote copies with a Docker
//! end (#3586): Docker→Docker, SFTP→Docker and Docker→SFTP, each checked
//! byte-exact.
//!
//! The Docker ends are throwaway `alpine:3` containers (busybox userland)
//! started and force-removed per test, exactly like `docker_transfer.rs`; the
//! tests skip when no Linux-capable container daemon is reachable. The SFTP
//! end is the pre-populated `sftp-stress` fixture (Docker Compose `stress`
//! profile); those tests skip when it is not running, or fail when
//! `TERMIHUB_REQUIRE_DOCKER` is set.

#[macro_use]
mod common;

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bollard::container::{Config, CreateContainerOptions, RemoveContainerOptions};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use futures_util::StreamExt;
use termihub_core::backends::docker::DockerTransferTarget;
use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::files::transfer::remote_copy::{
    run_remote_copy, RemoteCopyEndpoint, ResumeMode,
};
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferHandle, TransferPhase, TransferProgress,
    TransferRegistry, TransferStateTag,
};
use termihub_core::files::FileBrowser;

const IMAGE: &str = "alpine:3";
const MIB: u64 = 1024 * 1024;
/// Generous: covers a retry backoff on a slow CI daemon.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

/// A running throwaway container.
struct Container {
    client: bollard::Docker,
    id: String,
}

impl Container {
    fn target(&self) -> DockerTransferTarget {
        DockerTransferTarget::new(self.client.clone(), self.id.clone())
    }

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

    /// `sha256sum` of a container file (hash only).
    async fn sha(&self, path: &str) -> String {
        let out = self.sh(&format!("sha256sum '{path}'")).await;
        out.split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    /// Size of a container file, or `None` when it does not exist.
    async fn size(&self, path: &str) -> Option<u64> {
        self.sh(&format!("[ -e '{path}' ] && wc -c < '{path}'"))
            .await
            .trim()
            .parse()
            .ok()
    }

    /// Create a random `mib`-MiB file in the container.
    async fn random_file(&self, path: &str, mib: u64) {
        self.sh(&format!("head -c {} /dev/urandom > '{path}'", mib * MIB))
            .await;
    }
}

/// Reach a daemon that can run Linux containers, or `Err(reason)` to skip.
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

async fn start_container(client: &bollard::Docker, name: &str) -> String {
    let created = client
        .create_container(
            Some(CreateContainerOptions {
                name,
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
    created.id
}

/// Start `count` containers, run `body`, then force-remove every container
/// whether or not `body` panicked.
async fn with_containers<F, Fut>(test: &str, count: usize, body: F)
where
    F: FnOnce(Vec<Arc<Container>>) -> Fut,
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
    let mut ids = Vec::new();
    for n in 0..count {
        let name = format!("termihub-r2r-{}-{test}-{n}", std::process::id());
        ids.push(start_container(&client, &name).await);
    }
    let containers = ids
        .iter()
        .map(|id| {
            Arc::new(Container {
                client: client.clone(),
                id: id.clone(),
            })
        })
        .collect();
    let result = tokio::spawn(body(containers)).await;
    for id in &ids {
        let _ = client
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await;
    }
    if let Err(e) = result {
        std::panic::resume_unwind(e.into_panic());
    }
}

/// A running copy and everything it emitted.
struct Run {
    registry: TransferRegistry,
    handle: Arc<TransferHandle>,
    events: Arc<Mutex<Vec<TransferProgress>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Run {
    /// Start a copy from `start_offset` (a relaunch passes its checkpoint and
    /// has already seeded the handle).
    fn start(
        src: RemoteCopyEndpoint,
        dst: RemoteCopyEndpoint,
        src_path: &str,
        dst_path: &str,
        seed: impl FnOnce(&TransferHandle) -> u64,
    ) -> Self {
        let registry = TransferRegistry::new();
        let handle = registry.enqueue("t", "s", TransferDirection::Upload, "f", dst_path, 0);
        let start_offset = seed(&handle);
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorder = events.clone();
        let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
            recorder.lock().expect("lock").push(p.clone());
        });
        let task = tokio::spawn(run_remote_copy(
            src,
            dst,
            src_path.to_string(),
            dst_path.to_string(),
            handle.clone(),
            registry.clone(),
            sink,
            ResumeMode::Resume,
            start_offset,
        ));
        Self {
            registry,
            handle,
            events,
            task,
        }
    }

    fn fresh(
        src: RemoteCopyEndpoint,
        dst: RemoteCopyEndpoint,
        src_path: &str,
        dst_path: &str,
    ) -> Self {
        Self::start(src, dst, src_path, dst_path, |_| 0)
    }

    /// Wait until at least `bytes` have moved, then pause and wait for Paused.
    async fn pause_after(&self, bytes: u64) {
        tokio::time::timeout(TRANSFER_TIMEOUT, async {
            while self.handle.snapshot().transferred < bytes {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            assert!(self.registry.pause("t"), "pause accepted");
            while self.handle.snapshot().state != TransferStateTag::Paused {
                assert_ne!(
                    self.handle.snapshot().state,
                    TransferStateTag::Completed,
                    "copy finished before it could be paused"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("pause in time");
    }

    /// Wait until at least `bytes` have moved, then cancel.
    async fn cancel_after(&self, bytes: u64) {
        tokio::time::timeout(TRANSFER_TIMEOUT, async {
            while self.handle.snapshot().transferred < bytes {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("progress in time");
        assert!(self.registry.cancel("t"), "cancel accepted");
    }

    async fn finish(self) -> Vec<TransferProgress> {
        tokio::time::timeout(TRANSFER_TIMEOUT, self.task)
            .await
            .expect("copy finished in time")
            .expect("copy task");
        let events = self.events.lock().expect("lock").clone();
        events
    }
}

fn last_phase(events: &[TransferProgress]) -> TransferPhase {
    events.last().expect("some events").phase
}

fn messages(events: &[TransferProgress]) -> Vec<String> {
    events.iter().filter_map(|e| e.message.clone()).collect()
}

fn docker(c: &Container) -> RemoteCopyEndpoint {
    RemoteCopyEndpoint::Docker(c.target())
}

#[tokio::test]
async fn docker_to_docker_copy_is_byte_exact() {
    with_containers("d2d-exact", 2, |c| async move {
        c[0].random_file("/tmp/src.bin", 24).await;
        let run = Run::fresh(docker(&c[0]), docker(&c[1]), "/tmp/src.bin", "/tmp/dst.bin");
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(
            c[1].sha("/tmp/dst.bin").await,
            c[0].sha("/tmp/src.bin").await
        );
        assert_eq!(c[1].size("/tmp/dst.bin").await, Some(24 * MIB));
        let done = events.last().expect("done");
        assert_eq!((done.transferred, done.total), (24 * MIB, 24 * MIB));
    })
    .await;
}

#[tokio::test]
async fn docker_to_docker_pause_resume_continues_byte_exact() {
    with_containers("d2d-pause", 2, |c| async move {
        c[0].random_file("/tmp/src.bin", 64).await;
        let run = Run::fresh(docker(&c[0]), docker(&c[1]), "/tmp/src.bin", "/tmp/dst.bin");
        run.pause_after(MIB).await;
        let paused_at = run.handle.snapshot().transferred;
        let partial = c[1].size("/tmp/dst.bin").await.expect("partial kept");
        assert!(
            partial > 0 && partial <= paused_at,
            "{partial} vs {paused_at}"
        );

        assert!(run.registry.resume("t"));
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(
            c[1].sha("/tmp/dst.bin").await,
            c[0].sha("/tmp/src.bin").await
        );
        // Resumed from the bytes at the destination, not restarted.
        assert!(
            !messages(&events).iter().any(|m| m.contains("restarting")),
            "{:?}",
            messages(&events)
        );
    })
    .await;
}

#[tokio::test]
async fn docker_to_docker_cancel_removes_the_partial() {
    with_containers("d2d-cancel", 2, |c| async move {
        c[0].random_file("/tmp/src.bin", 64).await;
        let run = Run::fresh(docker(&c[0]), docker(&c[1]), "/tmp/src.bin", "/tmp/dst.bin");
        run.cancel_after(MIB).await;
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Cancelled, "{events:?}");
        assert_eq!(c[1].size("/tmp/dst.bin").await, None, "partial removed");
    })
    .await;
}

/// A copy relaunched after a restart (#3206, #3847) resumes from its
/// checkpoint while the source keeps the persisted size and mtime.
#[tokio::test]
async fn docker_to_docker_relaunch_resumes_from_the_checkpoint() {
    with_containers("d2d-relaunch", 2, |c| async move {
        // The same deterministic bytes in both containers: the whole file as
        // the source, its first 3 MiB as the checkpointed destination prefix.
        let bytes = "seq 1 2000000";
        c[0].sh(&format!("{bytes} | head -c {} > /tmp/src.bin", 8 * MIB))
            .await;
        c[1].sh(&format!("{bytes} | head -c {} > /tmp/dst.bin", 3 * MIB))
            .await;
        assert_eq!(c[1].size("/tmp/dst.bin").await, Some(3 * MIB));
        let fingerprint = c[0]
            .target()
            .fingerprint("/tmp/src.bin")
            .await
            .expect("source stat");

        let run = Run::start(
            docker(&c[0]),
            docker(&c[1]),
            "/tmp/src.bin",
            "/tmp/dst.bin",
            |handle| {
                handle.set_metrics(0, 8 * MIB, 0);
                handle.set_source_mtime(fingerprint.mtime);
                3 * MIB
            },
        );
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(events.first().map(|p| p.transferred), Some(3 * MIB));
        assert_eq!(
            c[1].sha("/tmp/dst.bin").await,
            c[0].sha("/tmp/src.bin").await
        );
    })
    .await;
}

/// Connect a browser to the `sftp-stress` fixture.
async fn sftp() -> Arc<SftpFileBrowser> {
    let browser = SftpFileBrowser::new(common::ssh_password_config(common::port_sftp_stress()));
    browser.connect().await.expect("SFTP fixture connects");
    Arc::new(browser)
}

fn sha_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}

#[tokio::test]
async fn sftp_to_docker_copy_is_byte_exact() {
    require_docker!(common::port_sftp_stress());
    let browser = sftp().await;
    with_containers("s2d-exact", 1, move |c| async move {
        // A pre-populated 10 MiB file on the SFTP fixture.
        let src = "/home/testuser/sftp-test/large-files/10mb.bin";
        let expected = browser.read_file(src).await.expect("read SFTP source");
        let run = Run::fresh(
            RemoteCopyEndpoint::Sftp(browser.clone()),
            docker(&c[0]),
            src,
            "/tmp/dst.bin",
        );
        let events = run.finish().await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(c[0].sha("/tmp/dst.bin").await, sha_hex(&expected));
        assert_eq!(c[0].size("/tmp/dst.bin").await, Some(expected.len() as u64));
    })
    .await;
}

#[tokio::test]
async fn docker_to_sftp_copy_is_byte_exact() {
    require_docker!(common::port_sftp_stress());
    let browser = sftp().await;
    with_containers("d2s-exact", 1, move |c| async move {
        c[0].random_file("/tmp/src.bin", 12).await;
        let dst = format!("/home/testuser/termihub-3586-{}.bin", std::process::id());
        let run = Run::fresh(
            docker(&c[0]),
            RemoteCopyEndpoint::Sftp(browser.clone()),
            "/tmp/src.bin",
            &dst,
        );
        let events = run.finish().await;
        let got = browser
            .read_file(&dst)
            .await
            .expect("read SFTP destination");
        let _ = browser.delete(&dst).await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(got.len() as u64, 12 * MIB);
        assert_eq!(sha_hex(&got), c[0].sha("/tmp/src.bin").await);
    })
    .await;
}

#[tokio::test]
async fn docker_to_sftp_pause_resume_continues_byte_exact() {
    require_docker!(common::port_sftp_stress());
    let browser = sftp().await;
    with_containers("d2s-pause", 1, move |c| async move {
        c[0].random_file("/tmp/src.bin", 48).await;
        let dst = format!(
            "/home/testuser/termihub-3586-pause-{}.bin",
            std::process::id()
        );
        let run = Run::fresh(
            docker(&c[0]),
            RemoteCopyEndpoint::Sftp(browser.clone()),
            "/tmp/src.bin",
            &dst,
        );
        run.pause_after(MIB).await;
        assert!(run.registry.resume("t"));
        let events = run.finish().await;
        let got = browser
            .read_file(&dst)
            .await
            .expect("read SFTP destination");
        let _ = browser.delete(&dst).await;
        assert_eq!(last_phase(&events), TransferPhase::Done, "{events:?}");
        assert_eq!(sha_hex(&got), c[0].sha("/tmp/src.bin").await);
        assert!(
            !messages(&events).iter().any(|m| m.contains("restarting")),
            "{:?}",
            messages(&events)
        );
    })
    .await;
}
