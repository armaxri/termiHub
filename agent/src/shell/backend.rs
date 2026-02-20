//! Agent-side shell backend — connects to a session daemon process.
//!
//! Spawns `termihub-agent --daemon <session-id>` as a child process and
//! communicates with it via a Unix domain socket using the binary frame
//! protocol. A tokio reader task converts daemon frames into JSON-RPC
//! notifications for the desktop.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::daemon::protocol::{self, *};
use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::ShellConfig;

/// How long to wait for the daemon socket to appear after spawning.
const SOCKET_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
/// How often to poll for the socket file.
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long to wait for the Ready frame after connecting.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Agent-side handle for a shell session backed by a daemon process.
///
/// Manages the lifecycle of the daemon, the Unix socket connection, and
/// a background reader task that streams output as JSON-RPC notifications.
pub struct ShellBackend {
    session_id: String,
    socket_path: PathBuf,
    /// Writer half of the Unix socket connection.
    writer: Arc<Mutex<Option<tokio::net::unix::OwnedWriteHalf>>>,
    /// Background reader task handle.
    reader_task: Option<tokio::task::JoinHandle<()>>,
    /// Whether this session is alive (daemon running, not exited).
    alive: Arc<AtomicBool>,
    /// Notification channel to the transport loop.
    notification_tx: NotificationSender,
}

impl ShellBackend {
    /// Spawn a new daemon and connect to it.
    pub async fn new(
        session_id: String,
        config: &ShellConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let socket_path = crate::daemon::process::socket_dir()
            .join(format!("session-{session_id}.sock"));

        // Build environment for the daemon
        let env_json = serde_json::to_string(&config.env)?;
        let shell = config
            .shell
            .clone()
            .unwrap_or_else(|| detect_default_shell());

        let agent_exe = std::env::current_exe()?;

        // Spawn daemon process
        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_SHELL", &shell)
            .env("TERMIHUB_COLS", config.cols.to_string())
            .env("TERMIHUB_ROWS", config.rows.to_string())
            .env("TERMIHUB_ENV", &env_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon: {e}"))?;

        info!(
            "Daemon spawned for session {session_id}: shell={shell}, size={}x{}",
            config.cols, config.rows
        );

        // Wait for socket to appear
        wait_for_socket(&socket_path).await?;

        // Connect and set up reader
        let (writer, reader_task, alive) =
            connect_and_start_reader(&socket_path, &session_id, notification_tx.clone()).await?;

        Ok(Self {
            session_id,
            socket_path,
            writer: Arc::new(Mutex::new(Some(writer))),
            reader_task: Some(reader_task),
            alive,
            notification_tx,
        })
    }

    /// Reconnect to an existing daemon socket (for session recovery).
    pub async fn reconnect(
        session_id: String,
        socket_path: PathBuf,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let (writer, reader_task, alive) =
            connect_and_start_reader(&socket_path, &session_id, notification_tx.clone()).await?;

        info!("Reconnected to daemon for session {session_id}");

        Ok(Self {
            session_id,
            socket_path,
            writer: Arc::new(Mutex::new(Some(writer))),
            reader_task: Some(reader_task),
            alive,
            notification_tx,
        })
    }

    /// Write raw input to the shell via the daemon.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), anyhow::Error> {
        let mut guard = self.writer.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected to daemon"))?;
        protocol::write_frame_async(writer, MSG_INPUT, data).await?;
        Ok(())
    }

    /// Attach to the session by reconnecting to the daemon socket.
    ///
    /// The daemon sends a BufferReplay on every new connection, so
    /// reconnecting gives us a fresh buffer replay.
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        // Disconnect current connection (triggers Detach on daemon side via EOF)
        self.disconnect().await;

        // Reconnect to get a fresh buffer replay
        let (writer, reader_task, alive) = connect_and_start_reader(
            &self.socket_path,
            &self.session_id,
            self.notification_tx.clone(),
        )
        .await?;

        *self.writer.lock().await = Some(writer);
        self.reader_task = Some(reader_task);
        self.alive = alive;

        info!("Reattached to session {}", self.session_id);
        Ok(())
    }

    /// Detach from the session without killing the daemon.
    pub async fn detach(&mut self) {
        // Send Detach frame if connected
        if let Some(ref mut writer) = *self.writer.lock().await {
            let _ = protocol::write_frame_async(writer, MSG_DETACH, &[]).await;
        }
        self.disconnect().await;
        debug!("Detached from session {}", self.session_id);
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), anyhow::Error> {
        let mut guard = self.writer.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected to daemon"))?;
        let payload = protocol::encode_resize(cols, rows);
        protocol::write_frame_async(writer, MSG_RESIZE, &payload).await?;
        Ok(())
    }

    /// Kill the daemon and close the session.
    pub async fn close(&mut self) {
        // Send Kill frame if connected
        {
            let mut guard = self.writer.lock().await;
            if let Some(ref mut writer) = *guard {
                let _ = protocol::write_frame_async(writer, MSG_KILL, &[]).await;
            }
        }
        self.disconnect().await;
        info!("Closed shell session {}", self.session_id);
    }

    /// Whether the daemon is still alive.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Get the socket path for state persistence.
    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    /// Disconnect the current socket connection and abort the reader task.
    async fn disconnect(&mut self) {
        // Drop the writer half (closes our end of the socket)
        *self.writer.lock().await = None;
        // Abort the reader task
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
    }
}

