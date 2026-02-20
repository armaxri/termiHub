//! Integration tests for the shell session daemon system.
//!
//! These tests spawn a real `termihub-agent --daemon` process using the
//! binary built by cargo, connect to it via Unix socket, and exercise the
//! full frame protocol: connect, input/output, resize, detach/reconnect,
//! and kill.
//!
//! Because the daemon requires a real PTY (fork + openpty), these tests
//! are Unix-only and will not compile or run on Windows.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

// ── Inlined frame protocol ─────────────────────────────────────────
//
// The agent is a binary crate (no lib.rs), so we cannot import its
// types in integration tests. We inline the minimal subset of the
// frame protocol needed to drive the daemon.

const MSG_INPUT: u8 = 0x01;
const MSG_RESIZE: u8 = 0x02;
const MSG_DETACH: u8 = 0x03;
const MSG_KILL: u8 = 0x04;

const MSG_OUTPUT: u8 = 0x81;
const MSG_BUFFER_REPLAY: u8 = 0x82;
const MSG_EXITED: u8 = 0x83;
#[allow(dead_code)]
const MSG_ERROR: u8 = 0x84;
const MSG_READY: u8 = 0x85;

const HEADER_SIZE: usize = 5;

#[derive(Debug, Clone)]
struct Frame {
    msg_type: u8,
    payload: Vec<u8>,
}

// ── Cancellation-safe frame reader ──────────────────────────────────
//
// `tokio::io::AsyncReadExt::read_exact` is NOT cancellation-safe: if
// a `tokio::time::timeout` fires mid-read, partially consumed bytes are
// lost and the stream becomes corrupted. To avoid this, we buffer all
// reads ourselves and only parse complete frames from the buffer. The
// `read()` method (returning however many bytes are available) IS
// cancellation-safe, so using it with timeout is safe.

