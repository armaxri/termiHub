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
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::terminal::agent_binary;
use crate::terminal::agent_cancel::bail_if_cancelled;
use crate::terminal::agent_install::{
    self, detect_windows_shell, posix_install_plan, windows_install_plan, windows_resolve_command,
    InstallPlan,
};
use crate::terminal::backend::RemoteAgentConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{
    detect_binary_arch, detect_remote_info, expected_arch_for_uname, remove_via_sftp,
    run_remote_command, upload_bytes_via_sftp,
};
use crate::utils::ssh_auth::connect_and_authenticate;
use crate::utils::version;

/// Default install path on the remote host.
const DEFAULT_REMOTE_PATH: &str = agent_install::POSIX_DEFAULT_INSTALL_PATH;

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
            // Expected format: "termihub-agent 0.1.0" or "termihub-agent 0.1.0 (branch: foo)"
            // Take only the version token so branch annotations are ignored.
            let ver = output
                .strip_prefix("termihub-agent ")
                .unwrap_or(&output)
                .split_whitespace()
                .next()
                .unwrap_or("")
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

/// A host (other than the initiating desktop) connected to the agent when an
/// update is requested. Surfaced to the Update dialog so the user can see who
/// will be cut off before confirming a forced update (#1349).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedHost {
    /// Agent-assigned id for this client connection.
    pub client_id: String,
    /// Client name reported in `initialize` (e.g. `"termihub-desktop"`).
    pub client: String,
    /// Client version reported in `initialize`.
    pub client_version: String,
    /// ISO 8601 timestamp of when the host connected to the agent.
    pub connected_since: String,
}

/// Outcome of an agent deploy/update.
///
/// `Deployed` is the normal outcome (of both deploy and a proceeding update);
/// `OtherHostsConnected` is returned only by the update path when the
/// connected-host guard blocks an unforced update because other hosts are
/// connected. The desktop then shows the Update dialog's warning and may retry
/// via `update_agent_force`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentDeployResult {
    /// The binary was deployed/updated. `success` reflects the post-install
    /// `--version` verification.
    #[serde(rename_all = "camelCase")]
    Deployed {
        success: bool,
        installed_version: Option<String>,
        /// Absolute path the agent was installed to on the remote host.
        ///
        /// Useful for Windows hosts, where the install location
        /// (`%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`) differs from the
        /// POSIX default and should be stored as the connection's agent path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        installed_path: Option<String>,
    },
    /// The update was blocked by the connected-host guard: other hosts are
    /// connected to the agent and would be hard-cut by the update.
    #[serde(rename_all = "camelCase")]
    OtherHostsConnected { hosts: Vec<ConnectedHost> },
    /// A coordinated desktop-push update was dispatched to the agent (Unix
    /// hosts, #1616). The binary was staged and handed to `agent.request_update`,
    /// which broadcast `agent.update_pending` to every other connected host,
    /// gave them a window to disconnect, then applied the staged binary through
    /// the deferred-apply path (swap + re-exec). Because the agent re-execs, the
    /// desktop cannot verify the installed version here — it reconnects to
    /// observe the new version, exactly like the coordinated self-update path.
    #[serde(rename_all = "camelCase")]
    Coordinated {
        /// `true` when the agent was idle and applied immediately (the
        /// connection is expected to drop as the binary swaps); `false` when the
        /// update was deferred until the last of `active_sessions` disconnects.
        applied: bool,
        /// Sessions still active on the agent (0 when applied immediately).
        active_sessions: u32,
        /// How many *other* hosts were sent the `agent.update_pending` notice.
        notified_clients: u32,
        /// `true` when every notified host disconnected inside the window (or
        /// there was nobody to notify); `false` when the window closed with
        /// hosts still attached.
        all_acked: bool,
        /// `client_id`s still attached when the window closed. Empty on success.
        remaining_clients: Vec<String>,
    },
}

