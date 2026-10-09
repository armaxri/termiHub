//! Integration tests for Docker container sessions.
//!
//! These tests require Docker to be installed and running. They are
//! automatically skipped on systems without Docker.
//!
//! Each test creates a real Docker container, spawns a daemon process
//! with `TERMIHUB_COMMAND=docker`, and exercises the full frame protocol.
//!
//! Because the daemon requires a real PTY (fork + openpty), these tests
//! are Unix-only.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use termihub_core::test_fixtures;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

mod common;

use common::parent_death::GuardedSpawn;

// ── Inlined frame protocol ─────────────────────────────────────────
//
// Same subset as shell_integration.rs — the agent is a binary crate
// so we inline the protocol constants.

const MSG_INPUT: u8 = 0x01;
const MSG_RESIZE: u8 = 0x02;
#[expect(dead_code, reason = "kept so the frame-type table is complete")]
const MSG_DETACH: u8 = 0x03;
const MSG_KILL: u8 = 0x04;

const MSG_OUTPUT: u8 = 0x81;
const MSG_BUFFER_REPLAY: u8 = 0x82;
const MSG_EXITED: u8 = 0x83;
#[expect(dead_code, reason = "kept so the frame-type table is complete")]
const MSG_ERROR: u8 = 0x84;
const MSG_READY: u8 = 0x85;
/// Optional-feature flags a daemon sends before Ready (#3210).
const MSG_CAPABILITIES: u8 = 0x88;
/// Agent → daemon monitoring request, and its replies / samples (#3871).
const MSG_MONITORING_REQUEST: u8 = 0x08;
const MSG_MONITORING_EVENT: u8 = 0x89;
/// [`MSG_CAPABILITIES`] flag: the daemon serves monitoring (#3871).
const CAP_MONITORING: u8 = 0x02;

const HEADER_SIZE: usize = 5;

#[derive(Debug, Clone)]
struct Frame {
    msg_type: u8,
    payload: Vec<u8>,
}

/// Cancellation-safe frame reader (same as shell_integration.rs).
struct FrameReader {
    reader: tokio::net::unix::OwnedReadHalf,
    buf: Vec<u8>,
}

impl FrameReader {
    fn new(reader: tokio::net::unix::OwnedReadHalf) -> Self {
        Self {
            reader,
            buf: Vec::with_capacity(4096),
        }
    }

    fn try_parse_frame(&mut self) -> Option<Frame> {
        if self.buf.len() < HEADER_SIZE {
            return None;
        }

        let msg_type = self.buf[0];
        let length =
            u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        let total = HEADER_SIZE + length;

        if self.buf.len() < total {
            return None;
        }

        let payload = self.buf[HEADER_SIZE..total].to_vec();
        self.buf.drain(..total);

        Some(Frame { msg_type, payload })
    }

    async fn next_frame(&mut self, timeout: Duration) -> Result<Option<Frame>, String> {
        let deadline = tokio::time::Instant::now() + timeout;

        loop {
            if let Some(frame) = self.try_parse_frame() {
                return Ok(Some(frame));
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err("timeout".to_string());
            }

            let mut tmp = [0u8; 4096];
            match tokio::time::timeout(remaining, self.reader.read(&mut tmp)).await {
                Ok(Ok(0)) => return Ok(None),
                Ok(Ok(n)) => {
                    self.buf.extend_from_slice(&tmp[..n]);
                }
                Ok(Err(e)) => return Err(format!("IO error: {e}")),
                Err(_) => return Err("timeout".to_string()),
            }
        }
    }
}

async fn write_frame(
    stream: &mut tokio::net::unix::OwnedWriteHalf,
    msg_type: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let length = payload.len() as u32;
    let mut header = [0u8; HEADER_SIZE];
    header[0] = msg_type;
    header[1..5].copy_from_slice(&length.to_be_bytes());

    stream.write_all(&header).await?;
    if !payload.is_empty() {
        stream.write_all(payload).await?;
    }
    stream.flush().await?;
    Ok(())
}

