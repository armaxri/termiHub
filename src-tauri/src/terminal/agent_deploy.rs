//! Probe, deploy, and update the remote agent binary.
//!
//! These functions are called from Tauri commands to:
//! - **Probe** an SSH host: check if `termihub-agent` is installed, what
//!   version it reports, and whether it's compatible with the desktop.
//! - **Deploy** the agent: resolve the correct binary (via `agent_binary`),
//!   upload it to the remote host via SFTP, and verify it runs.
//! - **Update** the agent: shut down the running agent, then deploy a new
//!   version.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

use crate::terminal::agent_binary;
use crate::terminal::backend::RemoteAgentConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{
    detect_binary_arch, detect_remote_info, expected_arch_for_uname, run_remote_command,
    upload_bytes_via_sftp,
};
use crate::utils::ssh_auth::connect_and_authenticate;
use crate::utils::version;

/// Default install path on the remote host.
const DEFAULT_REMOTE_PATH: &str = ".local/bin/termihub-agent";

/// Temporary upload path (writable without sudo).
const TEMP_UPLOAD_PATH: &str = "/tmp/termihub-agent-upload";

// ── Probe ──────────────────────────────────────────────────────────────

/// Result of probing a remote host for the agent binary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbeResult {
    /// Whether the agent binary was found on the remote host.
    pub found: bool,
    /// Version string reported by the agent, if found.
    pub version: Option<String>,
    /// Remote CPU architecture (`uname -m`).
    pub remote_arch: String,
    /// Remote OS (`uname -s`).
    pub remote_os: String,
    /// Whether the found version is compatible with the desktop.
    pub compatible: bool,
}

/// Probe a remote host for the agent binary via SSH.
///
/// Connects, runs `uname` and `termihub-agent --version`, and returns
/// the findings. Does not modify anything on the remote host.
///
/// Uses the configured agent path (with `~/` → `$HOME/` expansion) so the
/// binary is found even when `~/.local/bin` is not on the non-interactive
/// SSH PATH.
pub fn probe_remote_agent(
    config: &RemoteAgentConfig,
    expected_version: &str,
) -> Result<AgentProbeResult, TerminalError> {
    let ssh_config = config.to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    let (remote_os, remote_arch) = detect_remote_info(&session)?;

    // Try running the agent with --version using the resolved path
    let version_cmd = config.agent_version_command();
    let version_output = run_remote_command(&session, &version_cmd);

    let (found, version, compatible) = match version_output {
        Ok(output) if !output.is_empty() => {
            // Expected format: "termihub-agent 0.1.0"
            let ver = output
                .strip_prefix("termihub-agent ")
                .unwrap_or(&output)
                .trim()
                .to_string();
            let compat = version::is_version_compatible(&ver, expected_version);
            debug!(
                version = %ver,
                compatible = compat,
                "Found remote agent"
            );
            (true, Some(ver), compat)
        }
        _ => {
            debug!("Agent not found on remote host");
            (false, None, false)
        }
    };

    Ok(AgentProbeResult {
        found,
        version,
        remote_arch,
        remote_os,
        compatible,
    })
}

// ── Deploy ─────────────────────────────────────────────────────────────

/// Configuration for deploying the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeployConfig {
    /// Override the remote install path (defaults to `~/.local/bin/termihub-agent`).
    pub remote_path: Option<String>,
}

/// Progress event emitted during agent deployment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeployProgress {
    pub agent_id: String,
    pub step: String,
    pub message: String,
    /// Progress fraction (0.0–1.0), or -1 for indeterminate.
    pub progress: f64,
}

/// Result of deploying the agent binary to a remote host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeployResult {
    pub success: bool,
    pub installed_version: Option<String>,
}

