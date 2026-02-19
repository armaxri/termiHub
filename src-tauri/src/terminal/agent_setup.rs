/// Remote agent setup: upload and install the agent binary on a remote host.
///
/// Orchestrates the setup flow:
/// 1. Create a visible SSH terminal session for the user to observe.
/// 2. Open a separate blocking SSH connection for SFTP upload + arch detection.
/// 3. Inject setup commands into the visible terminal.
use std::io::Read;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use tracing::{error, info};

use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};
use crate::terminal::manager::TerminalManager;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// Default install path for the agent binary on the remote host.
const DEFAULT_REMOTE_PATH: &str = "/usr/local/bin/termihub-agent";

/// Temporary upload path (writable without sudo).
const TEMP_UPLOAD_PATH: &str = "/tmp/termihub-agent-upload";

/// Delay (ms) before injecting commands to let the shell initialize.
const SHELL_INIT_DELAY_MS: u64 = 2000;

/// Configuration for agent setup provided by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupConfig {
    /// Local path to the pre-built agent binary.
    pub binary_path: String,
    /// Remote install path (defaults to /usr/local/bin/termihub-agent).
    pub remote_path: Option<String>,
    /// Whether to install a systemd service.
    pub install_service: bool,
}

/// Progress event emitted during agent setup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupProgress {
    pub agent_id: String,
    pub step: String,
    pub message: String,
}

/// Result returned to the frontend after initiating setup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupResult {
    pub session_id: String,
}

/// Start the remote agent setup flow.
///
/// Creates a visible SSH terminal and spawns a background thread that
/// uploads the agent binary via SFTP and injects setup commands.
pub fn setup_remote_agent(
    agent_id: &str,
    agent_config: &RemoteAgentConfig,
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    terminal_manager: &TerminalManager,
) -> Result<AgentSetupResult, TerminalError> {
    // Validate that the local binary exists
    let binary_path = &setup_config.binary_path;
    if !std::path::Path::new(binary_path).is_file() {
        return Err(TerminalError::SpawnFailed(format!(
            "Agent binary not found: {}",
            binary_path
        )));
    }

    // Create the visible SSH terminal session
    let ssh_config = agent_config.to_ssh_config();
    let session_id = terminal_manager.create_session(
        ConnectionConfig::Ssh(ssh_config.clone()),
        app_handle.clone(),
        None,
    )?;

    info!(
        "Agent setup: created SSH terminal session {} for agent {}",
        session_id, agent_id
    );

    // Clone values for the background thread
    let agent_id_owned = agent_id.to_string();
    let session_id_clone = session_id.clone();
    let ssh_config_clone = ssh_config;
    let setup_config_clone = setup_config.clone();
    let app_handle_clone = app_handle.clone();
    let tm = terminal_manager.sessions_arc();

    // Spawn background thread to do SFTP upload + command injection
    std::thread::spawn(move || {
        run_setup_background(
            &agent_id_owned,
            &session_id_clone,
            &ssh_config_clone,
            &setup_config_clone,
            &app_handle_clone,
            &tm,
        );
    });

    Ok(AgentSetupResult { session_id })
}