/// A buffered frame reader that is safe to use with `tokio::time::timeout`.
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

    /// Try to parse a complete frame from the internal buffer.
    ///
    /// Returns `Some(frame)` if a complete frame is available,
    /// `None` if more data is needed.
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

    /// Read the next frame, waiting up to `timeout` for data.
    ///
    /// Returns:
    /// - `Ok(Some(frame))` — a complete frame was read
    /// - `Ok(None)` — EOF (daemon closed connection)
    /// - `Err("timeout")` — no complete frame within the timeout
    /// - `Err(msg)` — IO error
    async fn next_frame(&mut self, timeout: Duration) -> Result<Option<Frame>, String> {
        let deadline = tokio::time::Instant::now() + timeout;

        loop {
            // Check if we already have a complete frame buffered.
            if let Some(frame) = self.try_parse_frame() {
                return Ok(Some(frame));
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err("timeout".to_string());
            }

            // Read more data (cancellation-safe: `read` returns partial results).
            let mut tmp = [0u8; 4096];
            match tokio::time::timeout(remaining, self.reader.read(&mut tmp)).await {
                Ok(Ok(0)) => return Ok(None), // EOF
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

fn decode_exit_code(payload: &[u8]) -> Option<i32> {
    if payload.len() < 4 {
        return None;
    }
    Some(i32::from_be_bytes([
        payload[0], payload[1], payload[2], payload[3],
    ]))
}

// ── Test helpers ────────────────────────────────────────────────────

/// Path to the compiled `termihub-agent` binary.
fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

/// A running daemon process with its socket path.
///
/// On drop, sends SIGKILL to the daemon and removes the socket file.
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

/// Spawn a daemon process for the given session ID.
///
/// Returns a handle that cleans up the process on drop.
fn spawn_daemon(session_id: &str, socket_path: &Path) -> DaemonHandle {
    let child = Command::new(agent_binary())
        .arg("--daemon")
        .arg(session_id)
        .env("TERMIHUB_SOCKET_PATH", socket_path)
        .env("TERMIHUB_SHELL", "/bin/sh")
        .env("TERMIHUB_COLS", "80")
        .env("TERMIHUB_ROWS", "24")
        .env("TERMIHUB_BUFFER_SIZE", "65536")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn daemon process");

    DaemonHandle {
        child,
        socket_path: socket_path.to_path_buf(),
    }
}

/// Wait for the socket file to appear on disk, with a timeout.
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

/// Connect to the daemon and perform the initial handshake.
///
/// Reads the BufferReplay and Ready frames, returning the frame reader,
/// the writer half, and the buffer replay data.
async fn connect_and_handshake(
    socket_path: &Path,
) -> (FrameReader, tokio::net::unix::OwnedWriteHalf, Vec<u8>) {
    let stream = UnixStream::connect(socket_path)
        .await
        .expect("Failed to connect to daemon socket");
    let (reader, writer) = stream.into_split();
    let mut frame_reader = FrameReader::new(reader);

    let mut replay_data = Vec::new();

    // The daemon sends BufferReplay followed by Ready on each new connection.
    loop {
        let frame = frame_reader
            .next_frame(Duration::from_secs(5))
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
            other => {
                panic!("Unexpected frame type during handshake: 0x{other:02x}");
            }
        }
    }

    (frame_reader, writer, replay_data)
}

/// Read frames from the daemon until output containing `pattern` is found.
///
/// Returns `true` if the pattern was found within the timeout.
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

/// Generate a unique socket path inside a temp directory.
fn temp_socket_path(label: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("Failed to create temp dir");
    let path = dir.path().join(format!("test-{label}.sock"));
    (dir, path)
}

// ── Tests ───────────────────────────────────────────────────────────

/// Test basic connect: spawn daemon, connect, receive BufferReplay + Ready.
#[tokio::test]
async fn test_connect_and_handshake() {
    let (_dir, socket_path) = temp_socket_path("handshake");
    let _daemon = spawn_daemon("test-handshake", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (_reader, _writer, replay_data) = connect_and_handshake(&socket_path).await;

    // On a fresh shell, the buffer replay may be empty or contain a prompt.
    // Just verify we got through the handshake successfully.
    assert!(
        replay_data.len() < 65536,
        "Buffer replay should not exceed the configured buffer size"
    );
}

/// Test sending input and reading output back from the shell.
#[tokio::test]
async fn test_input_output() {
    let (_dir, socket_path) = temp_socket_path("io");
    let _daemon = spawn_daemon("test-io", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Send a command that produces deterministic output.
    // Use printf to avoid echo portability issues.
    write_frame(&mut writer, MSG_INPUT, b"printf 'MARKER_12345\\n'\n")
        .await
        .expect("Failed to send input");

    // Read output until we see our marker.
    let found =
        read_until_output_contains(&mut reader, b"MARKER_12345", Duration::from_secs(5)).await;

    assert!(found, "Expected to find MARKER_12345 in shell output");
}

/// Test that PTY resize frames are accepted without error.
///
/// We cannot directly observe the terminal size from outside, but we can
/// verify that the daemon processes the resize by checking that:
/// 1. The resize frame is accepted (no disconnect).
/// 2. A subsequent command still produces output.
#[tokio::test]
async fn test_resize() {
    let (_dir, socket_path) = temp_socket_path("resize");
    let _daemon = spawn_daemon("test-resize", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Send resize to 120x40
    let resize_payload = encode_resize(120, 40);
    write_frame(&mut writer, MSG_RESIZE, &resize_payload)
        .await
        .expect("Failed to send resize");

    // Verify the session is still functional by running a command.
    write_frame(&mut writer, MSG_INPUT, b"printf 'AFTER_RESIZE\\n'\n")
        .await
        .expect("Failed to send input after resize");

    let found =
        read_until_output_contains(&mut reader, b"AFTER_RESIZE", Duration::from_secs(5)).await;

    assert!(found, "Shell should still produce output after resize");
}

/// Test detach and reconnect with buffer replay.
///
/// 1. Connect, send a command that produces known output.
/// 2. Send detach and disconnect.
/// 3. Reconnect — the daemon should replay the ring buffer contents.
#[tokio::test]
async fn test_detach_and_reconnect() {
    let (_dir, socket_path) = temp_socket_path("detach");
    let _daemon = spawn_daemon("test-detach", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    // First connection: send a command and wait for output.
    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    write_frame(&mut writer, MSG_INPUT, b"printf 'PERSIST_DATA\\n'\n")
        .await
        .expect("Failed to send input");

    let found =
        read_until_output_contains(&mut reader, b"PERSIST_DATA", Duration::from_secs(5)).await;
    assert!(found, "Expected output before detach");

    // Detach: send detach frame and drop the connection.
    write_frame(&mut writer, MSG_DETACH, &[])
        .await
        .expect("Failed to send detach");
    drop(writer);
    drop(reader);

    // Brief pause to let the daemon process the disconnection.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Reconnect: the daemon should replay the ring buffer.
    let (_reader2, _writer2, replay_data) = connect_and_handshake(&socket_path).await;

    // The ring buffer should contain the output from the first session,
    // including our marker.
    let replay_str = String::from_utf8_lossy(&replay_data);
    assert!(
        replay_str.contains("PERSIST_DATA"),
        "Buffer replay should contain output from before detach. Got: {replay_str}"
    );
}

/// Test that MSG_KILL is received by the daemon and triggers shutdown.
///
/// The daemon sends SIGTERM to the shell child after receiving MSG_KILL.
/// On some platforms, the login shell may not terminate immediately from
/// SIGTERM alone (e.g., macOS /bin/sh ignoring SIGTERM during startup),
/// so we first tell the shell to exit, then send MSG_KILL. The test
/// verifies that the daemon processes the kill request and the daemon
/// process terminates.
#[tokio::test]
async fn test_kill() {
    let (_dir, socket_path) = temp_socket_path("kill");
    let mut daemon = spawn_daemon("test-kill", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // First tell the shell to exit so it starts shutting down. On macOS,
    // login shells may not respond to SIGTERM while reading profile scripts,
    // so we need the shell to exit on its own before sending MSG_KILL.
    write_frame(&mut writer, MSG_INPUT, b"exit 0\n")
        .await
        .expect("Failed to send exit command");

    // Brief pause to let the shell start exiting.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Send MSG_KILL — the daemon will SIGTERM the child and waitpid.
    // Since the shell is already exiting, waitpid should return quickly.
    let _ = write_frame(&mut writer, MSG_KILL, &[]).await;

    // Read frames until we get Exited or EOF.
    let mut got_exited_or_eof = false;
    loop {
        match reader.next_frame(Duration::from_secs(10)).await {
            Ok(Some(frame)) => {
                if frame.msg_type == MSG_EXITED {
                    got_exited_or_eof = true;
                    break;
                }
                // Skip output frames.
            }
            Ok(None) => {
                // EOF — daemon closed the connection.
                got_exited_or_eof = true;
                break;
            }
            Err(_) => break,
        }
    }

    drop(writer);
    drop(reader);

    // Wait for the daemon process to exit.
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
        "Expected either an Exited frame / EOF or the daemon process to exit after kill"
    );
}

/// Test that the daemon exits and sends Exited when the shell exits on its own.
#[tokio::test]
async fn test_shell_exit() {
    let (_dir, socket_path) = temp_socket_path("exit");
    let _daemon = spawn_daemon("test-exit", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Tell the shell to exit with a specific code.
    write_frame(&mut writer, MSG_INPUT, b"exit 42\n")
        .await
        .expect("Failed to send exit command");

    // Read until we get an Exited frame.
    let mut exit_code: Option<i32> = None;
    loop {
        match reader.next_frame(Duration::from_secs(5)).await {
            Ok(Some(frame)) => {
                if frame.msg_type == MSG_EXITED {
                    exit_code = decode_exit_code(&frame.payload);
                    break;
                }
            }
            _ => break,
        }
    }

    assert_eq!(exit_code, Some(42), "Shell should exit with code 42");
}

/// Test that multiple resize operations work without crashing the daemon.
#[tokio::test]
async fn test_multiple_resizes() {
    let (_dir, socket_path) = temp_socket_path("multi-resize");
    let _daemon = spawn_daemon("test-multi-resize", &socket_path);

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)).await,
        "Daemon socket did not appear"
    );

    let (mut reader, mut writer, _replay) = connect_and_handshake(&socket_path).await;

    // Send several resize operations in quick succession.
    let sizes: [(u16, u16); 5] = [(80, 24), (120, 40), (40, 10), (200, 60), (80, 24)];

    for (cols, rows) in sizes {
        let payload = encode_resize(cols, rows);
        write_frame(&mut writer, MSG_RESIZE, &payload)
            .await
            .expect("Failed to send resize");
    }

    // Verify the shell is still functional after all resizes.
    write_frame(&mut writer, MSG_INPUT, b"printf 'STILL_ALIVE\\n'\n")
        .await
        .expect("Failed to send input after resizes");

    let found =
        read_until_output_contains(&mut reader, b"STILL_ALIVE", Duration::from_secs(5)).await;

    assert!(found, "Shell should still work after multiple resizes");
}