/// Deploy the agent binary to a remote host.
///
/// 1. SSH connect and detect remote architecture
/// 2. Resolve the binary locally (cache → bundled → download)
/// 3. Validate ELF architecture matches the remote host
/// 4. Upload via SFTP to temp path, then move into place
/// 5. Verify the installed binary runs
pub fn deploy_agent(
    agent_id: &str,
    config: &RemoteAgentConfig,
    deploy_config: &AgentDeployConfig,
    app_handle: &AppHandle,
) -> Result<AgentDeployResult, TerminalError> {
    let remote_path = deploy_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);

    // 1. SSH connect
    emit_progress(
        app_handle,
        agent_id,
        "connecting",
        "Connecting to host…",
        -1.0,
    );
    let ssh_config = config.to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    // 2. Detect remote arch
    emit_progress(
        app_handle,
        agent_id,
        "detecting",
        "Detecting remote system…",
        -1.0,
    );
    let (_remote_os, remote_arch) = detect_remote_info(&session)?;

    let arch_suffix = agent_binary::artifact_name_for_arch(&remote_arch).ok_or_else(|| {
        TerminalError::RemoteError(format!("Unsupported remote architecture: {remote_arch}"))
    })?;

    // 3. Resolve binary locally
    emit_progress(
        app_handle,
        agent_id,
        "resolving",
        "Resolving agent binary…",
        0.1,
    );
    let version = env!("CARGO_PKG_VERSION");
    let agent_id_owned = agent_id.to_string();
    let app_clone = app_handle.clone();
    let binary_path =
        agent_binary::resolve_agent_binary(app_handle, version, arch_suffix, move |dl, total| {
            let pct = if total > 0 {
                dl as f64 / total as f64
            } else {
                -1.0
            };
            emit_progress(
                &app_clone,
                &agent_id_owned,
                "downloading",
                &format!("Downloading agent binary ({dl} bytes)…"),
                pct,
            );
        })
        .map_err(|e| TerminalError::RemoteError(format!("Failed to resolve binary: {e}")))?;

    // 4. Validate ELF architecture
    emit_progress(
        app_handle,
        agent_id,
        "validating",
        "Validating binary architecture…",
        0.3,
    );
    let binary_path_str = binary_path.to_string_lossy();
    if let Ok(elf_arch) = detect_binary_arch(&binary_path_str) {
        if let Some(expected_arch) = expected_arch_for_uname(&remote_arch) {
            if elf_arch != expected_arch {
                return Err(TerminalError::RemoteError(format!(
                    "Architecture mismatch: binary is {elf_arch:?}, remote expects {expected_arch:?}"
                )));
            }
        }
    }

    // 5. Read binary and upload via SFTP
    emit_progress(
        app_handle,
        agent_id,
        "uploading",
        "Uploading agent binary…",
        0.4,
    );
    let binary_bytes = std::fs::read(&binary_path)
        .map_err(|e| TerminalError::RemoteError(format!("Failed to read binary: {e}")))?;
    upload_bytes_via_sftp(&session, &binary_bytes, TEMP_UPLOAD_PATH)?;
    info!(
        "Uploaded {} bytes to {}",
        binary_bytes.len(),
        TEMP_UPLOAD_PATH
    );

    // 6. Install: create dir, move binary, set permissions
    emit_progress(
        app_handle,
        agent_id,
        "installing",
        "Installing agent binary…",
        0.7,
    );
    let install_cmd = format!(
        "mkdir -p \"$(dirname {remote_path})\" && \
         mv -f {TEMP_UPLOAD_PATH} {remote_path} && \
         chmod +x {remote_path}"
    );
    run_remote_command(&session, &install_cmd)
        .map_err(|e| TerminalError::RemoteError(format!("Install command failed: {e}")))?;

    // 7. Verify
    emit_progress(
        app_handle,
        agent_id,
        "verifying",
        "Verifying installation…",
        0.9,
    );
    let verify_output =
        run_remote_command(&session, &format!("{remote_path} --version 2>/dev/null"));

    let installed_version = match verify_output {
        Ok(output) if !output.is_empty() => {
            let ver = output
                .strip_prefix("termihub-agent ")
                .unwrap_or(&output)
                .trim()
                .to_string();
            info!("Agent installed successfully: v{ver}");
            Some(ver)
        }
        Ok(_) => {
            warn!("Agent binary installed but --version returned empty output");
            None
        }
        Err(e) => {
            warn!("Agent binary installed but --version failed: {e}");
            None
        }
    };

    let success = installed_version.is_some();
    emit_progress(
        app_handle,
        agent_id,
        "done",
        if success {
            "Agent deployed successfully"
        } else {
            "Deployment finished with warnings"
        },
        1.0,
    );

    Ok(AgentDeployResult {
        success,
        installed_version,
    })
}

