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

/// Build the SSH command arguments from the session config.
///
/// Produces an argument list for `ssh` that the daemon will exec via
/// `spawn_command("ssh", args, ...)`.
fn build_ssh_args(config: &SshSessionConfig) -> Vec<String> {
    let mut args = vec![
        // Force TTY allocation for interactive use
        "-tt".to_string(),
        // Keep-alive to detect dead connections
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    // Port
    args.push("-p".to_string());
    args.push(config.port.to_string());

    // Key-based auth
    if config.auth_method == "key" {
        if let Some(ref key_path) = config.key_path {
            args.push("-i".to_string());
            args.push(key_path.clone());
        }
    }

    // Destination: user@host
    args.push(format!("{}@{}", config.username, config.host));

    // Optional remote shell command
    if let Some(ref shell) = config.shell {
        args.push(shell.clone());
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ssh_args_minimal() {
        let config = SshSessionConfig {
            host: "build.internal".to_string(),
            username: "dev".to_string(),
            auth_method: "agent".to_string(),
            port: 22,
            password: None,
            key_path: None,
            shell: None,
            cols: 80,
            rows: 24,
            env: Default::default(),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert_eq!(
            args,
            vec![
                "-tt",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-p",
                "22",
                "dev@build.internal",
            ]
        );
    }

    #[test]
    fn build_ssh_args_full() {
        let config = SshSessionConfig {
            host: "10.0.0.5".to_string(),
            username: "deploy".to_string(),
            auth_method: "key".to_string(),
            port: 2222,
            password: None,
            key_path: Some("/home/user/.ssh/id_ed25519".to_string()),
            shell: Some("/bin/bash".to_string()),
            cols: 120,
            rows: 40,
            env: Default::default(),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert_eq!(
            args,
            vec![
                "-tt",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-p",
                "2222",
                "-i",
                "/home/user/.ssh/id_ed25519",
                "deploy@10.0.0.5",
                "/bin/bash",
            ]
        );
    }

    #[test]
    fn build_ssh_args_password_auth_no_key() {
        let config = SshSessionConfig {
            host: "server.example.com".to_string(),
            username: "admin".to_string(),
            auth_method: "password".to_string(),
            port: 22,
            password: Some("secret".to_string()),
            key_path: Some("/some/key".to_string()),
            shell: None,
            cols: 80,
            rows: 24,
            env: Default::default(),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        // password auth should NOT add -i even when key_path is present
        assert!(!args.contains(&"-i".to_string()));
        assert!(args.contains(&"admin@server.example.com".to_string()));
    }
}