/// A binary staged for a coordinated update (#1616) — uploaded to the remote
/// temp path but not installed. Handed to `agent.request_update{binaryPath}`,
/// which the agent applies via its Unix-only self-swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBinary {
    /// Detected remote OS string (e.g. `"Linux"`, `"Darwin"`, `"Windows_NT"`).
    pub remote_os: String,
    /// `true` when the remote host is Windows. The agent cannot self-swap a
    /// running binary there (`agent/src/update/apply.rs` is Unix-only), so no
    /// binary is uploaded and the caller must fall back to an immediate deploy.
    pub is_windows: bool,
    /// Remote temp path where the new binary was uploaded. `Some` on Unix (the
    /// value to pass as `binaryPath`); `None` on Windows.
    pub upload_path: Option<String>,
}

/// Whether a coordinated desktop-push update can use the agent's self-swap path
/// on a host reporting `remote_os`.
///
/// Only Unix hosts qualify: the agent applies a staged `binaryPath` by replacing
/// its own running executable and re-execing, which `agent/src/update/apply.rs`
/// implements for Unix only. A Windows host must fall back to an immediate
/// deploy (shutdown + redeploy) instead (#1616).
pub fn coordinated_self_swap_supported(remote_os: &str) -> bool {
    !agent_binary::is_windows_os(remote_os)
}

/// Decide whether an update may proceed given the hosts (other than the
/// initiating desktop) currently connected to the agent.
///
/// Returns `Some(AgentDeployResult::OtherHostsConnected)` when at least one
/// other host is connected — the desktop must confirm before forcing — or
/// `None` when the update may proceed exactly as today (no other hosts).
pub fn connected_host_guard(other_hosts: Vec<ConnectedHost>) -> Option<AgentDeployResult> {
    if other_hosts.is_empty() {
        None
    } else {
        Some(AgentDeployResult::OtherHostsConnected { hosts: other_hosts })
    }
}

/// Deploy the agent binary to a remote host.
///
/// 1. SSH connect and detect remote architecture
/// 2. Resolve the binary locally (cache → bundled → download)
/// 3. Validate ELF architecture matches the remote host
/// 4. Upload via SFTP to temp path, then move into place
/// 5. Verify the installed binary runs
///
/// `cancel` is checked before each network step (G10, #1242); firing it aborts
/// the deploy before the next step and rolls back a partial upload. Pass `None`
/// to run without cancellation (e.g. the `update_agent` re-deploy path).
pub fn deploy_agent(
    agent_id: &str,
    config: &RemoteAgentConfig,
    deploy_config: &AgentDeployConfig,
    app_handle: &AppHandle,
    cancel: Option<&CancellationToken>,
) -> Result<AgentDeployResult, TerminalError> {
    let remote_path = deploy_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);

    // 1. SSH connect
    bail_if_cancelled(cancel)?;
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
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "detecting",
        "Detecting remote system…",
        -1.0,
    );
    let (remote_os, remote_arch) = detect_remote_info(&session)?;

    let arch_suffix = agent_binary::artifact_name_for_os_arch(&remote_os, &remote_arch)
        .ok_or_else(|| {
            TerminalError::RemoteError(format!(
                "Unsupported remote platform: {remote_os} {remote_arch}"
            ))
        })?;

    // 3. Resolve binary locally
    bail_if_cancelled(cancel)?;
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

    // 5. Determine the platform-specific install plan. Windows hosts need
    //    PowerShell/cmd commands and a different upload/install location; no
    //    POSIX-only commands (`mkdir -p`, `mv -f`, `chmod`, `/tmp`) are issued.
    let (plan, windows_shell): (InstallPlan, Option<agent_install::WindowsShell>) =
        if agent_binary::is_windows_os(&remote_os) {
            let shell = detect_windows_shell(&session);
            info!("Remote host is Windows; using {shell:?} install commands");
            (windows_install_plan(shell), Some(shell))
        } else {
            (posix_install_plan(remote_path), None)
        };

    // 6. Read binary and upload via SFTP
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "uploading",
        "Uploading agent binary…",
        0.4,
    );
    let binary_bytes = std::fs::read(&binary_path)
        .map_err(|e| TerminalError::RemoteError(format!("Failed to read binary: {e}")))?;
    upload_bytes_via_sftp(&session, &binary_bytes, &plan.upload_path)?;
    info!(
        "Uploaded {} bytes to {}",
        binary_bytes.len(),
        plan.upload_path
    );

    // A cancel that landed during the upload must not leave the temp file
    // behind — roll it back before returning (G10, #1242).
    if let Err(e) = bail_if_cancelled(cancel) {
        rollback_partial_upload(&session, &plan.upload_path);
        return Err(e);
    }

    // 7. Install: create dir + move binary into place (POSIX also sets +x).
    emit_progress(
        app_handle,
        agent_id,
        "installing",
        "Installing agent binary…",
        0.7,
    );
    run_remote_command(&session, &plan.install_command)
        .map_err(|e| TerminalError::RemoteError(format!("Install command failed: {e}")))?;

    // 8. Verify
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "verifying",
        "Verifying installation…",
        0.9,
    );
    let verify_output = run_remote_command(&session, &plan.verify_command);

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

    // Resolve the concrete install path. On Windows this expands
    // `%LOCALAPPDATA%`/`$env:LOCALAPPDATA` to an absolute, shell-agnostic path.
    let installed_path = match windows_shell {
        Some(shell) => run_remote_command(&session, &windows_resolve_command(shell))
            .ok()
            .filter(|p| !p.is_empty())
            .or_else(|| Some(plan.install_path.clone())),
        None => Some(plan.install_path.clone()),
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

    Ok(AgentDeployResult::Deployed {
        success,
        installed_version,
        installed_path,
    })
}