fn encode_resize(cols: u16, rows: u16) -> [u8; 4] {
    let mut buf = [0u8; 4];
    buf[0..2].copy_from_slice(&cols.to_be_bytes());
    buf[2..4].copy_from_slice(&rows.to_be_bytes());
    buf
}

// ── Docker helpers ──────────────────────────────────────────────────

/// Check if Docker is available by running `docker info`.
fn docker_available() -> bool {
    Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether the Docker tests should run: `true` with a reachable daemon; with
/// none, skip — or panic under `TERMIHUB_REQUIRE_DOCKER`, which the nightly
/// agent-Docker lane sets so the suite cannot go green by skipping (#4338).
fn docker_ready() -> bool {
    test_fixtures::require(
        docker_available(),
        test_fixtures::REQUIRE_DOCKER_ENV,
        "Docker not available (`docker info` failed)",
        DOCKER_HINT,
    )
}

/// How to provide what the Docker tests need.
const DOCKER_HINT: &str = "needs a running Docker daemon that can pull and run Linux images";

// ── Test helpers ────────────────────────────────────────────────────

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

struct DaemonHandle {
    child: Child,
    socket_path: PathBuf,
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Spawn a daemon process configured as a Docker session.
///
/// Uses the Docker `ConnectionType` backend which creates and manages
/// its own container from the given image.
fn spawn_docker_daemon(session_id: &str, socket_path: &Path, image: &str) -> DaemonHandle {
    let settings = serde_json::json!({
        "image": image,
    });

    let mut child = Command::new(agent_binary())
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_SOCKET_PATH", socket_path)
        .env("TERMIHUB_TYPE_ID", "docker")
        .env("TERMIHUB_BUFFER_SIZE", "65536")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn_guarded()
        .expect("Failed to spawn daemon process");

    // The daemon reads its connection settings from stdin (AGT-021), not an env
    // var. Write the JSON and close the pipe so the daemon reads to EOF.
    write_settings_to_stdin(&mut child, &settings);

    DaemonHandle {
        child,
        socket_path: socket_path.to_path_buf(),
    }
}

/// Hand the connection settings to a freshly spawned daemon over its stdin pipe.
fn write_settings_to_stdin(child: &mut std::process::Child, settings: &serde_json::Value) {
    use std::io::Write;
    let mut stdin = child.stdin.take().expect("daemon stdin should be piped");
    stdin
        .write_all(settings.to_string().as_bytes())
        .expect("failed to write daemon settings to stdin");
    // `stdin` drops here → EOF.
}

async fn wait_for_socket(path: &Path, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if path.exists() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn connect_and_handshake(
    socket_path: &Path,
) -> (FrameReader, tokio::net::unix::OwnedWriteHalf, Vec<u8>) {
    let stream = UnixStream::connect(socket_path)
        .await
        .expect("Failed to connect to daemon socket");
    let (reader, writer) = stream.into_split();
    let mut frame_reader = FrameReader::new(reader);

    let mut replay_data = Vec::new();

    loop {
        let frame = frame_reader
            .next_frame(Duration::from_secs(10))
            .await
            .expect("Error reading handshake frame")
            .expect("Unexpected EOF during handshake");

        match frame.msg_type {
            MSG_BUFFER_REPLAY => {
                replay_data = frame.payload;
            }
            MSG_READY => {
                break;
            }
            MSG_CAPABILITIES => {}
            other => {
                panic!("Unexpected frame type during handshake: 0x{other:02x}");
            }
        }
    }

    (frame_reader, writer, replay_data)
}

async fn read_until_output_contains(
    reader: &mut FrameReader,
    pattern: &[u8],
    timeout: Duration,
) -> bool {
    let mut accumulated = Vec::new();
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }

        match reader.next_frame(remaining).await {
            Ok(Some(frame)) => {
                if frame.msg_type == MSG_OUTPUT || frame.msg_type == MSG_BUFFER_REPLAY {
                    accumulated.extend_from_slice(&frame.payload);
                    if accumulated.windows(pattern.len()).any(|w| w == pattern) {
                        return true;
                    }
                } else if frame.msg_type == MSG_EXITED {
                    return false;
                }
            }
            Ok(None) => return false,
            Err(_) => return false,
        }
    }
}

fn temp_socket_path(label: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("Failed to create temp dir");
    let path = dir.path().join(format!("test-{label}.sock"));
    (dir, path)
}

// ── Tests ───────────────────────────────────────────────────────────

/// Test basic Docker session: spawn daemon with Docker backend, connect,
/// send input, verify output from inside the container.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_session_basic() {
    if !docker_ready() {
        return;
    }

    let (_dir, socket_path) = temp_socket_path("docker-basic");
    let _daemon = spawn_docker_daemon("docker-basic", &socket_path, "alpine:latest");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Send a command inside the container and check output.
    write_frame(&mut writer, MSG_INPUT, b"echo DOCKER_TEST_OK\n")
        .await
        .expect("Failed to send input");

    let found =
        read_until_output_contains(&mut reader, b"DOCKER_TEST_OK", Duration::from_secs(10)).await;
    assert!(found, "Expected to find DOCKER_TEST_OK in container output");

    // Verify we're inside a container by checking hostname.
    write_frame(&mut writer, MSG_INPUT, b"cat /etc/hostname\n")
        .await
        .expect("Failed to send hostname command");

    // The container ID (first 12 chars) should appear in output.
    // Just verify we get some output back.
    let found = read_until_output_contains(&mut reader, b"\n", Duration::from_secs(5)).await;
    assert!(found, "Expected output from hostname command");
}

