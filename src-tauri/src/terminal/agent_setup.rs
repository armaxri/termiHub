/// Remote agent setup: upload and install the agent binary on a remote host.
///
/// Orchestrates the setup flow:
/// 1. Create a visible SSH terminal session for the user to observe.
/// 2. Open a separate blocking SSH connection for SFTP upload + arch detection.
/// 3. Upload a self-contained POSIX setup script and execute it in the terminal.
use std::io::Read;
use std::sync::Arc;

use std::fmt;

use serde::{Deserialize, Serialize};
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use tracing::{error, info};

use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};
use crate::terminal::manager::TerminalManager;
use crate::utils::errors::TerminalError;
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

/// Background thread: detect arch, upload binary + script, execute script.
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
                "echo '\\x1b[31m=== Agent Setup Error: SFTP connection failed ===\\x1b[0m'\n",
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
                            inject_commands(
                                sessions,
                                session_id,
                                &format!(
                                    "echo '\\x1b[31m=== Agent Setup Error: {} ===\\x1b[0m'\n",
                                    msg
                                ),
                            );
                            return;
                        }
                        info!("Agent setup: binary arch {} matches remote", binary_arch);
                    }
                }
                Err(e) => {
                    let msg = format!("{}", e);
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_commands(
                        sessions,
                        session_id,
                        &format!(
                            "echo '\\x1b[31m=== Agent Setup Error: {} ===\\x1b[0m'\n",
                            msg
                        ),
                    );
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
            inject_commands(
                sessions,
                session_id,
                &format!(
                    "echo '\\x1b[31m=== Agent Setup Error: Script upload failed: {} ===\\x1b[0m'\n",
                    e
                ),
            );
            return;
        }
    }

    // Execute the setup script in the visible terminal
    emit_progress(app_handle, agent_id, "install", "Running setup script...");
    let exec_command = format!("sh {}; rm -f {}\n", TEMP_SCRIPT_PATH, TEMP_SCRIPT_PATH);
    inject_commands(sessions, session_id, &exec_command);

    emit_progress(
        app_handle,
        agent_id,
        "done",
        "Setup script started in terminal",
    );
    info!("Agent setup: script started for agent {}", agent_id);
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

/// CPU architecture of an ELF binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElfArch {
    X86,
    X86_64,
    Arm,
    Aarch64,
    Unknown(u16),
}

impl fmt::Display for ElfArch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ElfArch::X86 => write!(f, "x86 (i386)"),
            ElfArch::X86_64 => write!(f, "x86_64"),
            ElfArch::Arm => write!(f, "arm"),
            ElfArch::Aarch64 => write!(f, "aarch64"),
            ElfArch::Unknown(id) => write!(f, "unknown (e_machine=0x{:04x})", id),
        }
    }
}

/// ELF magic bytes: `\x7fELF`
const ELF_MAGIC: [u8; 4] = [0x7f, b'E', b'L', b'F'];

/// Read the ELF header of a local binary and return its architecture.
fn detect_binary_arch(path: &str) -> Result<ElfArch, TerminalError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| TerminalError::SpawnFailed(format!("open binary failed: {}", e)))?;

    // We need 20 bytes: 16-byte ELF ident + 2-byte e_type + 2-byte e_machine
    let mut header = [0u8; 20];
    file.read_exact(&mut header)
        .map_err(|e| TerminalError::SpawnFailed(format!("read binary header failed: {}", e)))?;

    if header[0..4] != ELF_MAGIC {
        return Err(TerminalError::SpawnFailed(
            "Binary is not a Linux ELF executable (wrong magic bytes). \
             Make sure you selected a Linux binary, not a macOS or Windows one."
                .to_string(),
        ));
    }

    // ELF ident byte 5: data encoding (1 = little-endian, 2 = big-endian)
    let little_endian = header[5] == 1;

    // e_machine is at offset 18 (2 bytes)
    let e_machine = if little_endian {
        u16::from_le_bytes([header[18], header[19]])
    } else {
        u16::from_be_bytes([header[18], header[19]])
    };

    Ok(match e_machine {
        0x03 => ElfArch::X86,
        0x3E => ElfArch::X86_64,
        0x28 => ElfArch::Arm,
        0xB7 => ElfArch::Aarch64,
        other => ElfArch::Unknown(other),
    })
}

