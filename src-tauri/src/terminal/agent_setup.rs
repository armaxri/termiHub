/// Remote agent setup: upload and install the agent binary on a remote host.
///
/// Orchestrates the setup flow:
/// 1. Create a visible SSH terminal session for the user to observe.
/// 2. Open a separate blocking SSH connection for SFTP upload.
/// 3. Resolve the binary (GitHub download or local file).
/// 4. Upload a self-contained POSIX setup script and execute it in the terminal.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::session::manager::SessionManager;
use crate::terminal::agent_binary;
use crate::terminal::agent_cancel::bail_if_cancelled;
use crate::terminal::agent_install;
use crate::terminal::backend::RemoteAgentConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{
    detect_binary_arch, detect_remote_info, expected_arch_for_uname, remove_via_sftp,
    upload_bytes_via_sftp, upload_via_sftp,
};
use crate::utils::ssh_auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;

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

/// Source for the agent binary during setup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentBinarySource {
    /// Download from GitHub (dev-latest for dev builds, v{version} for releases).
    GithubDownload,
    /// Download a branch-specific build from GitHub (tag: agent-branch-{sanitized}).
    BranchBuild { branch: String },
    /// Use a pre-built binary from a local file path.
    LocalFile { path: String },
}

/// Configuration for agent setup provided by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupConfig {
    /// How to obtain the agent binary.
    pub binary_source: AgentBinarySource,
    /// Remote OS string from `uname -s` (e.g. `"Linux"`, `"Darwin"`).
    /// Detected before the dialog opens; used together with `remote_arch` to
    /// select the correct binary artifact.
    #[serde(default = "default_linux_os")]
    pub remote_os: String,
    /// Remote architecture string from `uname -m` (e.g. `"aarch64"`).
    /// Detected before the dialog opens; used to select the correct binary.
    pub remote_arch: String,
    /// Remote install path (defaults to ~/.local/bin/termihub-agent).
    pub remote_path: Option<String>,
    /// Whether to install a systemd service.
    pub install_service: bool,
}

fn default_linux_os() -> String {
    "Linux".to_string()
}

/// Information about the remote host's architecture, returned before the setup dialog opens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArchInfo {
    /// Raw `uname -m` output (e.g. `"aarch64"`).
    pub arch: String,
    /// Raw `uname -s` output (e.g. `"Linux"`).
    pub os: String,
    /// Artifact suffix used in binary filenames (e.g. `"linux-arm64"`), or `None` if unsupported.
    pub arch_suffix: Option<String>,
    /// Base download URL without the arch suffix (e.g. `"https://.../dev-latest/termihub-agent-"`).
    /// Append any supported arch suffix to build the full URL.
    pub download_base_url: String,
    /// Pre-computed GitHub download URL for the detected arch, or `None` if arch is unsupported.
    pub download_url: Option<String>,
    /// The git branch this desktop app was built from, if it is a feature-branch build.
    /// `None` for main/develop/release builds. Used to pre-fill the branch build option in the UI.
    pub build_branch: Option<String>,
}

