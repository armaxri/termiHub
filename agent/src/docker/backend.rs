//! Agent-side Docker session backend.
//!
//! Creates a persistent detached container and spawns a session daemon
//! that runs `docker exec -it` on its PTY. The container outlives the
//! daemon, enabling recovery after agent restart.

use std::path::Path;

use anyhow::Context;
use tracing::info;

use crate::daemon::client::DaemonClient;
use crate::io::transport::NotificationSender;
use crate::protocol::methods::DockerSessionConfig;

/// Agent-side handle for a Docker container session.
///
/// Manages a detached container and a daemon process that runs
/// `docker exec -it` for interactive terminal access.
pub struct DockerBackend {
    container_name: String,
    remove_on_exit: bool,
    client: DaemonClient,
}

impl DockerBackend {
    /// Create a new Docker container session.
    ///
    /// 1. Runs `docker run -d --init --name termihub-<session-id> ...`
    /// 2. Spawns a session daemon with `TERMIHUB_COMMAND=docker`
    /// 3. Daemon runs `docker exec -it termihub-<session-id> <shell>` on its PTY
    pub async fn new(
        session_id: String,
        config: &DockerSessionConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let container_name = format!("termihub-{session_id}");
        let shell = config
            .shell
            .clone()
            .unwrap_or_else(|| "/bin/sh".to_string());

        // Phase 1: Create the detached container
        let mut docker_run = std::process::Command::new("docker");
        docker_run
            .arg("run")
            .arg("-d")
            .arg("--init")
            .arg("--name")
            .arg(&container_name);

        for env_var in &config.env_vars {
            docker_run
                .arg("-e")
                .arg(format!("{}={}", env_var.key, env_var.value));
        }

        for vol in &config.volumes {
            let mut mount = format!("{}:{}", vol.host_path, vol.container_path);
            if vol.read_only {
                mount.push_str(":ro");
            }
            docker_run.arg("-v").arg(mount);
        }

        if let Some(ref workdir) = config.working_directory {
            docker_run.arg("-w").arg(workdir);
        }

        docker_run
            .arg(&config.image)
            .arg("tail")
            .arg("-f")
            .arg("/dev/null");

        let output = docker_run
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .context("Failed to run docker run")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!("docker run failed: {}", stderr.trim()));
        }

        info!("Docker container created: {container_name}");

        // Phase 2: Spawn daemon with TERMIHUB_COMMAND=docker
        let socket_path =
            crate::daemon::process::socket_dir().join(format!("session-{session_id}.sock"));

        let env_json = serde_json::to_string(&config.env)?;

        let command_args = vec![
            "exec".to_string(),
            "-it".to_string(),
            container_name.clone(),
            shell,
        ];
        let command_args_json = serde_json::to_string(&command_args)?;

        let agent_exe = std::env::current_exe()?;

        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_COMMAND", "docker")
            .env("TERMIHUB_COMMAND_ARGS", &command_args_json)
            .env("TERMIHUB_COLS", config.cols.to_string())
            .env("TERMIHUB_ROWS", config.rows.to_string())
            .env("TERMIHUB_ENV", &env_json)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon for Docker session: {e}"))?;

        DaemonClient::wait_for_socket(&socket_path).await?;
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        Ok(Self {
            container_name,
            remove_on_exit: config.remove_on_exit,
            client,
        })
    }

    /// Reconnect to an existing Docker session after agent restart.
    ///
    /// Checks if the container is still running via `docker inspect`,
    /// spawns a fresh daemon with `docker exec`, and connects.
    pub async fn reconnect(
        session_id: String,
        container_name: String,
        remove_on_exit: bool,
        shell: String,
        cols: u16,
        rows: u16,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        // Check if container is still running
        let status = std::process::Command::new("docker")
            .args(["inspect", "-f", "{{.State.Running}}", &container_name])
            .output()
            .context("Failed to run docker inspect")?;

        let running = String::from_utf8_lossy(&status.stdout)
            .trim()
            .eq_ignore_ascii_case("true");

        if !running {
            if remove_on_exit {
                let _ = std::process::Command::new("docker")
                    .args(["rm", "-f", &container_name])
                    .output();
            }
            return Err(anyhow::anyhow!(
                "Docker container {} is no longer running",
                container_name
            ));
        }

        info!("Docker container {container_name} still running, spawning new daemon");

        let socket_path =
            crate::daemon::process::socket_dir().join(format!("session-{session_id}.sock"));

        // Remove stale socket if it exists from a previous daemon
        let _ = std::fs::remove_file(&socket_path);

        let command_args = vec![
            "exec".to_string(),
            "-it".to_string(),
            container_name.clone(),
            shell,
        ];
        let command_args_json = serde_json::to_string(&command_args)?;

        let agent_exe = std::env::current_exe()?;

        let _child = std::process::Command::new(&agent_exe)
            .arg("--daemon")
            .arg(&session_id)
            .env("TERMIHUB_SOCKET_PATH", &socket_path)
            .env("TERMIHUB_COMMAND", "docker")
            .env("TERMIHUB_COMMAND_ARGS", &command_args_json)
            .env("TERMIHUB_COLS", cols.to_string())
            .env("TERMIHUB_ROWS", rows.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn daemon for Docker recovery: {e}"))?;

        DaemonClient::wait_for_socket(&socket_path).await?;
        let client = DaemonClient::connect(session_id, socket_path, notification_tx).await?;

        Ok(Self {
            container_name,
            remove_on_exit,
            client,
        })
    }

    /// Write raw input to the container shell via the daemon.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), anyhow::Error> {
        self.client.write_input(data).await
    }

    /// Attach to the session by reconnecting to the daemon socket.
    pub async fn attach(&mut self) -> Result<(), anyhow::Error> {
        self.client.attach().await
    }

    /// Detach from the session without killing the daemon or container.
    pub async fn detach(&mut self) {
        self.client.detach().await;
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), anyhow::Error> {
        self.client.resize(cols, rows).await
    }

    /// Close the Docker session: kill daemon, stop container, optionally remove it.
    pub async fn close(&mut self) {
        self.client.close().await;

        info!("Stopping Docker container: {}", self.container_name);
        let _ = std::process::Command::new("docker")
            .args(["stop", "-t", "5", &self.container_name])
            .output();

        if self.remove_on_exit {
            info!("Removing Docker container: {}", self.container_name);
            let _ = std::process::Command::new("docker")
                .args(["rm", "-f", &self.container_name])
                .output();
        }
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

    /// Get the Docker container name.
    pub fn container_name(&self) -> &str {
        &self.container_name
    }

    /// Whether the container should be removed on session close.
    pub fn remove_on_exit(&self) -> bool {
        self.remove_on_exit
    }
}