// ── Update ─────────────────────────────────────────────────────────────

/// Update the agent: shut down the running instance, then deploy a new binary.
///
/// Unless `force` is set, a connected-host guard runs first (#1349):
/// `list_other_hosts_fn` reports the hosts — other than the initiating desktop
/// — connected to the agent, and if any are present the update is refused with
/// [`AgentDeployResult::OtherHostsConnected`] so the desktop can warn the user
/// before hard-cutting those sessions. `force` (from `update_agent_force`)
/// bypasses the guard after the user confirms.
///
/// `shutdown_fn` is called to send `agent.shutdown` to the running agent
/// before deploying. Both are closures so we don't need a direct dependency
/// on `AgentConnectionManager` here.
// The deploy context (id/config/app handle/cancel), the guard toggle, and the
// two injected closures are all distinct inputs; bundling them into a struct
// would only obscure the call site.
#[allow(clippy::too_many_arguments)]
pub fn update_agent<L, F>(
    agent_id: &str,
    config: &RemoteAgentConfig,
    deploy_config: &AgentDeployConfig,
    app_handle: &AppHandle,
    cancel: Option<&CancellationToken>,
    force: bool,
    list_other_hosts_fn: L,
    shutdown_fn: F,
) -> Result<AgentDeployResult, TerminalError>
where
    L: FnOnce() -> Result<Vec<ConnectedHost>, TerminalError>,
    F: FnOnce() -> Result<u32, TerminalError>,
{
    // 0. Connected-host guard: refuse an unforced update while other hosts are
    // connected to the agent (they would be hard-cut). Runs before shutdown so
    // the agent is still reachable for `agent.list_connections`.
    if !force {
        let other_hosts = list_other_hosts_fn()?;
        if let Some(blocked) = connected_host_guard(other_hosts) {
            info!(agent_id, "Update blocked: other hosts connected to agent");
            return Ok(blocked);
        }
    }

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
    deploy_agent(agent_id, config, deploy_config, app_handle, cancel)
}

// ── Coordinated staging (#1616) ──────────────────────────────────────────