/// Detect the remote host's architecture via a temporary SSH connection.
///
/// Called before the setup dialog opens so the dialog can show the detected
/// architecture and pre-select the correct download URL.
pub fn detect_agent_arch_info(config: &RemoteAgentConfig) -> Result<RemoteArchInfo, TerminalError> {
    let ssh_config = config.to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;
    let (os, arch) = detect_remote_info(&session)?;
    let arch_suffix = agent_binary::artifact_name_for_os_arch(&os, &arch).map(str::to_string);
    let version = env!("CARGO_PKG_VERSION");
    let download_base_url = agent_binary::compute_download_base_url(version);
    let download_url = arch_suffix
        .as_deref()
        .map(|s| format!("{download_base_url}{s}"));
    // Expose the build branch only for feature branches so the UI can offer a
    // pre-filled branch-build option. main/develop/unknown are excluded because
    // those builds are already served by the dev-latest or versioned release.
    let build_branch = option_env!("TERMIHUB_BUILD_BRANCH")
        .filter(|b| !b.is_empty() && *b != "unknown" && *b != "main" && *b != "develop")
        .map(str::to_string);
    Ok(RemoteArchInfo {
        arch,
        os,
        arch_suffix,
        download_base_url,
        download_url,
        build_branch,
    })
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
pub fn setup_remote_agent<F>(
    agent_id: &str,
    agent_config: &RemoteAgentConfig,
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    session_manager: &SessionManager,
    cancel: Option<CancellationToken>,
    on_complete: F,
) -> Result<AgentSetupResult, TerminalError>
where
    F: FnOnce() + Send + 'static,
{
    // Validate local file exists upfront (before spawning the terminal session)
    if let AgentBinarySource::LocalFile { path } = &setup_config.binary_source {
        if !std::path::Path::new(path).is_file() {
            return Err(TerminalError::SpawnFailed(format!(
                "Agent binary not found: {}",
                path
            )));
        }
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
        None,
        false,
        false,
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

    // Capture the tokio runtime handle for async calls from the background thread.
    let rt_handle = handle.clone();

    // Spawn the background phase to do SFTP upload + command injection.
    spawn_setup_background(move || {
        run_setup_background(
            &agent_id_owned,
            &session_id_clone,
            &ssh_config_clone,
            &setup_config_clone,
            &app_handle_clone,
            &sm,
            &rt_handle,
            cancel.as_ref(),
        );
        // Clear the cancellation registry entry now the run is done (success,
        // failure, or cancel), so the map does not accumulate stale tokens.
        on_complete();
    });

    Ok(AgentSetupResult { session_id })
}

/// Spawn the background setup phase on a thread that carries a Tokio runtime
/// context.
///
/// The background phase calls SSH/SFTP helpers (`connect_and_authenticate`,
/// `upload_via_sftp`) that run async russh code via `block_in_place` plus
/// `Handle::current().block_on(..)` internally. Both require a Tokio runtime
/// context on the calling thread. A raw `std::thread` carries none, so invoking
/// the helpers there aborts the whole process — the same crash fixed for the
/// sync commands in #828. `tauri::async_runtime::spawn_blocking` runs on the
/// Tokio blocking pool, which does carry a runtime context. See #837.
fn spawn_setup_background<F>(task: F)
where
    F: FnOnce() + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task);
}