/// Background thread: detect arch, upload binary, inject commands.
fn run_setup_background(
    agent_id: &str,
    session_id: &str,
    ssh_config: &crate::terminal::backend::SshConfig,
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    sessions: &Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, crate::terminal::backend::TerminalSession>,
        >,
    >,
) {
    // Wait for the shell to initialize
    std::thread::sleep(std::time::Duration::from_millis(SHELL_INIT_DELAY_MS));

    emit_progress(
        app_handle,
        agent_id,
        "connect",
        "Opening SFTP connection...",
    );

    // Open a separate blocking SSH connection for SFTP
    let sftp_session = match connect_and_authenticate(ssh_config) {
        Ok(s) => {
            s.set_blocking(true);
            s
        }
        Err(e) => {
            error!("Agent setup: SFTP connection failed: {}", e);
            emit_progress(
                app_handle,
                agent_id,
                "error",
                &format!("SFTP connection failed: {}", e),
            );
            inject_commands(
                sessions,
                session_id,
                &format!(
                    "echo '\\x1b[31m=== Agent Setup Error: SFTP connection failed ===\\x1b[0m'\n"
                ),
            );
            return;
        }
    };

    // Detect remote OS and architecture
    emit_progress(
        app_handle,
        agent_id,
        "detect",
        "Detecting remote architecture...",
    );
    match detect_remote_info(&sftp_session) {
        Ok((os, arch)) => {
            info!("Agent setup: remote system: {} {}", os, arch);
            emit_progress(
                app_handle,
                agent_id,
                "detect",
                &format!("Detected: {} {}", os, arch),
            );
        }
        Err(e) => {
            error!("Agent setup: arch detection failed: {}", e);
            emit_progress(
                app_handle,
                agent_id,
                "detect",
                &format!("Architecture detection failed (continuing): {}", e),
            );
        }
    }

    // Upload binary via SFTP
    emit_progress(app_handle, agent_id, "upload", "Uploading agent binary...");
    match upload_via_sftp(&sftp_session, &setup_config.binary_path, TEMP_UPLOAD_PATH) {
        Ok(bytes) => {
            info!("Agent setup: uploaded {} bytes", bytes);
            emit_progress(
                app_handle,
                agent_id,
                "upload",
                &format!("Uploaded {} bytes", bytes),
            );
        }
        Err(e) => {
            error!("Agent setup: upload failed: {}", e);
            emit_progress(
                app_handle,
                agent_id,
                "error",
                &format!("Upload failed: {}", e),
            );
            inject_commands(
                sessions,
                session_id,
                &format!(
                    "echo '\\x1b[31m=== Agent Setup Error: Upload failed: {} ===\\x1b[0m'\n",
                    e
                ),
            );
            return;
        }
    }

    // Generate and inject setup commands into the visible terminal
    let remote_path = setup_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);
    let commands = generate_setup_commands(remote_path, setup_config.install_service);

    emit_progress(app_handle, agent_id, "install", "Running setup commands...");
    inject_commands(sessions, session_id, &commands);

    emit_progress(
        app_handle,
        agent_id,
        "done",
        "Setup commands injected into terminal",
    );
    info!("Agent setup: commands injected for agent {}", agent_id);
}

/// Detect the remote OS and architecture via exec channel.
fn detect_remote_info(session: &Session) -> Result<(String, String), TerminalError> {
    let os = run_remote_command(session, "uname -s")?;
    let arch = run_remote_command(session, "uname -m")?;
    Ok((os, arch))
}

/// Run a single command on the remote host and return trimmed stdout.
fn run_remote_command(session: &Session, command: &str) -> Result<String, TerminalError> {
    let mut channel = session
        .channel_session()
        .map_err(|e| TerminalError::SshError(format!("channel open failed: {}", e)))?;
    channel
        .exec(command)
        .map_err(|e| TerminalError::SshError(format!("exec failed: {}", e)))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;
    channel.wait_close().ok();

    Ok(output.trim().to_string())
}

/// Upload a local file to a remote path via SFTP.
fn upload_via_sftp(
    session: &Session,
    local_path: &str,
    remote_path: &str,
) -> Result<u64, TerminalError> {
    let sftp = session
        .sftp()
        .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {}", e)))?;

    let remote = std::path::Path::new(remote_path);
    let mut remote_file = sftp
        .create(remote)
        .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

    let mut local_file = std::fs::File::open(local_path)
        .map_err(|e| TerminalError::SpawnFailed(format!("open local file failed: {}", e)))?;

    let mut buf = [0u8; 32768];
    let mut total: u64 = 0;
    loop {
        let n = local_file
            .read(&mut buf)
            .map_err(|e| TerminalError::SpawnFailed(format!("read failed: {}", e)))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut remote_file, &buf[..n])
            .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;
        total += n as u64;
    }

    Ok(total)
}

/// Generate shell commands for the visible terminal.
pub fn generate_setup_commands(remote_path: &str, install_service: bool) -> String {
    let mut cmds = String::new();

    cmds.push_str("echo '=== TermiHub Agent Setup ==='\n");
    cmds.push_str(&format!(
        "echo 'Moving agent binary to {}...'\n",
        remote_path
    ));
    cmds.push_str(&format!("sudo mv {} {}\n", TEMP_UPLOAD_PATH, remote_path));
    cmds.push_str(&format!("sudo chmod +x {}\n", remote_path));
    cmds.push_str("echo 'Verifying installation...'\n");
    cmds.push_str(&format!("{} --version\n", remote_path));

    if install_service {
        cmds.push_str("echo 'Installing systemd service...'\n");
        cmds.push_str(&generate_systemd_commands(remote_path));
    }

    cmds.push_str("echo '=== Setup Complete ==='\n");
    cmds
}