/// Stage the agent binary for a coordinated desktop-push update (#1616).
///
/// Connects and detects the remote OS. On **Windows** the agent cannot self-swap
/// a running binary, so this returns early ([`StagedBinary::is_windows`] = true,
/// no upload) and the caller falls back to an immediate deploy. On **Unix** it
/// resolves and validates the new binary and uploads it to the temp path
/// *without* installing it, returning that path so the caller can hand it to
/// `agent.request_update{binaryPath}` — the agent then broadcasts the notice,
/// waits, and self-applies (swap + re-exec).
///
/// Unlike [`update_agent`], this never shuts the agent down or runs the
/// connected-host guard: the `agent.update_pending` notice *is* the courtesy to
/// other hosts, and the swap is the agent's job, not the desktop's.
pub fn stage_agent_binary(
    agent_id: &str,
    config: &RemoteAgentConfig,
    deploy_config: &AgentDeployConfig,
    app_handle: &AppHandle,
    cancel: Option<&CancellationToken>,
) -> Result<StagedBinary, TerminalError> {
    let remote_path = deploy_config
        .remote_path
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_PATH);

    // 1. SSH connect
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "connecting",
        "Connecting to host…",
        -1.0,
    );
    let ssh_config = config.to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    // 2. Detect remote OS/arch
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "detecting",
        "Detecting remote system…",
        -1.0,
    );
    let (remote_os, remote_arch) = detect_remote_info(&session)?;

    // Windows agents cannot self-swap a running binary (apply.rs is Unix-only):
    // stop here so the caller falls back to an immediate deploy (#1616).
    if !coordinated_self_swap_supported(&remote_os) {
        info!(
            agent_id,
            %remote_os, "Coordinated update: Windows host cannot self-swap; caller falls back to immediate deploy"
        );
        return Ok(StagedBinary {
            remote_os,
            is_windows: true,
            upload_path: None,
        });
    }

    let arch_suffix = agent_binary::artifact_name_for_os_arch(&remote_os, &remote_arch)
        .ok_or_else(|| {
            TerminalError::RemoteError(format!(
                "Unsupported remote platform: {remote_os} {remote_arch}"
            ))
        })?;

    // 3. Resolve binary locally
    bail_if_cancelled(cancel)?;
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

    // 4. Validate ELF architecture (POSIX hosts only reach here)
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

    // 5. Upload to the temp path WITHOUT installing — the agent's self-apply
    //    swaps the running binary from this path (never run the install command
    //    or shut the agent down; that is the agent's job for coordinated).
    let plan = posix_install_plan(remote_path);
    bail_if_cancelled(cancel)?;
    emit_progress(
        app_handle,
        agent_id,
        "staging",
        "Staging agent binary…",
        0.4,
    );
    let binary_bytes = std::fs::read(&binary_path)
        .map_err(|e| TerminalError::RemoteError(format!("Failed to read binary: {e}")))?;
    upload_bytes_via_sftp(&session, &binary_bytes, &plan.upload_path)?;
    if let Err(e) = bail_if_cancelled(cancel) {
        rollback_partial_upload(&session, &plan.upload_path);
        return Err(e);
    }
    info!(
        "Staged {} bytes to {} for coordinated update",
        binary_bytes.len(),
        plan.upload_path
    );
    emit_progress(
        app_handle,
        agent_id,
        "staged",
        "Binary staged; coordinating with connected hosts…",
        0.7,
    );

    Ok(StagedBinary {
        remote_os,
        is_windows: false,
        upload_path: Some(plan.upload_path),
    })
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Best-effort removal of a partially uploaded binary after a cancel (G10, #1242).
///
/// The upload target lives at a temp path (`plan.upload_path`, e.g. `/tmp/…` on
/// POSIX) that has not yet been moved into place, so removing it fully rolls back
/// the SFTP upload. Failures are logged but not surfaced — the deploy already
/// failed with `Cancelled` and the temp file is harmless if it lingers.
fn rollback_partial_upload(
    session: &termihub_core::backends::ssh::handler::SshSession,
    upload_path: &str,
) {
    // SFTP remove works uniformly on POSIX and Windows hosts (the upload path is
    // a temp location that has not yet been moved into place).
    match remove_via_sftp(session, upload_path) {
        Ok(_) => info!("Rolled back partial agent upload at {upload_path}"),
        Err(e) => warn!("Failed to roll back partial upload at {upload_path}: {e}"),
    }
}

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
        let result = AgentDeployResult::Deployed {
            success: true,
            installed_version: Some("0.1.0".to_string()),
            installed_path: Some("/home/user/.local/bin/termihub-agent".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"kind\":\"deployed\""));
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, result);
    }

    #[test]
    fn deploy_result_failure() {
        let result = AgentDeployResult::Deployed {
            success: false,
            installed_version: None,
            installed_path: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        // installed_path is omitted from JSON when None.
        assert!(!json.contains("installedPath"));
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, result);
    }

    #[test]
    fn coordinated_result_serializes_for_the_dialog() {
        // The desktop-push coordinated deploy (#1616) surfaces the same
        // coordination outcome as the self-update path: notified hosts, ack
        // state, and any hosts still attached when the window closed.
        let result = AgentDeployResult::Coordinated {
            applied: false,
            active_sessions: 2,
            notified_clients: 3,
            all_acked: false,
            remaining_clients: vec!["id-9".to_string()],
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"kind\":\"coordinated\""));
        assert!(json.contains("notifiedClients"));
        assert!(json.contains("activeSessions"));
        assert!(json.contains("remainingClients"));
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, result);
    }

    /// The Unix-only self-swap gate (#1616): only Unix hosts may take the
    /// coordinated `agent.request_update` path; Windows must fall back to an
    /// immediate deploy because `agent/src/update/apply.rs` is Unix-only.
    #[test]
    fn coordinated_self_swap_supported_only_on_unix() {
        for unix in ["Linux", "Darwin", "FreeBSD", "linux"] {
            assert!(
                coordinated_self_swap_supported(unix),
                "{unix} is Unix and must support the coordinated self-swap"
            );
        }
        for win in ["Windows_NT", "MINGW64_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT"] {
            assert!(
                !coordinated_self_swap_supported(win),
                "{win} is Windows and must fall back to immediate"
            );
        }
    }

    fn sample_host(id: &str) -> ConnectedHost {
        ConnectedHost {
            client_id: id.to_string(),
            client: "termihub-desktop".to_string(),
            client_version: "0.1.0".to_string(),
            connected_since: "2026-07-14T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn guard_allows_update_when_no_other_hosts() {
        // 0 other hosts → behaves as today: the update proceeds (no block).
        assert_eq!(connected_host_guard(vec![]), None);
    }

    #[test]
    fn guard_blocks_update_when_other_hosts_connected() {
        // N other hosts → the update is blocked and the hosts are surfaced.
        let hosts = vec![sample_host("id-1"), sample_host("id-2")];
        match connected_host_guard(hosts.clone()) {
            Some(AgentDeployResult::OtherHostsConnected { hosts: reported }) => {
                assert_eq!(reported, hosts, "all other hosts must be reported");
            }
            other => panic!("expected OtherHostsConnected, got {other:?}"),
        }
    }

    #[test]
    fn other_hosts_result_serializes_for_the_dialog() {
        let result = AgentDeployResult::OtherHostsConnected {
            hosts: vec![sample_host("id-1")],
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"kind\":\"otherHostsConnected\""));
        assert!(json.contains("\"clientId\":\"id-1\""));
        assert!(json.contains("\"connectedSince\""));
        let parsed: AgentDeployResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, result);
    }

    #[test]
    fn version_parsing_from_agent_output() {
        let output = "termihub-agent 0.1.0";
        let ver = output
            .strip_prefix("termihub-agent ")
            .unwrap_or(output)
            .split_whitespace()
            .next()
            .unwrap_or("");
        assert_eq!(ver, "0.1.0");
        assert!(version::is_version_compatible(ver, "0.1.0"));
    }

    #[test]
    fn version_parsing_with_branch_annotation() {
        // Branch builds append "(branch: foo)" — parser must ignore it.
        let output = "termihub-agent 0.1.0 (branch: feature/666-persistent-connection-ux)";
        let ver = output
            .strip_prefix("termihub-agent ")
            .unwrap_or(output)
            .split_whitespace()
            .next()
            .unwrap_or("");
        assert_eq!(ver, "0.1.0");
        assert!(version::is_version_compatible(ver, "0.1.0"));
    }

    #[test]
    fn version_parsing_bare() {
        let output = "0.2.0";
        let ver = output
            .strip_prefix("termihub-agent ")
            .unwrap_or(output)
            .split_whitespace()
            .next()
            .unwrap_or("");
        assert_eq!(ver, "0.2.0");
    }
}
