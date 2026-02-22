//! Agent-side shell backend — connects to a session daemon process.
//!
//! Spawns `termihub-agent --daemon <session-id>` as a child process and
//! communicates with it via a Unix domain socket using the binary frame
//! protocol. Delegates all socket I/O to `DaemonClient`.

use std::path::{Path, PathBuf};

use tracing::info;

use crate::daemon::client::DaemonClient;
use crate::io::transport::NotificationSender;
use crate::protocol::methods::ShellConfig;
use termihub_core::session::shell::{build_shell_command, initial_command_strategy, InitialCommandStrategy};

/// Agent-side handle for a shell session backed by a daemon process.
///
/// Thin wrapper over `DaemonClient` that handles daemon spawning
/// and shell-specific configuration.
pub struct ShellBackend {
    client: DaemonClient,
}

impl ShellBackend {
    /// Spawn a new daemon and connect to it.
    pub async fn new(
        session_id: String,
        config: &ShellConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let socket_path =
            crate::daemon::process::socket_dir().join(format!("session-{session_id}.sock"));

        // Build environment for the daemon
        let env_json = serde_json::to_string(&config.env)?;
        let shell_cmd = build_shell_command(config);

        let agent_exe = std::env::current_exe()?;

        // Spawn daemon process
        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_SHELL", &shell_cmd.program)
            .env("TERMIHUB_COLS", config.cols.to_string())
            .env("TERMIHUB_ROWS", config.rows.to_string())
            .env("TERMIHUB_ENV", &env_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon: {e}"))?;

        info!(
            "Daemon spawned for session {session_id}: shell={}, size={}x{}",
            shell_cmd.program, config.cols, config.rows
        );

        // Wait for socket to appear
        DaemonClient::wait_for_socket(&socket_path).await?;

        // Connect and set up reader
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        // Handle initial command if configured
        let strategy = initial_command_strategy(config.initial_command.as_deref(), false);
        match strategy {
            InitialCommandStrategy::Delayed(cmd, delay) => {
                tokio::time::sleep(delay).await;
                let input = format!("{cmd}\n");
                client.write_input(input.as_bytes()).await?;
            }
            InitialCommandStrategy::Immediate(cmd) => {
                let input = format!("{cmd}\n");
                client.write_input(input.as_bytes()).await?;
            }
            InitialCommandStrategy::None | InitialCommandStrategy::WaitForClear(_) => {}
        }

        Ok(Self { client })
    }

    /// Reconnect to an existing daemon socket (for session recovery).
    pub async fn reconnect(
        session_id: String,
        socket_path: PathBuf,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        info!(
            "Reconnected to daemon for session {}",
            client.socket_path().display()
        );

        Ok(Self { client })
    }

    /// Write raw input to the shell via the daemon.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), anyhow::Error> {
        self.client.write_input(data).await
    }

    /// Attach to the session by reconnecting to the daemon socket.
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        self.client.attach().await
    }

    /// Detach from the session without killing the daemon.
    pub async fn detach(&mut self) {
        self.client.detach().await;
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), anyhow::Error> {
        self.client.resize(cols, rows).await
    }

    /// Kill the daemon and close the session.
    pub async fn close(&mut self) {
        self.client.close().await;
    }

    /// Whether the daemon is still alive.
    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.client.is_alive()
    }

    /// Get the socket path for state persistence.
    pub fn socket_path(&self) -> &Path {
        self.client.socket_path()
    }
}