/// Map `uname -m` output to the expected ELF architecture.
fn expected_arch_for_uname(uname_arch: &str) -> Option<ElfArch> {
    match uname_arch {
        "x86_64" | "amd64" => Some(ElfArch::X86_64),
        "aarch64" | "arm64" => Some(ElfArch::Aarch64),
        "armv7l" | "armv6l" | "armhf" => Some(ElfArch::Arm),
        "i686" | "i386" | "i586" => Some(ElfArch::X86),
        _ => None,
    }
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

/// Upload in-memory bytes to a remote path via SFTP.
fn upload_bytes_via_sftp(
    session: &Session,
    data: &[u8],
    remote_path: &str,
) -> Result<u64, TerminalError> {
    let sftp = session
        .sftp()
        .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {}", e)))?;

    let remote = std::path::Path::new(remote_path);
    let mut remote_file = sftp
        .create(remote)
        .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

    std::io::Write::write_all(&mut remote_file, data)
        .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;

    Ok(data.len() as u64)
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
echo "\360\237\232\200 === TermiHub Agent Setup ==="
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
    printf '[Unit]\nDescription=TermiHub Agent\nAfter=network.target\n\n[Service]\nExecStart=%s --listen 127.0.0.1:7685\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n' "$INSTALL_PATH" \
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
    fn generate_setup_script_basic() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", false);
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("set -e"));
        assert!(script.contains("INSTALL_PATH=\"/usr/local/bin/termihub-agent\""));
        assert!(script.contains("INSTALL_SERVICE=false"));
        assert!(script.contains("--version"));
        assert!(script.contains("=== TermiHub Agent Setup ==="));
        assert!(script.contains("=== Setup Complete ==="));
        assert!(script.contains("=== Setup Failed ==="));
        // Service is disabled at runtime via the INSTALL_SERVICE variable
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
        // Checks directory writability, not just sudo existence
        assert!(script.contains("id -u"));
        assert!(script.contains("command -v sudo"));
        assert!(script.contains("SUDO=\"sudo\""));
        // Uses $SUDO variable, not hardcoded sudo
        assert!(script.contains("$SUDO mv"));
        assert!(script.contains("$SUDO chmod"));
    }

    #[test]
    fn generate_setup_script_tilde_expansion() {
        let script = generate_setup_script("~/.local/bin/termihub-agent", false);
        assert!(script.contains("INSTALL_PATH=\"~/.local/bin/termihub-agent\""));
        // Script expands ~ at runtime
        assert!(script.contains("$HOME/${INSTALL_PATH#\\~/}"));
    }

    #[test]
    fn generate_setup_script_walks_up_to_existing_ancestor() {
        let script = generate_setup_script("~/.local/bin/termihub-agent", false);
        // The permission check must walk up the directory tree to find the first
        // existing ancestor, not just check the immediate parent. This handles
        // cases like ~/.local/bin where ~/.local also doesn't exist yet but ~
        // is writable (e.g., minimal Docker containers).
        assert!(script.contains("CHECK_DIR=$(dirname \"$CHECK_DIR\")"));
        assert!(script.contains("while"));
        // Must NOT have the old single-parent check pattern
        assert!(!script.contains("PARENT_DIR=$(dirname \"$TARGET_DIR\")"));
    }

    #[test]
    fn generate_setup_script_no_bashisms() {
        let script = generate_setup_script("/usr/local/bin/termihub-agent", true);
        // Must not use bash-only features
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

    // --- ELF architecture detection tests ---

    /// Helper: build a minimal ELF header with the given e_machine value.
    fn make_elf_header(e_machine: u16, little_endian: bool) -> Vec<u8> {
        let mut h = vec![0u8; 20];
        // Magic
        h[0] = 0x7f;
        h[1] = b'E';
        h[2] = b'L';
        h[3] = b'F';
        // EI_CLASS: 2 = 64-bit
        h[4] = 2;
        // EI_DATA: 1 = LE, 2 = BE
        h[5] = if little_endian { 1 } else { 2 };
        // e_type at offset 16 (don't care)
        // e_machine at offset 18
        let machine_bytes = if little_endian {
            e_machine.to_le_bytes()
        } else {
            e_machine.to_be_bytes()
        };
        h[18] = machine_bytes[0];
        h[19] = machine_bytes[1];
        h
    }

    #[test]
    fn detect_binary_arch_x86_64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x3E, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86_64);
    }

    #[test]
    fn detect_binary_arch_aarch64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0xB7, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::Aarch64);
    }

    #[test]
    fn detect_binary_arch_arm32() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x28, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::Arm);
    }

    #[test]
    fn detect_binary_arch_x86() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x03, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86);
    }

    #[test]
    fn detect_binary_arch_big_endian() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x3E, false)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86_64);
    }

    #[test]
    fn detect_binary_arch_not_elf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-elf");
        // Mach-O magic (macOS binary)
        std::fs::write(&path, b"\xcf\xfa\xed\xfe0000000000000000").unwrap();
        let result = detect_binary_arch(path.to_str().unwrap());
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(err_msg.contains("not a Linux ELF executable"));
    }

    #[test]
    fn detect_binary_arch_file_too_small() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny");
        std::fs::write(&path, b"\x7fELF").unwrap();
        let result = detect_binary_arch(path.to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn detect_binary_arch_missing_file() {
        let result = detect_binary_arch("/nonexistent/path/binary");
        assert!(result.is_err());
    }

    #[test]
    fn expected_arch_for_uname_known_values() {
        assert_eq!(expected_arch_for_uname("x86_64"), Some(ElfArch::X86_64));
        assert_eq!(expected_arch_for_uname("amd64"), Some(ElfArch::X86_64));
        assert_eq!(expected_arch_for_uname("aarch64"), Some(ElfArch::Aarch64));
        assert_eq!(expected_arch_for_uname("arm64"), Some(ElfArch::Aarch64));
        assert_eq!(expected_arch_for_uname("armv7l"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("armv6l"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("armhf"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("i686"), Some(ElfArch::X86));
        assert_eq!(expected_arch_for_uname("i386"), Some(ElfArch::X86));
        assert_eq!(expected_arch_for_uname("i586"), Some(ElfArch::X86));
    }

    #[test]
    fn expected_arch_for_uname_unknown() {
        assert_eq!(expected_arch_for_uname("sparc64"), None);
        assert_eq!(expected_arch_for_uname("ppc64le"), None);
        assert_eq!(expected_arch_for_uname(""), None);
    }

    #[test]
    fn elf_arch_display() {
        assert_eq!(format!("{}", ElfArch::X86_64), "x86_64");
        assert_eq!(format!("{}", ElfArch::Aarch64), "aarch64");
        assert_eq!(format!("{}", ElfArch::Arm), "arm");
        assert_eq!(format!("{}", ElfArch::X86), "x86 (i386)");
        assert_eq!(
            format!("{}", ElfArch::Unknown(0xFF)),
            "unknown (e_machine=0x00ff)"
        );
    }
}
