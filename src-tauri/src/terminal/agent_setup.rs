/// Remote agent setup: upload and install the agent binary on a remote host.
///
/// Orchestrates the setup flow:
/// 1. Create a visible SSH terminal session for the user to observe.
/// 2. Open a separate blocking SSH connection for SFTP upload + arch detection.
/// 3. Upload a self-contained POSIX setup script and execute it in the terminal.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{error, info};

use crate::session::manager::SessionManager;
use crate::terminal::backend::RemoteAgentConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{
    detect_binary_arch, detect_remote_info, expected_arch_for_uname, upload_bytes_via_sftp,
    upload_via_sftp,
};
use crate::utils::ssh_auth::connect_and_authenticate;

/// Default install path for the agent binary on the remote host.
///
/// Uses `~/.local/bin` so setup works without privilege escalation on any
/// system (matching VS Code / JetBrains conventions).
const DEFAULT_REMOTE_PATH: &str = "~/.local/bin/termihub-agent";

/// Temporary upload path for the agent binary (writable without sudo).
const TEMP_UPLOAD_PATH: &str = "/tmp/termihub-agent-upload";

/// Temporary upload path for the setup script.
const TEMP_SCRIPT_PATH: &str = "/tmp/termihub-agent-setup.sh";

/// Delay (ms) before injecting commands to let the shell initialize.
const SHELL_INIT_DELAY_MS: u64 = 2000;

/// Configuration for agent setup provided by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupConfig {
    /// Local path to the pre-built agent binary.
    pub binary_path: String,
    /// Remote install path (defaults to ~/.local/bin/termihub-agent).
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
    session_manager: &SessionManager,
) -> Result<AgentSetupResult, TerminalError> {
    // Validate that the local binary exists
    let binary_path = &setup_config.binary_path;
    if !std::path::Path::new(binary_path).is_file() {
        return Err(TerminalError::SpawnFailed(format!(
            "Agent binary not found: {}",
            binary_path
        )));
    }

    // Create the visible SSH terminal session via the new SessionManager.
    // We're in a spawn_blocking context, so use block_on for the async call.
    let ssh_config = agent_config.to_ssh_config();
    let settings = serde_json::to_value(&ssh_config)
        .map_err(|e| TerminalError::SpawnFailed(format!("Failed to serialize SSH config: {e}")))?;

    let handle = tokio::runtime::Handle::current();
    let session_id = handle.block_on(session_manager.create_connection(
        "ssh",
        settings,
        None,
        app_handle.clone(),
    ))?;

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
    let sm = session_manager.clone();

    // Spawn background thread to do SFTP upload + command injection
    std::thread::spawn(move || {
        run_setup_background(
            &agent_id_owned,
            &session_id_clone,
            &ssh_config_clone,
            &setup_config_clone,
            &app_handle_clone,
            &sm,
        );
    });

    Ok(AgentSetupResult { session_id })
}

/// Background thread: detect arch, upload binary + script, execute script.
fn run_setup_background(
    agent_id: &str,
    session_id: &str,
    ssh_config: &crate::terminal::backend::SshConfig,
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    session_manager: &SessionManager,
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
            inject_error_inline(session_manager, session_id, "SFTP connection failed");
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

            // Validate the local binary matches the remote architecture
            match detect_binary_arch(&setup_config.binary_path) {
                Ok(binary_arch) => {
                    if let Some(expected) = expected_arch_for_uname(&arch) {
                        if binary_arch != expected {
                            let msg = format!(
                                "Architecture mismatch: binary is {} but remote host is {} ({}).\n\
                                 Please select the correct binary for the target platform.",
                                binary_arch, expected, arch
                            );
                            error!("Agent setup: {}", msg);
                            emit_progress(app_handle, agent_id, "error", &msg);
                            inject_error_script(&sftp_session, session_manager, session_id, &msg);
                            return;
                        }
                        info!("Agent setup: binary arch {} matches remote", binary_arch);
                    }
                }
                Err(e) => {
                    let msg = match &e {
                        TerminalError::SpawnFailed(inner) => inner.clone(),
                        other => format!("{}", other),
                    };
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_error_script(&sftp_session, session_manager, session_id, &msg);
                    return;
                }
            }
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
            inject_error_script(
                &sftp_session,
                session_manager,
                session_id,
                &format!("Upload failed: {}", e),
            );
            return;
        }
    }

    // Generate and upload the setup script
    let remote_path = setup_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);
    let script = generate_setup_script(remote_path, setup_config.install_service);

    emit_progress(app_handle, agent_id, "script", "Uploading setup script...");
    match upload_bytes_via_sftp(&sftp_session, script.as_bytes(), TEMP_SCRIPT_PATH) {
        Ok(bytes) => {
            info!("Agent setup: uploaded setup script ({} bytes)", bytes);
        }
        Err(e) => {
            error!("Agent setup: script upload failed: {}", e);
            emit_progress(
                app_handle,
                agent_id,
                "error",
                &format!("Script upload failed: {}", e),
            );
            inject_error_script(
                &sftp_session,
                session_manager,
                session_id,
                &format!("Script upload failed: {}", e),
            );
            return;
        }
    }

    // Execute the setup script in the visible terminal
    emit_progress(app_handle, agent_id, "install", "Running setup script...");
    let exec_command = format!("sh {}; rm -f {}\n", TEMP_SCRIPT_PATH, TEMP_SCRIPT_PATH);
    inject_commands(session_manager, session_id, &exec_command);

    emit_progress(
        app_handle,
        agent_id,
        "done",
        "Setup script started in terminal",
    );
    info!("Agent setup: script started for agent {}", agent_id);
}