/// Generate systemd service installation commands.
fn generate_systemd_commands(remote_path: &str) -> String {
    let service = format!(
        "[Unit]\n\
         Description=TermiHub Agent\n\
         After=network.target\n\
         \n\
         [Service]\n\
         ExecStart={} --listen 127.0.0.1:7685\n\
         Restart=on-failure\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target",
        remote_path
    );

    let mut cmds = String::new();
    cmds.push_str(&format!(
        "sudo tee /etc/systemd/system/termihub-agent.service > /dev/null << 'SERVICEEOF'\n{}\nSERVICEEOF\n",
        service
    ));
    cmds.push_str("sudo systemctl daemon-reload\n");
    cmds.push_str("sudo systemctl enable termihub-agent\n");
    cmds.push_str("sudo systemctl start termihub-agent\n");
    cmds
}

/// Inject commands into the visible terminal session.
fn inject_commands(
    sessions: &Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, crate::terminal::backend::TerminalSession>,
        >,
    >,
    session_id: &str,
    commands: &str,
) {
    let sessions_guard = match sessions.lock() {
        Ok(g) => g,
        Err(e) => {
            error!("Agent setup: failed to lock sessions: {}", e);
            return;
        }
    };
    if let Some(session) = sessions_guard.get(session_id) {
        if let Err(e) = session.backend.write_input(commands.as_bytes()) {
            error!("Agent setup: failed to inject commands: {}", e);
        }
    } else {
        error!(
            "Agent setup: terminal session {} not found for command injection",
            session_id
        );
    }
}

/// Emit a setup progress event to the frontend.
fn emit_progress(app_handle: &AppHandle, agent_id: &str, step: &str, message: &str) {
    let event = AgentSetupProgress {
        agent_id: agent_id.to_string(),
        step: step.to_string(),
        message: message.to_string(),
    };
    if let Err(e) = app_handle.emit("agent-setup-progress", &event) {
        error!("Agent setup: failed to emit progress: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_setup_commands_basic() {
        let cmds = generate_setup_commands("/usr/local/bin/termihub-agent", false);
        assert!(cmds.contains("sudo mv /tmp/termihub-agent-upload /usr/local/bin/termihub-agent"));
        assert!(cmds.contains("sudo chmod +x /usr/local/bin/termihub-agent"));
        assert!(cmds.contains("/usr/local/bin/termihub-agent --version"));
        assert!(cmds.contains("=== TermiHub Agent Setup ==="));
        assert!(cmds.contains("=== Setup Complete ==="));
        assert!(!cmds.contains("systemd"));
    }

    #[test]
    fn generate_setup_commands_with_service() {
        let cmds = generate_setup_commands("/usr/local/bin/termihub-agent", true);
        assert!(cmds.contains("systemd"));
        assert!(cmds.contains("sudo tee /etc/systemd/system/termihub-agent.service"));
        assert!(cmds.contains("sudo systemctl daemon-reload"));
        assert!(cmds.contains("sudo systemctl enable termihub-agent"));
        assert!(cmds.contains("sudo systemctl start termihub-agent"));
        assert!(cmds.contains("ExecStart=/usr/local/bin/termihub-agent --listen 127.0.0.1:7685"));
    }

    #[test]
    fn generate_setup_commands_custom_path() {
        let cmds = generate_setup_commands("/opt/termihub/agent", false);
        assert!(cmds.contains("sudo mv /tmp/termihub-agent-upload /opt/termihub/agent"));
        assert!(cmds.contains("sudo chmod +x /opt/termihub/agent"));
        assert!(cmds.contains("/opt/termihub/agent --version"));
    }

    #[test]
    fn generate_setup_commands_custom_path_with_service() {
        let cmds = generate_setup_commands("/opt/termihub/agent", true);
        assert!(cmds.contains("ExecStart=/opt/termihub/agent --listen 127.0.0.1:7685"));
    }

    #[test]
    fn agent_setup_config_serde_round_trip() {
        let config = AgentSetupConfig {
            binary_path: "/home/user/termihub-agent".to_string(),
            remote_path: Some("/opt/agent".to_string()),
            install_service: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: AgentSetupConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.binary_path, "/home/user/termihub-agent");
        assert_eq!(deserialized.remote_path, Some("/opt/agent".to_string()));
        assert!(deserialized.install_service);
    }

    #[test]
    fn agent_setup_config_serde_defaults() {
        let json = r#"{"binaryPath": "/tmp/agent", "installService": false}"#;
        let config: AgentSetupConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.binary_path, "/tmp/agent");
        assert!(config.remote_path.is_none());
        assert!(!config.install_service);
    }

    #[test]
    fn agent_setup_result_serde() {
        let result = AgentSetupResult {
            session_id: "sess-123".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("sessionId"));
        assert!(json.contains("sess-123"));
    }
}