/// Background thread: resolve binary, upload it + script, execute script.
///
/// `cancel` is checked before each network step (G10, #1242); firing it aborts
/// the setup before the next step and rolls back a partial upload so no lingering
/// background transfer or half-written binary remains.
// One extra param over the clippy limit: the cancellation token is threaded
// alongside the existing (already-at-limit) setup context. Bundling these into a
// struct would obscure the linear step sequence, so the token is passed directly.
#[allow(clippy::too_many_arguments)]
fn run_setup_background(
    agent_id: &str,
    session_id: &str,
    ssh_config: &crate::terminal::backend::SshConfig,
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    session_manager: &SessionManager,
    rt_handle: &tokio::runtime::Handle,
    cancel: Option<&CancellationToken>,
) {
    std::thread::sleep(std::time::Duration::from_millis(SHELL_INIT_DELAY_MS));

    if bail_if_cancelled(cancel).is_err() {
        report_setup_cancelled(agent_id, session_id, app_handle, session_manager, rt_handle);
        return;
    }

    inject_commands(
        session_manager,
        session_id,
        "echo 'Preparing termiHub agent setup, please wait...'\n",
        rt_handle,
    );

    emit_progress(
        app_handle,
        agent_id,
        "connect",
        "Opening SFTP connection...",
    );

    let sftp_session = match connect_and_authenticate(ssh_config) {
        Ok(s) => s,
        Err(e) => {
            error!("Agent setup: SFTP connection failed: {}", e);
            emit_progress(
                app_handle,
                agent_id,
                "error",
                &format!("SFTP connection failed: {}", e),
            );
            inject_error_inline(
                session_manager,
                session_id,
                "SFTP connection failed",
                rt_handle,
            );
            return;
        }
    };

    if bail_if_cancelled(cancel).is_err() {
        report_setup_cancelled(agent_id, session_id, app_handle, session_manager, rt_handle);
        return;
    }

    // Resolve binary path (download from GitHub or validate local file)
    let binary_path = match resolve_binary(
        setup_config,
        app_handle,
        agent_id,
        &sftp_session,
        session_manager,
        session_id,
        rt_handle,
    ) {
        Some(p) => p,
        None => return,
    };

    // Windows hosts use a different upload location and an install command
    // injected directly into the terminal (no POSIX `sh` setup script).
    let is_windows = agent_binary::is_windows_os(&setup_config.remote_os);
    let upload_path = if is_windows {
        agent_install::WINDOWS_UPLOAD_NAME
    } else {
        TEMP_UPLOAD_PATH
    };

    // Upload binary via SFTP
    if bail_if_cancelled(cancel).is_err() {
        report_setup_cancelled(agent_id, session_id, app_handle, session_manager, rt_handle);
        return;
    }
    emit_progress(app_handle, agent_id, "upload", "Uploading agent binary...");
    match upload_via_sftp(&sftp_session, &binary_path, upload_path) {
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
            inject_setup_error(
                is_windows,
                &sftp_session,
                session_manager,
                session_id,
                &format!("Upload failed: {}", e),
                rt_handle,
            );
            return;
        }
    }

    // A cancel that landed during the upload must not leave the temp binary
    // behind or inject any install commands — roll it back and stop (G10, #1242).
    if bail_if_cancelled(cancel).is_err() {
        rollback_uploaded_binary(&sftp_session, upload_path);
        report_setup_cancelled(agent_id, session_id, app_handle, session_manager, rt_handle);
        return;
    }

    if is_windows {
        run_windows_install(
            agent_id,
            session_id,
            &sftp_session,
            app_handle,
            session_manager,
            rt_handle,
        );
        return;
    }

    // POSIX: generate and upload the setup script, then run it.
    let remote_path = setup_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);
    let script = generate_setup_script(remote_path, setup_config.install_service);

    if bail_if_cancelled(cancel).is_err() {
        rollback_uploaded_binary(&sftp_session, upload_path);
        report_setup_cancelled(agent_id, session_id, app_handle, session_manager, rt_handle);
        return;
    }

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
                rt_handle,
            );
            return;
        }
    }

    emit_progress(app_handle, agent_id, "install", "Running setup script...");
    let exec_command = format!("sh {}; rm -f {}\n", TEMP_SCRIPT_PATH, TEMP_SCRIPT_PATH);
    inject_commands(session_manager, session_id, &exec_command, rt_handle);

    emit_progress(
        app_handle,
        agent_id,
        "done",
        "Setup script started in terminal",
    );
    info!("Agent setup: script started for agent {}", agent_id);
}

/// Emit a `cancelled` progress event and show the cancellation in the visible
/// terminal so the user gets feedback that the setup was aborted (G10, #1242).
fn report_setup_cancelled(
    agent_id: &str,
    session_id: &str,
    app_handle: &AppHandle,
    session_manager: &SessionManager,
    rt_handle: &tokio::runtime::Handle,
) {
    info!("Agent setup: cancelled for agent {agent_id}");
    emit_progress(app_handle, agent_id, "cancelled", "Setup cancelled");
    inject_commands(
        session_manager,
        session_id,
        "echo 'termiHub agent setup cancelled.'\n",
        rt_handle,
    );
}

/// Best-effort removal of a partially uploaded binary after a cancel (G10, #1242).
///
/// The binary is uploaded to a temp path (`/tmp/termihub-agent-upload` on POSIX,
/// the upload name on Windows) before the install step moves it into place, so
/// removing it fully rolls back the SFTP upload. Failures are logged only — the
/// setup already aborted and a lingering temp file is harmless.
fn rollback_uploaded_binary(sftp_session: &SshSession, upload_path: &str) {
    match remove_via_sftp(sftp_session, upload_path) {
        Ok(_) => info!("Agent setup: rolled back partial upload at {upload_path}"),
        Err(e) => {
            error!("Agent setup: failed to roll back partial upload at {upload_path}: {e}")
        }
    }
}