/// Generate a self-contained POSIX shell script for agent installation.
///
/// The script handles privilege escalation detection, directory creation,
/// binary installation, verification, and optional systemd service setup.
/// It uses `set -e` for error handling and provides verbose emoji output.
pub fn generate_setup_script(remote_path: &str, install_service: bool) -> String {
    let service_flag = if install_service { "true" } else { "false" };
    SETUP_SCRIPT_TEMPLATE
        .replace("__INSTALL_PATH__", remote_path)
        .replace("__INSTALL_SERVICE__", service_flag)
}

/// Template for the agent setup script.
///
/// Placeholders `__INSTALL_PATH__` and `__INSTALL_SERVICE__` are replaced
/// at runtime by [`generate_setup_script`].
const SETUP_SCRIPT_TEMPLATE: &str = r#"#!/bin/sh
set -e

BINARY_SRC="/tmp/termihub-agent-upload"
INSTALL_PATH="__INSTALL_PATH__"
INSTALL_SERVICE=__INSTALL_SERVICE__

# --- Helpers ---
fail() {
    printf '\033[31m\342\235\214 Error: %s\033[0m\n' "$1"
    echo ""
    printf '\033[31m\342\235\214 === Setup Failed ===\033[0m\n'
    exit 1
}

echo ""
echo "\360\237\232\200 === termiHub Agent Setup ==="
echo ""

# --- Step 1: Verify uploaded binary ---
printf "\360\237\224\215 Checking uploaded binary... "
if [ -f "$BINARY_SRC" ]; then
    echo "found at $BINARY_SRC"
else
    echo ""
    fail "Agent binary not found at $BINARY_SRC. The upload may have failed."
fi

# --- Step 2: Resolve install path ---
case "$INSTALL_PATH" in
    "~/"*) INSTALL_PATH="$HOME/${INSTALL_PATH#\~/}" ;;
esac
echo "\360\237\223\201 Install path: $INSTALL_PATH"

# --- Step 3: Check permissions ---
SUDO=""
TARGET_DIR=$(dirname "$INSTALL_PATH")
printf "\360\237\224\221 Checking permissions for $TARGET_DIR... "
if [ -d "$TARGET_DIR" ] && [ -w "$TARGET_DIR" ]; then
    echo "writable \342\234\223"
else
    # Walk up to the first existing ancestor to check writability
    CHECK_DIR="$TARGET_DIR"
    while [ -n "$CHECK_DIR" ] && [ "$CHECK_DIR" != "/" ] && [ ! -d "$CHECK_DIR" ]; do
        CHECK_DIR=$(dirname "$CHECK_DIR")
    done
    if [ -w "$CHECK_DIR" ]; then
        echo "writable \342\234\223"
    elif [ "$(id -u)" -eq 0 ]; then
        echo "running as root \342\234\223"
    elif command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        echo "using sudo \342\234\223"
    else
        echo "no write access"
        fail "Cannot create $TARGET_DIR (permission denied, no sudo available).\n  \360\237\222\241 Ask the server admin to create the directory, or choose a writable path."
    fi
fi

# --- Step 4: Create directory ---
if [ ! -d "$TARGET_DIR" ]; then
    echo "\360\237\223\202 Creating directory $TARGET_DIR..."
    $SUDO mkdir -p "$TARGET_DIR"
fi

# --- Step 5: Install binary ---
echo "\360\237\223\246 Moving agent binary to $INSTALL_PATH..."
$SUDO mv "$BINARY_SRC" "$INSTALL_PATH"
$SUDO chmod +x "$INSTALL_PATH"

# --- Step 6: Verify ---
printf "\342\234\205 Verifying installation... "
"$INSTALL_PATH" --version

# --- Step 7: Optional systemd service ---
if [ "$INSTALL_SERVICE" = true ]; then
    echo "\342\232\231\357\270\217  Installing systemd service..."
    printf '[Unit]\nDescription=termiHub Agent\nAfter=network.target\n\n[Service]\nExecStart=%s --listen 127.0.0.1:7685\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n' "$INSTALL_PATH" \
        | $SUDO tee /etc/systemd/system/termihub-agent.service > /dev/null
    $SUDO systemctl daemon-reload
    printf "  \342\234\223 Service registered\n"
    $SUDO systemctl enable termihub-agent
    printf "  \342\234\223 Service enabled\n"
    $SUDO systemctl start termihub-agent
    printf "  \342\234\223 Service started\n"
fi

echo ""
echo "\360\237\216\211 === Setup Complete ==="
echo ""
"#;