/// Test Docker daemon recovery: kill daemon, spawn a new one, verify functional.
///
/// Each daemon creates its own container via the Docker backend, so this
/// tests that a new session can be started after the first one is killed.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_session_recovery() {
    if !docker_ready() {
        return;
    }

    // Phase 1: Create initial session, send data, then kill daemon.
    let (_dir, socket_path) = temp_socket_path("docker-recovery");
    {
        let mut daemon = spawn_docker_daemon("docker-recovery", &socket_path, "alpine:latest");

        assert!(
            wait_for_socket(&socket_path, Duration::from_secs(30)).await,
            "Daemon socket did not appear"
        );

        let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

        write_frame(&mut writer, MSG_INPUT, b"echo BEFORE_KILL\n")
            .await
            .expect("Failed to send input");

        let found =
            read_until_output_contains(&mut reader, b"BEFORE_KILL", Duration::from_secs(10)).await;
        assert!(found, "Expected BEFORE_KILL in output");

        // Kill the daemon.
        let _ = daemon.child.kill();
        let _ = daemon.child.wait();

        // Prevent DaemonHandle drop from trying to kill again.
        drop(reader);
        drop(writer);
        // Clean up socket manually since we killed the daemon.
        let _ = std::fs::remove_file(&daemon.socket_path);
        // Defuse the DaemonHandle so it doesn't double-kill.
        std::mem::forget(daemon);
    }

    // Phase 2: Spawn a new daemon (creates a new container).
    let (_dir2, socket_path2) = temp_socket_path("docker-recovery2");
    let _daemon2 = spawn_docker_daemon("docker-recovery2", &socket_path2, "alpine:latest");

    assert!(
        wait_for_socket(&socket_path2, Duration::from_secs(30)).await,
        "Second daemon socket did not appear"
    );

    let (mut reader2, mut writer2, _replay2) = connect_and_handshake(&socket_path2).await;

    // Verify the new session is functional.
    write_frame(&mut writer2, MSG_INPUT, b"echo AFTER_RECOVERY\n")
        .await
        .expect("Failed to send input after recovery");

    let found =
        read_until_output_contains(&mut reader2, b"AFTER_RECOVERY", Duration::from_secs(10)).await;
    assert!(
        found,
        "Expected AFTER_RECOVERY in output after daemon recovery"
    );
}