/// Detect the default shell for the current user.
fn detect_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// Wait for the daemon socket file to appear on disk.
async fn wait_for_socket(path: &PathBuf) -> Result<(), anyhow::Error> {
    let deadline = tokio::time::Instant::now() + SOCKET_WAIT_TIMEOUT;

    loop {
        if path.exists() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "Daemon socket did not appear within {:?}: {}",
                SOCKET_WAIT_TIMEOUT,
                path.display()
            ));
        }
        tokio::time::sleep(SOCKET_POLL_INTERVAL).await;
    }
}

/// Connect to the daemon socket, wait for the Ready frame, and start the reader task.
///
/// Returns the writer half, the reader task handle, and the alive flag.
async fn connect_and_start_reader(
    socket_path: &PathBuf,
    session_id: &str,
    notification_tx: NotificationSender,
) -> Result<
    (
        tokio::net::unix::OwnedWriteHalf,
        tokio::task::JoinHandle<()>,
        Arc<AtomicBool>,
    ),
    anyhow::Error,
> {
    let stream = UnixStream::connect(socket_path).await?;
    let (mut reader, writer) = stream.into_split();

    let alive = Arc::new(AtomicBool::new(true));

    // Wait for BufferReplay + Ready, sending replay as notification
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(anyhow::anyhow!("Daemon did not send Ready within {:?}", READY_TIMEOUT));
        }

        match tokio::time::timeout(remaining, protocol::read_frame_async(&mut reader)).await {
            Ok(Ok(Some(frame))) => match frame.msg_type {
                MSG_BUFFER_REPLAY => {
                    // Send as session.output if non-empty
                    if !frame.payload.is_empty() {
                        send_output_notification(&notification_tx, session_id, &frame.payload);
                    }
                }
                MSG_READY => {
                    break;
                }
                MSG_EXITED => {
                    let code = protocol::decode_exit_code(&frame.payload).unwrap_or(-1);
                    return Err(anyhow::anyhow!("Shell already exited with code {code}"));
                }
                _ => {
                    debug!("Unexpected frame during handshake: 0x{:02x}", frame.msg_type);
                }
            },
            Ok(Ok(None)) => {
                return Err(anyhow::anyhow!("Daemon closed connection during handshake"));
            }
            Ok(Err(e)) => {
                return Err(anyhow::anyhow!("Frame read error during handshake: {e}"));
            }
            Err(_) => {
                return Err(anyhow::anyhow!("Daemon did not send Ready within {:?}", READY_TIMEOUT));
            }
        }
    }

    // Start the background reader task
    let alive_clone = alive.clone();
    let session_id_owned = session_id.to_string();
    let tx = notification_tx.clone();

    let reader_task = tokio::spawn(async move {
        reader_loop(reader, &session_id_owned, &tx, &alive_clone).await;
    });

    Ok((writer, reader_task, alive))
}

/// Background task that reads frames from the daemon and sends notifications.
async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    session_id: &str,
    notification_tx: &NotificationSender,
    alive: &AtomicBool,
) {
    loop {
        match protocol::read_frame_async(&mut reader).await {
            Ok(Some(frame)) => match frame.msg_type {
                MSG_OUTPUT => {
                    send_output_notification(notification_tx, session_id, &frame.payload);
                }
                MSG_BUFFER_REPLAY => {
                    if !frame.payload.is_empty() {
                        send_output_notification(notification_tx, session_id, &frame.payload);
                    }
                }
                MSG_EXITED => {
                    let code = protocol::decode_exit_code(&frame.payload).unwrap_or(-1);
                    info!("Session {session_id} exited with code {code}");
                    alive.store(false, Ordering::SeqCst);

                    let notification = JsonRpcNotification::new(
                        "session.exit",
                        serde_json::json!({
                            "session_id": session_id,
                            "exit_code": code,
                        }),
                    );
                    let _ = notification_tx.send(notification);
                    return;
                }
                MSG_ERROR => {
                    let msg = String::from_utf8_lossy(&frame.payload);
                    warn!("Daemon error for session {session_id}: {msg}");

                    let notification = JsonRpcNotification::new(
                        "session.error",
                        serde_json::json!({
                            "session_id": session_id,
                            "message": msg.to_string(),
                        }),
                    );
                    let _ = notification_tx.send(notification);
                }
                MSG_READY => {
                    // Duplicate ready — ignore
                    debug!("Got additional Ready frame for session {session_id}");
                }
                other => {
                    debug!("Unknown frame type from daemon: 0x{other:02x}");
                }
            },
            Ok(None) => {
                // Daemon closed the connection (EOF)
                info!("Daemon connection closed for session {session_id}");
                alive.store(false, Ordering::SeqCst);
                return;
            }
            Err(e) => {
                error!("Frame read error for session {session_id}: {e}");
                alive.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
}

/// Send output data as a base64-encoded `session.output` notification.
///
/// Chunks large payloads to stay under the 1 MiB NDJSON line limit.
fn send_output_notification(tx: &NotificationSender, session_id: &str, data: &[u8]) {
    let b64 = base64::engine::general_purpose::STANDARD;
    for chunk in data.chunks(65536) {
        let encoded = b64.encode(chunk);
        let notification = JsonRpcNotification::new(
            "session.output",
            serde_json::json!({
                "session_id": session_id,
                "data": encoded,
            }),
        );
        let _ = tx.send(notification);
    }
}