/// Inject commands into the visible terminal session via the SessionManager.
fn inject_commands(session_manager: &SessionManager, session_id: &str, commands: &str) {
    if let Err(e) = session_manager.send_input(session_id, commands.as_bytes()) {
        error!("Agent setup: failed to inject commands: {}", e);
    }
}

/// Upload a small error script via SFTP and execute it in the terminal.
///
/// This avoids the shell echoing raw `printf` commands.  The user only
/// sees the `sh /tmp/…` invocation (same pattern as the normal setup
/// flow) followed by the styled error output.
fn inject_error_script(
    sftp_session: &ssh2::Session,
    session_manager: &SessionManager,
    session_id: &str,
    message: &str,
) {
    let script = generate_error_script(message);
    match upload_bytes_via_sftp(sftp_session, script.as_bytes(), TEMP_SCRIPT_PATH) {
        Ok(_) => {
            let cmd = format!("sh {}; rm -f {}\n", TEMP_SCRIPT_PATH, TEMP_SCRIPT_PATH);
            inject_commands(session_manager, session_id, &cmd);
        }
        Err(e) => {
            // Fallback: inject commands directly if upload fails
            error!("Agent setup: error script upload failed: {}", e);
            inject_error_inline(session_manager, session_id, message);
        }
    }
}

/// Inject a red error banner directly into the terminal (fallback).
///
/// Used only when SFTP is unavailable (e.g. connection failed).
fn inject_error_inline(session_manager: &SessionManager, session_id: &str, message: &str) {
    let safe_msg = message.replace('\'', "'\\''");
    let cmd = format!(
        "printf '\\033[31m\\342\\235\\214 Error: %s\\033[0m\\n' '{}'\n\
         echo ''\n\
         printf '\\033[31m\\342\\235\\214 === Setup Failed ===\\033[0m\\n'\n",
        safe_msg
    );
    inject_commands(session_manager, session_id, &cmd);
}

/// Generate a small POSIX error script matching the setup script's `fail()` style.
fn generate_error_script(message: &str) -> String {
    let safe_msg = message.replace('\'', "'\\''");
    format!(
        "#!/bin/sh\n\
         printf '\\033[31m\\342\\235\\214 Error: %s\\033[0m\\n' '{}'\n\
         echo ''\n\
         printf '\\033[31m\\342\\235\\214 === Setup Failed ===\\033[0m\\n'\n",
        safe_msg
    )
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
    fn generate_setup_script_basic() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", false);
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("set -e"));
        assert!(script.contains("INSTALL_PATH=\"/usr/local/bin/termihub-agent\""));
        assert!(script.contains("INSTALL_SERVICE=false"));
        assert!(script.contains("--version"));
        assert!(script.contains("=== termiHub Agent Setup ==="));
        assert!(script.contains("=== Setup Complete ==="));
        assert!(script.contains("=== Setup Failed ==="));
        assert!(script.contains("INSTALL_SERVICE=false"));
    }

    #[test]
    fn generate_setup_script_with_service() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", true);
        assert!(script.contains("INSTALL_SERVICE=true"));
        assert!(script.contains("systemd service"));
        assert!(script.contains("$SUDO tee /etc/systemd/system/termihub-agent.service"));
        assert!(script.contains("$SUDO systemctl daemon-reload"));
        assert!(script.contains("$SUDO systemctl enable termihub-agent"));
        assert!(script.contains("$SUDO systemctl start termihub-agent"));
        assert!(script.contains("ExecStart=%s --listen 127.0.0.1:7685"));
    }

    #[test]
    fn generate_setup_script_custom_path() {
        let script = generate_setup_script("/opt/termihub/agent", false);
        assert!(script.contains("INSTALL_PATH=\"/opt/termihub/agent\""));
        assert!(script.contains("$SUDO mv"));
        assert!(script.contains("$SUDO chmod +x"));
    }

    #[test]
    fn generate_setup_script_sudo_detection() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", false);
        assert!(script.contains("id -u"));
        assert!(script.contains("command -v sudo"));
        assert!(script.contains("SUDO=\"sudo\""));
        assert!(script.contains("$SUDO mv"));
        assert!(script.contains("$SUDO chmod"));
    }

    #[test]
    fn generate_setup_script_tilde_expansion() {
        let script = generate_setup_script("~/.local/bin/termihub-agent", false);
        assert!(script.contains("INSTALL_PATH=\"~/.local/bin/termihub-agent\""));
        assert!(script.contains("$HOME/${INSTALL_PATH#\\~/}"));
    }

    #[test]
    fn generate_setup_script_walks_up_to_existing_ancestor() {
        let script = generate_setup_script("~/.local/bin/termihub-agent", false);
        assert!(script.contains("CHECK_DIR=$(dirname \"$CHECK_DIR\")"));
        assert!(script.contains("while"));
        assert!(!script.contains("PARENT_DIR=$(dirname \"$TARGET_DIR\")"));
    }

    #[test]
    fn generate_setup_script_no_bashisms() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", true);
        assert!(!script.contains("[["));
        assert!(!script.contains("local "));
        assert!(!script.contains("declare "));
        assert!(!script.contains("#!/bin/bash"));
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