/// Test resize works inside a Docker session.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_resize() {
    if !docker_ready() {
        return;
    }

    let (_dir, socket_path) = temp_socket_path("docker-resize");
    let _daemon = spawn_docker_daemon("docker-resize", &socket_path, "alpine:latest");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Send resize.
    let resize_payload = encode_resize(120, 40);
    write_frame(&mut writer, MSG_RESIZE, &resize_payload)
        .await
        .expect("Failed to send resize");

    // Verify the session is still functional after resize.
    write_frame(&mut writer, MSG_INPUT, b"echo AFTER_DOCKER_RESIZE\n")
        .await
        .expect("Failed to send input after resize");

    let found =
        read_until_output_contains(&mut reader, b"AFTER_DOCKER_RESIZE", Duration::from_secs(10))
            .await;
    assert!(found, "Docker session should work after resize");
}

/// Test killing a Docker daemon session via MSG_KILL.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_kill() {
    if !docker_ready() {
        return;
    }

    let (_dir, socket_path) = temp_socket_path("docker-kill");
    let mut daemon = spawn_docker_daemon("docker-kill", &socket_path, "alpine:latest");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Tell the shell to exit first, then send MSG_KILL.
    write_frame(&mut writer, MSG_INPUT, b"exit 0\n")
        .await
        .expect("Failed to send exit command");

    tokio::time::sleep(Duration::from_millis(500)).await;

    let _ = write_frame(&mut writer, MSG_KILL, &[]).await;

    // Read until we get Exited or EOF.
    let mut got_exited_or_eof = false;
    loop {
        match reader.next_frame(Duration::from_secs(10)).await {
            Ok(Some(frame)) => {
                if frame.msg_type == MSG_EXITED {
                    got_exited_or_eof = true;
                    break;
                }
            }
            Ok(None) => {
                got_exited_or_eof = true;
                break;
            }
            Err(_) => break,
        }
    }

    drop(writer);
    drop(reader);

    // Wait for daemon process to exit.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut daemon_exited = false;
    loop {
        match daemon.child.try_wait() {
            Ok(Some(_)) => {
                daemon_exited = true;
                break;
            }
            Ok(None) => {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => break,
        }
    }

    assert!(
        got_exited_or_eof || daemon_exited,
        "Expected Exited frame / EOF or daemon exit after kill"
    );
}

// ── Session monitoring through the daemon (#3871) ─────────────────

/// A distroless image: no shell, no `/proc` tooling (the #3202 fixture).
const DISTROLESS: &str = "gcr.io/distroless/python3-debian12:latest";

/// A long-lived container started with the docker CLI; removed on drop.
struct Container(String);

impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "-f", &self.0])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Start `image` running `args` in the background, or `None` to skip.
fn start_container(label: &str, image: &str, args: &[&str]) -> Option<Container> {
    let name = format!("termihub-3871-{label}-{}", std::process::id());
    let ok = Command::new("docker")
        .args(["run", "-d", "--name", &name, "--entrypoint", args[0], image])
        .args(&args[1..])
        .stdout(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Some(Container(name))
    } else {
        let _ = Container(name);
        None
    }
}

/// Spawn a daemon attached to an existing container through `shell`.
fn spawn_existing_container_daemon(
    session_id: &str,
    socket_path: &Path,
    container: &str,
    shell: &str,
) -> DaemonHandle {
    let settings = serde_json::json!({
        "containerMode": "existing",
        "existingContainer": container,
        "shell": shell,
    });
    let mut child = Command::new(agent_binary())
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_SOCKET_PATH", socket_path)
        .env("TERMIHUB_TYPE_ID", "docker")
        .env("TERMIHUB_BUFFER_SIZE", "65536")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn_guarded()
        .expect("Failed to spawn daemon process");
    write_settings_to_stdin(&mut child, &settings);
    DaemonHandle {
        child,
        socket_path: socket_path.to_path_buf(),
    }
}

/// Connect and complete the handshake, returning the capability flags.
async fn connect_with_capabilities(
    socket_path: &Path,
) -> (FrameReader, tokio::net::unix::OwnedWriteHalf, u8) {
    let stream = UnixStream::connect(socket_path)
        .await
        .expect("Failed to connect to daemon socket");
    let (reader, writer) = stream.into_split();
    let mut reader = FrameReader::new(reader);
    let mut flags = 0;
    loop {
        let frame = reader
            .next_frame(Duration::from_secs(30))
            .await
            .expect("Error reading handshake frame")
            .expect("Unexpected EOF during handshake");
        match frame.msg_type {
            MSG_READY => break,
            MSG_CAPABILITIES => flags = frame.payload.first().copied().unwrap_or(0),
            _ => {}
        }
    }
    (reader, writer, flags)
}

