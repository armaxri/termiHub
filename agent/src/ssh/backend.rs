//! Agent-side SSH jump host backend.
//!
//! Spawns a session daemon that runs `ssh user@host` on its PTY,
//! enabling the agent to act as a jump host for reaching internal
//! targets not directly accessible from the desktop.

use std::path::Path;

use anyhow::Context;
use tracing::info;

use crate::daemon::client::DaemonClient;
use crate::io::transport::NotificationSender;
use crate::protocol::methods::SshSessionConfig;
use termihub_core::session::ssh::{build_ssh_args, validate_ssh_config};

/// Agent-side handle for an SSH jump host session.
///
/// Thin wrapper over `DaemonClient` that handles SSH-specific
/// command construction and daemon spawning.
pub struct SshBackend {
    client: DaemonClient,
}

impl SshBackend {
    /// Create a new SSH session to a remote target.
    ///
    /// Spawns a session daemon with `TERMIHUB_COMMAND=ssh` and the
    /// appropriate arguments for the target host.
    pub async fn new(
        session_id: String,
        config: &SshSessionConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        validate_ssh_config(config).map_err(|e| anyhow::anyhow!("{e}"))?;

        let socket_path =
            crate::daemon::process::socket_dir().join(format!("session-{session_id}.sock"));

        let command_args = build_ssh_args(config);
        let command_args_json =
            serde_json::to_string(&command_args).context("Failed to serialize SSH args")?;

        let env_json = serde_json::to_string(&config.env)?;

        let agent_exe = std::env::current_exe()?;

        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_COMMAND", "ssh")
            .env("TERMIHUB_COMMAND_ARGS", &command_args_json)
            .env("TERMIHUB_COLS", config.cols.to_string())
            .env("TERMIHUB_ROWS", config.rows.to_string())
            .env("TERMIHUB_ENV", &env_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon for SSH session: {e}"))?;

        info!(
            "SSH daemon spawned for session {session_id}: {}@{}",
            config.username, config.host
        );

        DaemonClient::wait_for_socket(&socket_path).await?;
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        Ok(Self { client })
    }

    /// Reconnect to an existing SSH session after agent restart.
    ///
    /// Removes any stale socket, spawns a fresh daemon with the same
    /// SSH command, and connects. The SSH connection re-establishes
    /// automatically (best-effort — may fail if keys require interaction).
    pub async fn reconnect(
        session_id: String,
        config: &SshSessionConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let socket_path =
            crate::daemon::process::socket_dir().join(format!("session-{session_id}.sock"));

        // Remove stale socket from previous daemon
        let _ = std::fs::remove_file(&socket_path);

        let command_args = build_ssh_args(config);
        let command_args_json = serde_json::to_string(&command_args)?;
        let env_json = serde_json::to_string(&config.env)?;

        let agent_exe = std::env::current_exe()?;

        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_COMMAND", "ssh")
            .env("TERMIHUB_COMMAND_ARGS", &command_args_json)
            .env("TERMIHUB_COLS", config.cols.to_string())
            .env("TERMIHUB_ROWS", config.rows.to_string())
            .env("TERMIHUB_ENV", &env_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon for SSH recovery: {e}"))?;

        info!(
            "SSH recovery daemon spawned for session {session_id}: {}@{}",
            config.username, config.host
        );

        DaemonClient::wait_for_socket(&socket_path).await?;
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        Ok(Self { client })
    }

    /// Write raw input to the SSH session via the daemon.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), anyhow::Error> {
        self.client.write_input(data).await
    }

    /// Attach to the session by reconnecting to the daemon socket.
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        self.client.attach().await
    }

    /// Detach from the session without killing the daemon or SSH connection.
    pub async fn detach(&mut self) {
        self.client.detach().await;
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), anyhow::Error> {
        self.client.resize(cols, rows).await
    }

    /// Close the SSH session: kill daemon (which terminates SSH).
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
