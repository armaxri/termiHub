//! Session daemon process — hosts a [`ConnectionType`] instance.
//!
//! Invoked as `termihub-agent --daemon <session-id>` by the agent.
//! Communicates with the agent via a Unix domain socket using the
//! length-prefixed binary frame protocol defined in `protocol.rs`.
//!
//! The daemon keeps the connection alive independently of the agent
//! process. When the agent disconnects and reconnects, the daemon
//! replays the ring buffer to bring the agent up to date.

use std::path::{Path, PathBuf};

use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::daemon::protocol::{self, *};
use termihub_core::buffer::RingBuffer;
use termihub_core::connection::{ConnectionType, OutputReceiver};

/// Default ring buffer size: 1 MiB.
const DEFAULT_BUFFER_SIZE: usize = 1_048_576;

/// Configuration for the session daemon, read from environment variables.
struct DaemonConfig {
    session_id: String,
    socket_path: PathBuf,
    type_id: String,
    settings: serde_json::Value,
    buffer_size: usize,
}

impl DaemonConfig {
    /// Read configuration from environment variables.
    ///
    /// Required env vars:
    /// - `TERMIHUB_TYPE_ID` — connection type identifier (e.g., `"local"`, `"ssh"`)
    /// - `TERMIHUB_SETTINGS` — JSON settings for `ConnectionType::connect()`
    ///
    /// Optional env vars:
    /// - `TERMIHUB_SOCKET_PATH` — Unix socket path (default: auto-generated)
    /// - `TERMIHUB_BUFFER_SIZE` — ring buffer size in bytes (default: 1 MiB)
    fn from_env(session_id: &str) -> anyhow::Result<Self> {
        let socket_path = std::env::var("TERMIHUB_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| socket_dir().join(format!("session-{session_id}.sock")));

        let type_id = std::env::var("TERMIHUB_TYPE_ID")
            .map_err(|_| anyhow::anyhow!("TERMIHUB_TYPE_ID env var is required"))?;

        let settings: serde_json::Value = std::env::var("TERMIHUB_SETTINGS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

        let buffer_size = std::env::var("TERMIHUB_BUFFER_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_BUFFER_SIZE);

        Ok(Self {
            session_id: session_id.to_string(),
            socket_path,
            type_id,
            settings,
            buffer_size,
        })
    }
}

/// Get the socket directory for the current user.
pub fn socket_dir() -> PathBuf {
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
    PathBuf::from("/tmp/termihub").join(user)
}

/// Ensure the socket directory exists with mode 0700.
fn ensure_socket_dir(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Entry point for the session daemon process.
///
/// Creates a [`ConnectionType`] instance from the registry, connects it
/// using the settings from environment variables, and runs the event loop
/// that bridges the connection to the agent via the Unix socket.
pub async fn run_daemon(session_id: &str) -> anyhow::Result<()> {
    let config = DaemonConfig::from_env(session_id)?;

    info!(
        "Session daemon starting: id={}, type={}, buffer={}",
        config.session_id, config.type_id, config.buffer_size
    );

    // Ensure socket directory exists
    if let Some(parent) = config.socket_path.parent() {
        ensure_socket_dir(parent)?;
    }

    // Remove stale socket file
    let _ = std::fs::remove_file(&config.socket_path);

    // Bind the Unix listener
    let listener = UnixListener::bind(&config.socket_path)?;

    // Set socket file permissions to 0700
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o700))?;

    info!("Listening on socket: {}", config.socket_path.display());

    // Create and connect the ConnectionType
    let registry = crate::registry::build_registry();
    let mut connection = registry.create(&config.type_id).map_err(|e| {
        anyhow::anyhow!("Failed to create connection type '{}': {e}", config.type_id)
    })?;

    connection
        .connect(config.settings.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect: {e}"))?;

    info!("Connection established: type={}", config.type_id);

    // Subscribe to output
    let output_rx = connection.subscribe_output();

    // Run the main event loop
    let result = daemon_loop(connection, output_rx, &listener, config.buffer_size).await;

    // Cleanup socket file
    let _ = std::fs::remove_file(&config.socket_path);

    info!("Session daemon exiting: {}", config.session_id);
    result
}

/// Commands sent from the agent reader task to the main loop.
enum AgentCommand {
    /// Raw input bytes for the connection.
    Input(Vec<u8>),
    /// Resize the terminal.
    Resize(u16, u16),
    /// Agent requested detach.
    Detach,
    /// Agent requested kill.
    Kill,
    /// Agent disconnected (EOF or error).
    Disconnected,
}

/// Main daemon event loop.
///
/// Multiplexes between connection output, new agent connections, and
/// agent commands using `tokio::select!`.
async fn daemon_loop(
    mut connection: Box<dyn ConnectionType>,
    mut output_rx: OutputReceiver,
    listener: &UnixListener,
    buffer_size: usize,
) -> anyhow::Result<()> {
    let mut ring_buffer = RingBuffer::new(buffer_size);
    let mut agent_writer: Option<OwnedWriteHalf> = None;
    let mut reader_task: Option<tokio::task::JoinHandle<()>> = None;

    // Channel for receiving commands from the agent reader task.
    let (agent_cmd_tx, mut agent_cmd_rx) = mpsc::channel::<AgentCommand>(64);

    loop {
        tokio::select! {
            // Output from the ConnectionType
            output = output_rx.recv() => {
                match output {
                    Some(data) => {
                        ring_buffer.write(&data);

                        // Forward to agent if connected
                        if let Some(ref mut writer) = agent_writer {
                            if protocol::write_frame_async(writer, MSG_OUTPUT, &data)
                                .await
                                .is_err()
                            {
                                debug!("Agent connection lost on write");
                                agent_writer = None;
                                abort_reader(&mut reader_task);
                            }
                        }
                    }
                    None => {
                        // Connection output channel closed — connection ended
                        info!("Connection output channel closed");
                        send_exited_async(&mut agent_writer, 0).await;
                        return Ok(());
                    }
                }
            }

            // New agent connection
            conn = listener.accept() => {
                match conn {
                    Ok((stream, _)) => {
                        info!("Agent connected");

                        // Drop the old connection
                        agent_writer = None;
                        abort_reader(&mut reader_task);

                        let (read_half, mut write_half) = stream.into_split();

                        // Send buffer replay
                        let buffered = ring_buffer.read_all();
                        if !buffered.is_empty() {
                            if protocol::write_frame_async(
                                &mut write_half,
                                MSG_BUFFER_REPLAY,
                                &buffered,
                            )
                            .await
                            .is_err()
                            {
                                warn!("Failed to send buffer replay");
                                continue;
                            }
                        }

                        // Send ready signal
                        if protocol::write_frame_async(&mut write_half, MSG_READY, &[])
                            .await
                            .is_err()
                        {
                            warn!("Failed to send ready");
                            continue;
                        }

                        agent_writer = Some(write_half);

                        // Spawn reader task for agent commands
                        let tx = agent_cmd_tx.clone();
                        reader_task = Some(tokio::spawn(async move {
                            agent_reader_loop(read_half, tx).await;
                        }));
                    }
                    Err(e) => {
                        warn!("Listener accept error: {e}");
                    }
                }
            }

            // Commands from the agent reader task
            cmd = agent_cmd_rx.recv() => {
                match cmd {
                    Some(AgentCommand::Input(data)) => {
                        if let Err(e) = connection.write(&data) {
                            warn!("Connection write error: {e}");
                        }
                    }
                    Some(AgentCommand::Resize(cols, rows)) => {
                        if let Err(e) = connection.resize(cols, rows) {
                            warn!("Connection resize error: {e}");
                        }
                    }
                    Some(AgentCommand::Detach) => {
                        info!("Agent requested detach");
                        agent_writer = None;
                        abort_reader(&mut reader_task);
                    }
                    Some(AgentCommand::Kill) => {
                        info!("Agent requested kill");
                        if let Err(e) = connection.disconnect().await {
                            warn!("Disconnect error: {e}");
                        }
                        send_exited_async(&mut agent_writer, 0).await;
                        return Ok(());
                    }
                    Some(AgentCommand::Disconnected) => {
                        info!("Agent disconnected");
                        agent_writer = None;
                        abort_reader(&mut reader_task);
                    }
                    None => {
                        // All senders dropped — shouldn't happen since we hold one
                        debug!("Agent command channel closed");
                    }
                }
            }
        }
    }
}

/// Background task that reads frames from the agent and sends commands
/// to the main loop via a channel.
async fn agent_reader_loop(mut reader: OwnedReadHalf, tx: mpsc::Sender<AgentCommand>) {
    loop {
        match protocol::read_frame_async(&mut reader).await {
            Ok(Some(frame)) => {
                let cmd = match frame.msg_type {
                    MSG_INPUT => AgentCommand::Input(frame.payload),
                    MSG_RESIZE => {
                        if let Some((cols, rows)) = protocol::decode_resize(&frame.payload) {
                            debug!("Resize to {cols}x{rows}");
                            AgentCommand::Resize(cols, rows)
                        } else {
                            continue;
                        }
                    }
                    MSG_DETACH => AgentCommand::Detach,
                    MSG_KILL => AgentCommand::Kill,
                    other => {
                        debug!("Unknown frame type from agent: 0x{other:02x}");
                        continue;
                    }
                };
                if tx.send(cmd).await.is_err() {
                    return; // main loop dropped the receiver
                }
            }
            Ok(None) => {
                // EOF
                let _ = tx.send(AgentCommand::Disconnected).await;
                return;
            }
            Err(e) => {
                debug!("Agent frame read error: {e}");
                let _ = tx.send(AgentCommand::Disconnected).await;
                return;
            }
        }
    }
}

/// Abort a running reader task if there is one.
fn abort_reader(task: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(t) = task.take() {
        t.abort();
    }
}

/// Send an Exited frame to the agent if connected.
async fn send_exited_async(writer: &mut Option<OwnedWriteHalf>, code: i32) {
    if let Some(ref mut w) = writer {
        let payload = protocol::encode_exit_code(code);
        let _ = protocol::write_frame_async(w, MSG_EXITED, &payload).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_dir_contains_user() {
        let dir = socket_dir();
        let dir_str = dir.to_string_lossy();
        assert!(dir_str.starts_with("/tmp/termihub/"));
    }

    #[test]
    fn daemon_config_requires_type_id() {
        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let result = DaemonConfig::from_env("test-123");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("TERMIHUB_TYPE_ID")
        );
    }

    #[test]
    fn daemon_config_from_env() {
        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::set_var(
            "TERMIHUB_SETTINGS",
            r#"{"host":"192.168.1.1","port":22}"#,
        );
        std::env::set_var("TERMIHUB_SOCKET_PATH", "/tmp/test-daemon.sock");
        std::env::set_var("TERMIHUB_BUFFER_SIZE", "2097152");

        let config = DaemonConfig::from_env("test-456").unwrap();
        assert_eq!(config.session_id, "test-456");
        assert_eq!(config.type_id, "ssh");
        assert_eq!(config.settings["host"], "192.168.1.1");
        assert_eq!(config.settings["port"], 22);
        assert_eq!(
            config.socket_path,
            PathBuf::from("/tmp/test-daemon.sock")
        );
        assert_eq!(config.buffer_size, 2097152);

        // Clean up
        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");
    }

    #[test]
    fn daemon_config_defaults() {
        std::env::set_var("TERMIHUB_TYPE_ID", "local");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let config = DaemonConfig::from_env("test-789").unwrap();
        assert_eq!(config.type_id, "local");
        assert_eq!(config.settings, serde_json::json!({}));
        assert_eq!(config.buffer_size, DEFAULT_BUFFER_SIZE);
        assert!(config
            .socket_path
            .to_string_lossy()
            .contains("session-test-789.sock"));

        // Clean up
        std::env::remove_var("TERMIHUB_TYPE_ID");
    }
}