/// Subscribe the session's monitor and return the first sample's JSON.
async fn first_monitoring_sample(
    reader: &mut FrameReader,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> serde_json::Value {
    let request = serde_json::json!({"id": 1, "op": "subscribe"});
    write_frame(
        writer,
        MSG_MONITORING_REQUEST,
        request.to_string().as_bytes(),
    )
    .await
    .expect("Failed to send the subscribe");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = reader
            .next_frame(remaining)
            .await
            .expect("a monitoring event in time")
            .expect("the daemon stays up");
        if frame.msg_type != MSG_MONITORING_EVENT {
            continue;
        }
        let event: serde_json::Value = serde_json::from_slice(&frame.payload).expect("event JSON");
        match event["event"].as_str() {
            Some("reply") => assert!(
                event.get("error").is_none(),
                "the subscribe failed: {event}"
            ),
            Some("stats") => return event["stats"].clone(),
            _ => {}
        }
    }
}

/// A distroless container monitored through an agent-hosted session falls
/// back to the Docker Engine stats API (#3202), end to end through the
/// session daemon (#3871).
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_session_monitoring_distroless_uses_docker_stats() {
    if !docker_ready() {
        return;
    }
    let args = ["/usr/bin/python3", "-c", "import time; time.sleep(300)"];
    let Some(container) = start_container("distroless", DISTROLESS, &args) else {
        test_fixtures::missing(
            test_fixtures::REQUIRE_DOCKER_ENV,
            &format!("could not start a {DISTROLESS} container"),
            DOCKER_HINT,
        );
        return;
    };

    let (_dir, socket_path) = temp_socket_path("docker-mon-distroless");
    let _daemon =
        spawn_existing_container_daemon("docker-mon-dl", &socket_path, &container.0, args[0]);
    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, flags) = connect_with_capabilities(&socket_path).await;
    assert_ne!(flags & CAP_MONITORING, 0, "the daemon serves monitoring");

    let sample = first_monitoring_sample(&mut reader, &mut writer).await;
    assert_eq!(sample["source"], "dockerStats", "{sample}");
    assert!(
        sample["memoryTotalKb"].as_u64().unwrap_or(0) > 0,
        "{sample}"
    );
}

/// A `/proc`-capable container keeps the richer `/proc` source.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_session_monitoring_proc_container_uses_proc() {
    if !docker_ready() {
        return;
    }
    let Some(container) = start_container("proc", "alpine:latest", &["sleep", "300"]) else {
        test_fixtures::missing(
            test_fixtures::REQUIRE_DOCKER_ENV,
            "could not start an alpine container",
            DOCKER_HINT,
        );
        return;
    };

    let (_dir, socket_path) = temp_socket_path("docker-mon-proc");
    let _daemon =
        spawn_existing_container_daemon("docker-mon-proc", &socket_path, &container.0, "/bin/sh");
    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, flags) = connect_with_capabilities(&socket_path).await;
    assert_ne!(flags & CAP_MONITORING, 0, "the daemon serves monitoring");

    let sample = first_monitoring_sample(&mut reader, &mut writer).await;
    assert_ne!(sample["source"], "dockerStats", "{sample}");
    assert!(sample["diskTotalKb"].as_u64().unwrap_or(0) > 0, "{sample}");
}

// ── Session file browsing through the daemon (#3242) ──────────────

/// Agent → daemon file request, a write's data, and the replies (#3242).
const MSG_FILE_REQUEST: u8 = 0x09;
const MSG_FILE_WRITE_DATA: u8 = 0x0A;
const MSG_FILE_RESPONSE: u8 = 0x8A;
const MSG_FILE_READ_DATA: u8 = 0x8B;
/// [`MSG_CAPABILITIES`] flag: the daemon serves file requests (#3242).
const CAP_FILES: u8 = 0x04;