// ── Update ─────────────────────────────────────────────────────────────

/// Update the agent: shut down the running instance, then deploy a new binary.
///
/// `shutdown_fn` is called to send `agent.shutdown` to the running agent
/// before deploying. This is a closure so we don't need a direct dependency
/// on `AgentConnectionManager` here.
pub fn update_agent<F>(
    agent_id: &str,
    config: &RemoteAgentConfig,
    deploy_config: &AgentDeployConfig,
    app_handle: &AppHandle,
    shutdown_fn: F,
) -> Result<AgentDeployResult, TerminalError>
where
    F: FnOnce() -> Result<u32, TerminalError>,
{
    // 1. Shut down the running agent
    emit_progress(
        app_handle,
        agent_id,
        "shutdown",
        "Shutting down running agent…",
        -1.0,
    );
    match shutdown_fn() {
        Ok(detached) => {
            info!("Agent shut down gracefully ({detached} sessions detached)");
        }
        Err(e) => {
            warn!("Agent shutdown failed (may already be stopped): {e}");
        }
    }

    // Brief pause for the remote process to exit
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 2. Deploy the new binary
    deploy_agent(agent_id, config, deploy_config, app_handle)
}

// ── Helpers ────────────────────────────────────────────────────────────

fn emit_progress(app_handle: &AppHandle, agent_id: &str, step: &str, message: &str, progress: f64) {
    let _ = app_handle.emit(
        "agent-deploy-progress",
        AgentDeployProgress {
            agent_id: agent_id.to_string(),
            step: step.to_string(),
            message: message.to_string(),
            progress,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_result_serde_round_trip() {
        let result = AgentProbeResult {
            found: true,
            version: Some("0.1.0".to_string()),
            remote_arch: "aarch64".to_string(),
            remote_os: "Linux".to_string(),
            compatible: true,
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: AgentProbeResult = serde_json::from_str(&json).unwrap();
        assert!(parsed.found);
        assert_eq!(parsed.version.as_deref(), Some("0.1.0"));
        assert!(parsed.compatible);
    }

    #[test]
    fn probe_result_not_found() {
        let result = AgentProbeResult {
            found: false,
            version: None,
            remote_arch: "x86_64".to_string(),
            remote_os: "Linux".to_string(),
            compatible: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"found\":false"));
        assert!(json.contains("\"version\":null"));
    }

    #[test]
    fn deploy_config_serde() {
        let config = AgentDeployConfig {
            remote_path: Some("/opt/termihub-agent".to_string()),
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("remotePath"));
        let parsed: AgentDeployConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.remote_path.as_deref(), Some("/opt/termihub-agent"));
    }

    #[test]
    fn deploy_config_default_remote_path() {
        let config: AgentDeployConfig = serde_json::from_str("{}").unwrap();
        assert!(config.remote_path.is_none());
        // When None, deploy_agent uses DEFAULT_REMOTE_PATH
        assert_eq!(DEFAULT_REMOTE_PATH, ".local/bin/termihub-agent");
    }

    #[test]
    fn deploy_result_success() {
        let result = AgentDeployResult {
            success: true,
            installed_version: Some("0.1.0".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert!(parsed.success);
        assert_eq!(parsed.installed_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn deploy_result_failure() {
        let result = AgentDeployResult {
            success: false,
            installed_version: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert!(!parsed.success);
        assert!(parsed.installed_version.is_none());
    }

    #[test]
    fn version_parsing_from_agent_output() {
        // Simulate the output of `termihub-agent --version`
        let output = "termihub-agent 0.1.0";
        let ver = output.strip_prefix("termihub-agent ").unwrap().trim();
        assert_eq!(ver, "0.1.0");
        assert!(version::is_version_compatible(ver, "0.1.0"));
    }

    #[test]
    fn version_parsing_bare() {
        // Handle case where output is just the version
        let output = "0.2.0";
        let ver = output
            .strip_prefix("termihub-agent ")
            .unwrap_or(output)
            .trim();
        assert_eq!(ver, "0.2.0");
    }
}