/// Install the uploaded agent on a Windows host by injecting the
/// platform-appropriate `cmd.exe`/PowerShell install + verify commands into the
/// visible terminal. No systemd service is installed (Phase 1 uses on-demand
/// `--stdio` launch).
fn run_windows_install(
    agent_id: &str,
    session_id: &str,
    sftp_session: &SshSession,
    app_handle: &AppHandle,
    session_manager: &SessionManager,
    rt_handle: &tokio::runtime::Handle,
) {
    let shell = agent_install::detect_windows_shell(sftp_session);
    let plan = agent_install::windows_install_plan(shell);
    info!("Agent setup: installing on Windows via {shell:?}");

    emit_progress(
        app_handle,
        agent_id,
        "install",
        "Installing agent binary...",
    );
    inject_commands(
        session_manager,
        session_id,
        "echo === termiHub Agent Setup ===\n",
        rt_handle,
    );
    inject_commands(
        session_manager,
        session_id,
        &format!("{}\n", plan.install_command),
        rt_handle,
    );
    inject_commands(
        session_manager,
        session_id,
        &format!("{}\n", plan.verify_command),
        rt_handle,
    );
    inject_commands(
        session_manager,
        session_id,
        "echo === Setup Complete ===\n",
        rt_handle,
    );

    emit_progress(
        app_handle,
        agent_id,
        "done",
        "Setup commands sent to terminal",
    );
    info!("Agent setup: Windows install commands sent for agent {agent_id}");
}

/// Inject a setup error into the terminal using the OS-appropriate mechanism.
///
/// POSIX hosts get the styled `sh` error script; Windows hosts get a plain
/// `echo` (the `sh`/`printf` fallbacks are not available there).
fn inject_setup_error(
    is_windows: bool,
    sftp_session: &SshSession,
    session_manager: &SessionManager,
    session_id: &str,
    message: &str,
    rt_handle: &tokio::runtime::Handle,
) {
    if is_windows {
        let safe = message.replace(['\r', '\n'], " ");
        inject_commands(
            session_manager,
            session_id,
            &format!("echo Error: {safe}\n"),
            rt_handle,
        );
    } else {
        inject_error_script(
            sftp_session,
            session_manager,
            session_id,
            message,
            rt_handle,
        );
    }
}