/// Send file request `request` (plus a write's `data`) and collect its reply
/// together with the bytes of a read.
async fn file_call(
    reader: &mut FrameReader,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    request: serde_json::Value,
    data: &[u8],
) -> (serde_json::Value, Vec<u8>) {
    let id = request["id"].as_u64().expect("request id");
    write_frame(writer, MSG_FILE_REQUEST, request.to_string().as_bytes())
        .await
        .expect("send the file request");
    for chunk in data.chunks(64 * 1024) {
        let mut payload = id.to_be_bytes().to_vec();
        payload.extend_from_slice(chunk);
        write_frame(writer, MSG_FILE_WRITE_DATA, &payload)
            .await
            .expect("send write data");
    }
    let mut bytes = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = reader
            .next_frame(remaining)
            .await
            .expect("a file reply in time")
            .expect("the daemon stays up");
        match frame.msg_type {
            MSG_FILE_READ_DATA => {
                assert_eq!(
                    frame.payload[..8],
                    id.to_be_bytes(),
                    "chunk for this request"
                );
                bytes.extend_from_slice(&frame.payload[8..]);
            }
            MSG_FILE_RESPONSE => {
                let reply: serde_json::Value =
                    serde_json::from_slice(&frame.payload).expect("reply JSON");
                assert_eq!(reply["id"], id);
                return (reply["outcome"].clone(), bytes);
            }
            _ => {}
        }
    }
}

/// An agent-hosted Docker session browses **inside its container** through
/// the session daemon (#3242): the listing shows the container's own files,
/// and a multi-chunk write reads back intact — none of it touches the agent
/// host.
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn test_docker_session_browses_inside_the_container() {
    if !docker_ready() {
        return;
    }
    let args = [
        "/bin/sh",
        "-c",
        "echo inside > /tmp/marker-3242 && sleep 300",
    ];
    let Some(container) = start_container("files", "alpine:latest", &args) else {
        test_fixtures::missing(
            test_fixtures::REQUIRE_DOCKER_ENV,
            "could not start an alpine container",
            DOCKER_HINT,
        );
        return;
    };
    let (_dir, socket_path) = temp_socket_path("docker-files");
    let _daemon =
        spawn_existing_container_daemon("docker-files", &socket_path, &container.0, "/bin/sh");
    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, flags) = connect_with_capabilities(&socket_path).await;
    assert_ne!(flags & CAP_FILES, 0, "the daemon serves file browsing");

    // Give the container's startup command a moment to write its marker.
    let mut listed = serde_json::Value::Null;
    for attempt in 1..=20u64 {
        let (outcome, _) = file_call(
            &mut reader,
            &mut writer,
            serde_json::json!({"id": attempt, "op": "list", "path": "/tmp"}),
            &[],
        )
        .await;
        assert_eq!(outcome["status"], "listed", "{outcome}");
        if outcome["entries"]
            .as_array()
            .is_some_and(|e| e.iter().any(|e| e["name"] == "marker-3242"))
        {
            listed = outcome;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(!listed.is_null(), "the container's own /tmp is listed");

    let (outcome, bytes) = file_call(
        &mut reader,
        &mut writer,
        serde_json::json!({"id": 100, "op": "read", "path": "/tmp/marker-3242"}),
        &[],
    )
    .await;
    assert_eq!(outcome["status"], "read", "{outcome}");
    assert_eq!(bytes, b"inside\n");

    let upload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let (outcome, _) = file_call(
        &mut reader,
        &mut writer,
        serde_json::json!({
            "id": 101, "op": "write", "path": "/tmp/upload-3242.bin", "size": upload.len()
        }),
        &upload,
    )
    .await;
    assert_eq!(outcome["status"], "done", "{outcome}");

    let (outcome, bytes) = file_call(
        &mut reader,
        &mut writer,
        serde_json::json!({"id": 102, "op": "read", "path": "/tmp/upload-3242.bin"}),
        &[],
    )
    .await;
    assert_eq!(outcome["status"], "read", "{outcome}");
    assert!(bytes == upload, "the multi-chunk upload reads back intact");
}