/// Resolve the agent binary to a local path, downloading or validating as needed.
///
/// Returns `Some(path)` on success. On error, emits progress events and injects
/// an error into the terminal, then returns `None`.
fn resolve_binary(
    setup_config: &AgentSetupConfig,
    app_handle: &AppHandle,
    agent_id: &str,
    sftp_session: &SshSession,
    session_manager: &SessionManager,
    session_id: &str,
    rt_handle: &tokio::runtime::Handle,
) -> Option<String> {
    match &setup_config.binary_source {
        AgentBinarySource::GithubDownload => {
            let version = env!("CARGO_PKG_VERSION");
            let arch_suffix = match agent_binary::artifact_name_for_os_arch(
                &setup_config.remote_os,
                &setup_config.remote_arch,
            ) {
                Some(s) => s,
                None => {
                    let msg = format!(
                        "Unsupported remote platform: {} {}",
                        setup_config.remote_os, setup_config.remote_arch
                    );
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_error_script(sftp_session, session_manager, session_id, &msg, rt_handle);
                    return None;
                }
            };

            emit_progress(
                app_handle,
                agent_id,
                "download",
                "Downloading agent binary from GitHub...",
            );

            match agent_binary::resolve_agent_binary(app_handle, version, arch_suffix, |_, _| {}) {
                Ok(path) => {
                    info!("Agent setup: resolved binary at {}", path.display());
                    emit_progress(
                        app_handle,
                        agent_id,
                        "download",
                        &format!("Binary ready ({})", arch_suffix),
                    );
                    Some(path.to_string_lossy().to_string())
                }
                Err(e) => {
                    let msg = format!("Failed to obtain agent binary: {}", e);
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_error_script(sftp_session, session_manager, session_id, &msg, rt_handle);
                    None
                }
            }
        }
        AgentBinarySource::BranchBuild { branch } => {
            let arch_suffix = match agent_binary::artifact_name_for_os_arch(
                &setup_config.remote_os,
                &setup_config.remote_arch,
            ) {
                Some(s) => s,
                None => {
                    let msg = format!(
                        "Unsupported remote platform: {} {}",
                        setup_config.remote_os, setup_config.remote_arch
                    );
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_error_script(sftp_session, session_manager, session_id, &msg, rt_handle);
                    return None;
                }
            };

            emit_progress(
                app_handle,
                agent_id,
                "download",
                &format!("Downloading branch build ({branch}) from GitHub…"),
            );

            match agent_binary::resolve_branch_build_binary(branch, arch_suffix, |_, _| {}) {
                Ok(path) => {
                    info!("Agent setup: resolved branch binary at {}", path.display());
                    emit_progress(
                        app_handle,
                        agent_id,
                        "download",
                        &format!("Branch binary ready ({arch_suffix})"),
                    );
                    Some(path.to_string_lossy().to_string())
                }
                Err(e) => {
                    let msg = format!("Failed to obtain branch build binary: {}", e);
                    error!("Agent setup: {}", msg);
                    emit_progress(app_handle, agent_id, "error", &msg);
                    inject_error_script(sftp_session, session_manager, session_id, &msg, rt_handle);
                    None
                }
            }
        }
        AgentBinarySource::LocalFile { path } => {
            // Only validate ELF arch for Linux targets; macOS Mach-O binaries
            // return Err from detect_binary_arch, which we silently skip.
            if let Ok(binary_arch) = detect_binary_arch(path) {
                if let Some(expected) = expected_arch_for_uname(&setup_config.remote_arch) {
                    if binary_arch != expected {
                        let msg = format!(
                            "Architecture mismatch: binary is {} but remote host is {} ({}).\n\
                                 Please select the correct binary for the target platform.",
                            binary_arch, expected, setup_config.remote_arch
                        );
                        error!("Agent setup: {}", msg);
                        emit_progress(app_handle, agent_id, "error", &msg);
                        inject_error_script(
                            sftp_session,
                            session_manager,
                            session_id,
                            &msg,
                            rt_handle,
                        );
                        return None;
                    }
                    info!("Agent setup: binary arch {} matches remote", binary_arch);
                }
            }
            Some(path.clone())
        }
    }
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
echo "You can close this terminal tab now."
echo ""
"#;

/// Inject commands into the visible terminal session via the SessionManager.
///
/// Uses the raw (non-normalizing) input path: these are internal setup commands
/// targeting a known Unix shell and must be sent byte-exact, independent of the
/// session's configured line ending.
fn inject_commands(
    session_manager: &SessionManager,
    session_id: &str,
    commands: &str,
    rt_handle: &tokio::runtime::Handle,
) {
    if let Err(e) =
        rt_handle.block_on(session_manager.send_input_raw(session_id, commands.as_bytes()))
    {
        error!("Agent setup: failed to inject commands: {}", e);
    }
}

/// Upload a small error script via SFTP and execute it in the terminal.
///
/// This avoids the shell echoing raw `printf` commands.  The user only
/// sees the `sh /tmp/…` invocation (same pattern as the normal setup
/// flow) followed by the styled error output.
fn inject_error_script(
    sftp_session: &SshSession,
    session_manager: &SessionManager,
    session_id: &str,
    message: &str,
    rt_handle: &tokio::runtime::Handle,
) {
    let script = generate_error_script(message);
    match upload_bytes_via_sftp(sftp_session, script.as_bytes(), TEMP_SCRIPT_PATH) {
        Ok(_) => {
            let cmd = format!("sh {}; rm -f {}\n", TEMP_SCRIPT_PATH, TEMP_SCRIPT_PATH);
            inject_commands(session_manager, session_id, &cmd, rt_handle);
        }
        Err(e) => {
            // Fallback: inject commands directly if upload fails
            error!("Agent setup: error script upload failed: {}", e);
            inject_error_inline(session_manager, session_id, message, rt_handle);
        }
    }
}

/// Inject a red error banner directly into the terminal (fallback).
///
/// Used only when SFTP is unavailable (e.g. connection failed).
fn inject_error_inline(
    session_manager: &SessionManager,
    session_id: &str,
    message: &str,
    rt_handle: &tokio::runtime::Handle,
) {
    let safe_msg = message.replace('\'', "'\\''");
    let cmd = format!(
        "printf '\\033[31m\\342\\235\\214 Error: %s\\033[0m\\n' '{}'\n\
         echo ''\n\
         printf '\\033[31m\\342\\235\\214 === Setup Failed ===\\033[0m\\n'\n",
        safe_msg
    );
    inject_commands(session_manager, session_id, &cmd, rt_handle);
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

    /// Regression guard for #837.
    ///
    /// The agent-setup background phase calls SSH/SFTP helpers that use
    /// `tokio::task::block_in_place` + `Handle::current()` internally, which
    /// require a Tokio runtime context on the calling thread. The original code
    /// spawned this phase on a raw `std::thread` (no runtime context), which
    /// aborts the process. This locks in that `spawn_setup_background` runs its
    /// task on a thread that *does* carry a runtime context.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn setup_background_runs_with_runtime_context() {
        let (tx, rx) = std::sync::mpsc::channel();
        spawn_setup_background(move || {
            let _ = tx.send(tokio::runtime::Handle::try_current().is_ok());
        });
        let has_runtime_context = rx.recv().expect("background task should run");
        assert!(
            has_runtime_context,
            "agent-setup background phase must run on a thread with a Tokio \
             runtime context, else the SSH/SFTP block_in_place helpers abort \
             the process (#837)"
        );
    }

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
        assert!(script.contains("You can close this terminal tab now."));
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
    fn agent_binary_source_github_serde() {
        let src = AgentBinarySource::GithubDownload;
        let json = serde_json::to_string(&src).unwrap();
        assert!(json.contains("\"type\":\"githubDownload\""), "got: {json}");
        let back: AgentBinarySource = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, AgentBinarySource::GithubDownload));
    }

    #[test]
    fn agent_binary_source_local_file_serde() {
        let src = AgentBinarySource::LocalFile {
            path: "/tmp/agent".to_string(),
        };
        let json = serde_json::to_string(&src).unwrap();
        assert!(json.contains("\"type\":\"localFile\""), "got: {json}");
        assert!(json.contains("/tmp/agent"));
        let back: AgentBinarySource = serde_json::from_str(&json).unwrap();
        match back {
            AgentBinarySource::LocalFile { path } => assert_eq!(path, "/tmp/agent"),
            _ => panic!("expected LocalFile"),
        }
    }

    #[test]
    fn agent_setup_config_github_serde_round_trip() {
        let config = AgentSetupConfig {
            binary_source: AgentBinarySource::GithubDownload,
            remote_os: "Linux".to_string(),
            remote_arch: "aarch64".to_string(),
            remote_path: Some("/opt/agent".to_string()),
            install_service: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: AgentSetupConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.remote_os, "Linux");
        assert_eq!(back.remote_arch, "aarch64");
        assert_eq!(back.remote_path, Some("/opt/agent".to_string()));
        assert!(back.install_service);
        assert!(matches!(
            back.binary_source,
            AgentBinarySource::GithubDownload
        ));
    }

    #[test]
    fn agent_setup_config_macos_serde_round_trip() {
        let config = AgentSetupConfig {
            binary_source: AgentBinarySource::GithubDownload,
            remote_os: "Darwin".to_string(),
            remote_arch: "arm64".to_string(),
            remote_path: None,
            install_service: false,
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: AgentSetupConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.remote_os, "Darwin");
        assert_eq!(back.remote_arch, "arm64");
    }

    #[test]
    fn agent_setup_config_defaults_remote_os_to_linux() {
        // Old payloads without remoteOs should deserialize with Linux default.
        let json = r#"{"binarySource":{"type":"githubDownload"},"remoteArch":"aarch64","installService":false}"#;
        let back: AgentSetupConfig = serde_json::from_str(json).unwrap();
        assert_eq!(back.remote_os, "Linux");
        assert_eq!(back.remote_arch, "aarch64");
    }

    #[test]
    fn agent_setup_config_local_file_serde_round_trip() {
        let config = AgentSetupConfig {
            binary_source: AgentBinarySource::LocalFile {
                path: "/home/user/termihub-agent".to_string(),
            },
            remote_os: "Linux".to_string(),
            remote_arch: "x86_64".to_string(),
            remote_path: None,
            install_service: false,
        };
        let json = serde_json::to_string(&config).unwrap();
        let back: AgentSetupConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.remote_arch, "x86_64");
        assert!(back.remote_path.is_none());
        match back.binary_source {
            AgentBinarySource::LocalFile { path } => {
                assert_eq!(path, "/home/user/termihub-agent")
            }
            _ => panic!("expected LocalFile"),
        }
    }

    #[test]
    fn remote_arch_info_serde() {
        let base =
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-";
        let info = RemoteArchInfo {
            arch: "aarch64".to_string(),
            os: "Linux".to_string(),
            arch_suffix: Some("linux-arm64".to_string()),
            download_base_url: base.to_string(),
            download_url: Some(format!("{base}linux-arm64")),
            build_branch: None,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("archSuffix"));
        assert!(json.contains("downloadUrl"));
        assert!(json.contains("downloadBaseUrl"));
        assert!(json.contains("linux-arm64"));
        let back: RemoteArchInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.arch, "aarch64");
        assert_eq!(back.arch_suffix, Some("linux-arm64".to_string()));
        assert!(back.download_base_url.ends_with("termihub-agent-"));
    }

    #[test]
    fn remote_arch_info_unsupported_arch_serde() {
        let info = RemoteArchInfo {
            arch: "mips".to_string(),
            os: "Linux".to_string(),
            arch_suffix: None,
            download_base_url:
                "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-"
                    .to_string(),
            download_url: None,
            build_branch: None,
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: RemoteArchInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.arch, "mips");
        assert!(back.arch_suffix.is_none());
        assert!(back.download_url.is_none());
        assert!(!back.download_base_url.is_empty());
        assert!(back.build_branch.is_none());
    }

    #[test]
    fn remote_arch_info_with_build_branch_serde() {
        let base =
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-";
        let info = RemoteArchInfo {
            arch: "x86_64".to_string(),
            os: "Linux".to_string(),
            arch_suffix: Some("linux-x64".to_string()),
            download_base_url: base.to_string(),
            download_url: Some(format!("{base}linux-x64")),
            build_branch: Some("feature/666-my-branch".to_string()),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("buildBranch"));
        assert!(json.contains("feature/666-my-branch"));
        let back: RemoteArchInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.build_branch.as_deref(), Some("feature/666-my-branch"));
    }

    #[test]
    fn agent_binary_source_branch_build_serde() {
        let src = AgentBinarySource::BranchBuild {
            branch: "feature/666-my-branch".to_string(),
        };
        let json = serde_json::to_string(&src).unwrap();
        assert!(json.contains("\"type\":\"branchBuild\""), "got: {json}");
        assert!(json.contains("feature/666-my-branch"));
        let back: AgentBinarySource = serde_json::from_str(&json).unwrap();
        match back {
            AgentBinarySource::BranchBuild { branch } => {
                assert_eq!(branch, "feature/666-my-branch")
            }
            _ => panic!("expected BranchBuild"),
        }
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
