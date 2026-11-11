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
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, trace, warn};

use crate::terminal::agent_binary;
use crate::terminal::agent_cancel::bail_if_cancelled;
use crate::terminal::agent_install::{
    self, detect_windows_shell, posix_install_plan, prepare_posix_upload_dir, windows_install_plan,
    windows_resolve_command, InstallPlan,
};
use crate::terminal::backend::RemoteAgentConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::{
    detect_binary_arch, detect_remote_info, expected_arch_for_uname, remove_via_sftp,
    run_remote_command, run_remote_command_checked, upload_bytes_via_sftp_cancellable,
};
use crate::utils::ssh_auth::connect_and_authenticate;
#[cfg(test)]
use termihub_core::util::version;

/// Default install path on the remote host.
const DEFAULT_REMOTE_PATH: &str = agent_install::POSIX_DEFAULT_INSTALL_PATH;

// ── Probe ──────────────────────────────────────────────────────────────

// The probe has no IPC caller since the `probe_remote_agent` Tauri command was
// removed (#4570); it is kept test-only for the Windows SSH host suite
// (`agent_manager/windows_ssh_host_tests.rs`).

/// Result of probing a remote host for the agent binary.
#[cfg(test)]
// The Windows suite reads `found`/`version`; the rest shows in its `{probe:?}`
// failure messages, which dead-code analysis ignores.
#[allow(dead_code)]
#[derive(Debug, Clone)]
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

/// The version token of `termihub-agent --version` output.
///
/// Expected format: `termihub-agent 0.1.0`, optionally followed by a branch
/// annotation (`termihub-agent 0.1.0 (branch: foo)`) or carrying a pre-release
/// suffix (`termihub-agent 0.2.0-beta.1`). Only the version token is returned so
/// annotations are ignored.
#[cfg(test)]
fn agent_version_token(output: &str) -> &str {
    output
        .strip_prefix("termihub-agent ")
        .unwrap_or(output)
        .split_whitespace()
        .next()
        .unwrap_or("")
}

/// Probe a remote host for the agent binary via SSH.
///
/// Connects, runs `uname` and `termihub-agent --version`, and returns
/// the findings. Does not modify anything on the remote host.
///
/// Uses the configured agent path (with `~/` → `$HOME/` expansion) so the
/// binary is found even when `~/.local/bin` is not on the non-interactive
/// SSH PATH.
#[cfg(test)]
pub fn probe_remote_agent(
    config: &RemoteAgentConfig,
    expected_version: &str,
) -> Result<AgentProbeResult, TerminalError> {
    // Expand `${env:…}` / `~` in host / username / key path like the agent
    // connect path does (#3661); the password stays verbatim.
    let ssh_config = config.clone().expand().to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    let (remote_os, remote_arch) = detect_remote_info(&session)?;

    // Try running the agent with --version using the resolved path
    let version_cmd = config.agent_version_command();
    // A frozen server is a failed probe, not a missing agent (#3698).
    let version_output = match run_remote_command(&session, &version_cmd) {
        Err(e) if e.is_timeout() => return Err(e),
        other => other,
    };

    let (found, version, compatible) = match version_output {
        Ok(output) if !output.is_empty() => {
            let ver = agent_version_token(&output).to_string();
            let compat = version::is_agent_compatible(&ver, expected_version);
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentDeployConfig {
    /// Override the remote install path (defaults to `~/.local/bin/termihub-agent`).
    #[cfg_attr(test, ts(optional))]
    pub remote_path: Option<String>,
}

/// A host (other than the initiating desktop) connected to the agent when an
/// update is requested. Surfaced to the Update dialog so the user can see who
/// will be cut off before confirming a forced update (#1349).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
/// `RolledBack` means the new binary failed to start and the previous one was
/// restored (#5207); `OtherHostsConnected` is returned only by the update path when the
/// connected-host guard blocks an unforced update because other hosts are
/// connected. The desktop then shows the Update dialog's warning and may retry
/// via `update_agent_force`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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
        #[cfg_attr(test, ts(optional))]
        installed_path: Option<String>,
    },
    /// The new binary failed its `--version` verify, so the previous binary
    /// was moved back into place and proven to run (#5207). The update did
    /// **not** happen; the host keeps running `restored_version`.
    ///
    /// Returned only when a working previous binary existed. A first deploy of
    /// a binary that fails `--version` has nothing to restore and reports
    /// `Deployed { success: false }`; a rollback that itself fails is an error.
    #[serde(rename_all = "camelCase")]
    RolledBack {
        /// Why the new binary was rejected, for the user.
        reason: String,
        /// Version the restored previous binary reported after the restore.
        restored_version: String,
        /// Absolute path of the restored agent on the remote host.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        installed_path: Option<String>,
    },
    /// The update was blocked by the connected-host guard: other hosts are
    /// connected to the agent. The update would not cut them off — each runs its
    /// own worker, which keeps running until that host reconnects (#4037) — but
    /// the user confirms before updating under them.
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
    /// Lowercase-hex SHA-256 digest of the uploaded bytes, sent as the
    /// `expectedSha256` on `agent.request_update` so the agent re-verifies the
    /// staged binary before swapping it in (AGT-004). Empty on the Windows
    /// no-upload path (the caller falls back to an immediate deploy and never
    /// reads it).
    pub expected_sha256: String,
    /// Base64 Ed25519 signature of the uploaded binary, read from the `.sig`
    /// sidecar next to the resolved binary and sent as the `signature` on
    /// `agent.request_update` (AGT-005, #3213). `None` when the binary is
    /// unsigned (local/dev builds) — a release-built agent then refuses the
    /// update with `UPDATE_SIGNATURE_REJECTED`.
    pub signature: Option<String>,
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
    log_progress(agent_id, "connecting", "Connecting to host…", -1.0);
    // Expand `${env:…}` / `~` in host / username / key path like the agent
    // connect path does (#3661); the password stays verbatim.
    let ssh_config = config.clone().expand().to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    // 2. Detect remote arch
    bail_if_cancelled(cancel)?;
    log_progress(agent_id, "detecting", "Detecting remote system…", -1.0);
    let (remote_os, remote_arch) = detect_remote_info(&session)?;

    let arch_suffix = agent_binary::artifact_name_for_os_arch(&remote_os, &remote_arch)
        .ok_or_else(|| {
            TerminalError::RemoteError(format!(
                "Unsupported remote platform: {remote_os} {remote_arch}"
            ))
        })?;

    // 3. Resolve binary locally
    bail_if_cancelled(cancel)?;
    log_progress(agent_id, "resolving", "Resolving agent binary…", 0.1);
    let version = env!("CARGO_PKG_VERSION");
    let agent_id_owned = agent_id.to_string();
    let binary_path =
        agent_binary::resolve_agent_binary(app_handle, version, arch_suffix, move |dl, total| {
            let pct = if total > 0 {
                dl as f64 / total as f64
            } else {
                -1.0
            };
            log_progress(
                &agent_id_owned,
                "downloading",
                &format!("Downloading agent binary ({dl} bytes)…"),
                pct,
            );
        })
        .map_err(|e| TerminalError::RemoteError(format!("Failed to resolve binary: {e}")))?;

    // 4. Validate ELF architecture
    log_progress(
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

    // 5–9. Read + re-verify, upload, install, verify, resolve the install path.
    bail_if_cancelled(cancel)?;
    let progress = |step: &str, message: &str, pct: f64| {
        log_progress(agent_id, step, message, pct);
    };
    verify_and_install(
        &session,
        &remote_os,
        remote_path,
        &binary_path,
        version,
        &progress,
        cancel,
    )
}

/// Read the resolved binary, re-verify its release signature over exactly the
/// bytes to upload, then [`install_agent_bytes`] them — [`deploy_agent`] after
/// binary resolution.
///
/// The re-verification (AGT-005, #3330) runs before anything touches the host:
/// resolution already verified the file, this closes the swap window, and a
/// refused binary leaves the host unchanged. Split out so the in-process host
/// tests (#5162) can drive it without a Tauri `AppHandle`.
fn verify_and_install(
    session: &termihub_core::backends::ssh::handler::SshSession,
    remote_os: &str,
    remote_path: &str,
    binary_path: &std::path::Path,
    version: &str,
    progress: &dyn Fn(&str, &str, f64),
    cancel: Option<&CancellationToken>,
) -> Result<AgentDeployResult, TerminalError> {
    let binary_bytes = std::fs::read(binary_path)
        .map_err(|e| TerminalError::RemoteError(format!("Failed to read binary: {e}")))?;
    agent_binary::verify_deploy_bytes(binary_path, &binary_bytes, version)
        .map_err(|e| TerminalError::RemoteError(e.to_string()))?;
    install_agent_bytes(
        session,
        remote_os,
        remote_path,
        &binary_bytes,
        progress,
        cancel,
    )
}

/// Upload already-resolved agent bytes over an authenticated `session` and
/// install them — the host-side half of [`deploy_agent`] (steps after binary
/// resolution).
///
/// Picks the platform-specific [`InstallPlan`] (Windows hosts get `cmd.exe` or
/// PowerShell commands matching the detected OpenSSH `DefaultShell`; POSIX hosts
/// the `mkdir -p`/`mv -f`/`chmod` plan at `remote_path`), uploads via SFTP,
/// moves the binary into place, verifies it with `--version` and resolves the
/// absolute install path. `progress(step, message, fraction)` reports each step.
///
/// The previous working binary is copied to [`InstallPlan::backup_path`] before
/// the move and restored if the new binary fails its verify, which returns
/// [`AgentDeployResult::RolledBack`] (#5207). A leftover backup from an
/// interrupted deploy is restored first when the installed binary does not run.
///
/// Split out of [`deploy_agent`] (which needs a Tauri `AppHandle` to resolve the
/// binary and emit events) so the live Windows SSH-host lane can drive the real
/// install against a real OpenSSH server (#3684).
pub fn install_agent_bytes(
    session: &termihub_core::backends::ssh::handler::SshSession,
    remote_os: &str,
    remote_path: &str,
    binary_bytes: &[u8],
    progress: &dyn Fn(&str, &str, f64),
    cancel: Option<&CancellationToken>,
) -> Result<AgentDeployResult, TerminalError> {
    // Determine the platform-specific install plan. Windows hosts need
    // PowerShell/cmd commands and a different upload/install location; no
    // POSIX-only commands (`mkdir -p`, `mv -f`, `chmod`) are issued. POSIX hosts
    // upload into a fresh private dir, never a shared `/tmp` name (AGT2-002).
    let (plan, windows_shell): (InstallPlan, Option<agent_install::WindowsShell>) =
        if agent_binary::is_windows_os(remote_os) {
            let shell = detect_windows_shell(session);
            info!("Remote host is Windows; using {shell:?} install commands");
            (windows_install_plan(shell), Some(shell))
        } else {
            let upload_dir = prepare_posix_upload_dir(session)?;
            (posix_install_plan(remote_path, &upload_dir), None)
        };

    // Delete images an earlier update renamed aside because a running agent
    // held them, now that their processes may have exited (#5254).
    cleanup_stale_images(session, &plan);

    // Before touching anything, settle a backup left by an earlier deploy that
    // died between backup and cleanup (#5207). `previous_version` is the version
    // of the working binary now at the install path, if there is one.
    let previous_version = recover_leftover_backup(session, &plan)?;

    // Upload via SFTP.
    bail_if_cancelled(cancel)?;
    progress("uploading", "Uploading agent binary…", 0.4);
    upload_binary_or_rollback(session, binary_bytes, &plan.upload_path, cancel)?;
    info!(
        "Uploaded {} bytes to {}",
        binary_bytes.len(),
        plan.upload_path
    );

    // A cancel that landed during the upload must not leave the temp file
    // behind — roll it back before returning (G10, #1242).
    if let Err(e) = bail_if_cancelled(cancel) {
        return Err(fail_with_rollback(session, &plan.upload_path, e));
    }

    // Keep the working binary before it is overwritten, so a new binary that
    // refuses to start can be rolled back (#5207). With no working binary there
    // is nothing worth keeping. A failed backup stops the deploy: replacing the
    // only working agent without a way back is not allowed.
    progress("installing", "Installing agent binary…", 0.7);
    let backed_up = match &previous_version {
        Some(_) => {
            run_remote_command_checked(session, &plan.backup_command).map_err(|e| {
                let e = if e.is_timeout() {
                    e
                } else {
                    TerminalError::RemoteError(format!(
                        "Could not back up the installed agent before replacing it: {e}"
                    ))
                };
                fail_with_rollback(session, &plan.upload_path, e)
            })?;
            true
        }
        None => false,
    };

    // Install: create dir + move binary into place (POSIX also sets +x).
    // The exit status is checked: a failed `mkdir`/`mv` used to be ignored, so
    // the verify step ran the *previous* binary and reported its version as a
    // successful update (#5162). A failure now fails the deploy, puts the
    // backup back (a step after the move may have failed) and removes the
    // staged upload.
    if let Err(e) = run_remote_command_checked(session, &plan.install_command) {
        // Keep a timeout typed so the UI reports the frozen server (#3698).
        // The backup stays; the next deploy restores it if it is needed.
        if e.is_timeout() {
            return Err(fail_with_rollback(session, &plan.upload_path, e));
        }
        let mut msg = format!("Install command failed: {e}");
        if backed_up {
            if let Err(why) = restore_previous_binary(session, &plan) {
                msg.push_str(&failed_restore_note(
                    &why,
                    previous_version.as_deref(),
                    probe_version(session, &plan.verify_command).ok().flatten(),
                    &plan.backup_path,
                ));
            }
        }
        return Err(fail_with_rollback(
            session,
            &plan.upload_path,
            TerminalError::RemoteError(msg),
        ));
    }

    // Verify. Not cancellable: the new binary is already in place, so the
    // deploy must finish verifying it — and roll back if it does not start.
    progress("verifying", "Verifying installation…", 0.9);
    // A frozen server during verify fails the deploy with the typed timeout
    // rather than reporting "installed but --version failed" (#3698). Any
    // backup stays and the next deploy restores it if the new binary is broken.
    let installed_version = probe_version(session, &plan.verify_command)?;
    match &installed_version {
        Some(ver) => info!("Agent installed successfully: v{ver}"),
        None => warn!("Agent binary installed but --version failed or printed nothing"),
    }

    // Resolve the concrete install path. On Windows this expands
    // `%LOCALAPPDATA%`/`$env:LOCALAPPDATA` to an absolute, shell-agnostic path.
    let installed_path = match windows_shell {
        Some(shell) => run_remote_command(session, &windows_resolve_command(shell))
            .ok()
            .filter(|p| !p.is_empty())
            .or_else(|| Some(plan.install_path.clone())),
        None => Some(plan.install_path.clone()),
    };

    if installed_version.is_none() && backed_up {
        // The new binary refuses to start: put the previous one back (#5207).
        let reason = "the new agent binary failed to start (its --version check failed)";
        return match restore_previous_binary(session, &plan) {
            Ok(restored_version) => {
                warn!("Rolled back to the previous agent v{restored_version}: {reason}");
                progress(
                    "done",
                    &format!("Update rolled back — kept agent v{restored_version}"),
                    1.0,
                );
                cleanup_stale_images(session, &plan);
                Ok(AgentDeployResult::RolledBack {
                    reason: reason.to_string(),
                    restored_version,
                    installed_path,
                })
            }
            Err(why) => Err(TerminalError::RemoteError(format!(
                "{reason}, and the previous agent could not be restored ({why}). \
                 The host has no working agent; a copy of the previous binary is at {}",
                plan.backup_path
            ))),
        };
    }

    // The new binary runs (or there was no working one to keep): drop the
    // backup and any unusable leftover. A failed delete only leaves a stale
    // file that the next deploy overwrites.
    if installed_version.is_some() {
        if let Err(e) = run_remote_command_checked(session, &plan.discard_backup_command) {
            warn!(
                "Could not remove the agent backup {}: {e}",
                plan.backup_path
            );
        }
    }

    // The image the install renamed aside is free now unless a running agent
    // still holds it; a locked one is retried by the next deploy (#5254).
    cleanup_stale_images(session, &plan);

    let success = installed_version.is_some();
    progress(
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

/// Run a `--version` command and return the reported version, or `None` when
/// the binary is missing, fails or prints nothing. Only a timeout (a frozen
/// server, #3698) is an error.
fn probe_version(
    session: &termihub_core::backends::ssh::handler::SshSession,
    command: &str,
) -> Result<Option<String>, TerminalError> {
    match run_remote_command(session, command) {
        Err(e) if e.is_timeout() => Err(e),
        Ok(output) if !output.is_empty() => Ok(Some(
            output
                .strip_prefix("termihub-agent ")
                .unwrap_or(&output)
                .trim()
                .to_string(),
        )),
        Ok(_) => Ok(None),
        Err(e) => {
            debug!("`{command}` failed: {e}");
            Ok(None)
        }
    }
}

/// Settle the previous-binary backup an earlier deploy may have left behind
/// (#5207), and return the version of the working binary now at the install
/// path (`None` when there is none).
///
/// A deploy that dies between the backup and its cleanup leaves
/// [`InstallPlan::backup_path`]. If the installed binary runs, the leftover is
/// stale and is simply overwritten by the next backup. If it does not run but
/// the leftover does, the leftover is the last working agent: it is moved back
/// into place, **never deleted**. A restore that fails stops the deploy.
fn recover_leftover_backup(
    session: &termihub_core::backends::ssh::handler::SshSession,
    plan: &InstallPlan,
) -> Result<Option<String>, TerminalError> {
    if let Some(ver) = probe_version(session, &plan.verify_command)? {
        return Ok(Some(ver));
    }
    if probe_version(session, &plan.backup_verify_command)?.is_none() {
        // No working binary anywhere (a first deploy, or both broken).
        return Ok(None);
    }
    warn!(
        "Installed agent does not run but a working backup is at {}; restoring it",
        plan.backup_path
    );
    restore_previous_binary(session, plan)
        .map(Some)
        .map_err(|why| {
            TerminalError::RemoteError(format!(
                "The installed agent does not run and the backup at {} could not be \
                 restored ({why}); nothing was changed",
                plan.backup_path
            ))
        })
}

/// Delete the stale images [`InstallPlan::cleanup_stale_command`] covers
/// (Windows only, #5254). Best effort: a failure only leaves files for the next
/// deploy, so it is logged and never fails the deploy.
fn cleanup_stale_images(
    session: &termihub_core::backends::ssh::handler::SshSession,
    plan: &InstallPlan,
) {
    if let Some(command) = &plan.cleanup_stale_command {
        if let Err(e) = run_remote_command(session, command) {
            warn!("Could not clean up stale agent images: {e}");
        }
    }
}

/// The note added to "Install command failed" when the restore of the backup
/// also failed (#5254). `previous_version` is what the install path ran before
/// the deploy; `installed_version` is what it runs now (`None`: nothing runs).
///
/// An install that failed before it replaced the binary — on Windows, a running
/// agent holding the exe — leaves the previous agent where it was, so a restore
/// that cannot move the backup over it must not report the previous agent as
/// gone. Only when nothing runs at the install path does the note say so.
fn failed_restore_note(
    why: &str,
    previous_version: Option<&str>,
    installed_version: Option<String>,
    backup_path: &str,
) -> String {
    match installed_version {
        Some(ver) if previous_version == Some(ver.as_str()) => format!(
            "; the installed agent was not replaced and still runs (v{ver}); \
             the backup could not be moved back ({why}) and is kept at {backup_path}"
        ),
        Some(ver) => format!(
            "; the backup could not be moved back ({why}); the installed agent runs \
             v{ver} and a copy of the previous binary is at {backup_path}"
        ),
        None => format!(
            "; the previous agent could not be restored ({why}) and the host has no \
             working agent; a copy of the previous binary is at {backup_path}"
        ),
    }
}

/// Move the backup back over the install path and prove it runs. Returns the
/// restored version, or why the restore failed.
fn restore_previous_binary(
    session: &termihub_core::backends::ssh::handler::SshSession,
    plan: &InstallPlan,
) -> Result<String, String> {
    run_remote_command_checked(session, &plan.restore_command).map_err(|e| e.to_string())?;
    match probe_version(session, &plan.verify_command) {
        Ok(Some(ver)) => {
            info!("Restored the previous agent v{ver}");
            Ok(ver)
        }
        Ok(None) => Err("the restored binary does not run --version".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Update ─────────────────────────────────────────────────────────────

/// Update the agent: shut down the running instance, then deploy a new binary.
///
/// Unless `force` is set, a connected-host guard runs first (#1349):
/// `list_other_hosts_fn` reports the hosts — other than the initiating desktop
/// — connected to the agent, and if any are present the update is refused with
/// [`AgentDeployResult::OtherHostsConnected`] so the desktop can tell the user
/// before updating under them. `force` (from `update_agent_force`)
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
    // connected to the agent. Runs before shutdown so
    // the agent is still reachable for `agent.list_connections`.
    if !force {
        let other_hosts = list_other_hosts_fn()?;
        if let Some(blocked) = connected_host_guard(other_hosts) {
            info!(agent_id, "Update blocked: other hosts connected to agent");
            return Ok(blocked);
        }
    }

    // 1. Shut down the running agent
    log_progress(agent_id, "shutdown", "Shutting down running agent…", -1.0);
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
    log_progress(agent_id, "connecting", "Connecting to host…", -1.0);
    // Expand `${env:…}` / `~` in host / username / key path like the agent
    // connect path does (#3661); the password stays verbatim.
    let ssh_config = config.clone().expand().to_ssh_config();
    let session = connect_and_authenticate(&ssh_config)?;

    // 2. Detect remote OS/arch
    bail_if_cancelled(cancel)?;
    log_progress(agent_id, "detecting", "Detecting remote system…", -1.0);
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
            expected_sha256: String::new(),
            signature: None,
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
    log_progress(agent_id, "resolving", "Resolving agent binary…", 0.1);
    let version = env!("CARGO_PKG_VERSION");
    let agent_id_owned = agent_id.to_string();
    let binary_path =
        agent_binary::resolve_agent_binary(app_handle, version, arch_suffix, move |dl, total| {
            let pct = if total > 0 {
                dl as f64 / total as f64
            } else {
                -1.0
            };
            log_progress(
                &agent_id_owned,
                "downloading",
                &format!("Downloading agent binary ({dl} bytes)…"),
                pct,
            );
        })
        .map_err(|e| TerminalError::RemoteError(format!("Failed to resolve binary: {e}")))?;

    // 4. Validate ELF architecture (POSIX hosts only reach here)
    log_progress(
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

    // 5. Verify, then upload WITHOUT installing.
    bail_if_cancelled(cancel)?;
    stage_verified_binary(
        agent_id,
        &session,
        remote_os,
        remote_path,
        &binary_path,
        version,
        cancel,
    )
}

/// Read and verify the resolved binary, then upload it to a fresh private
/// upload dir **without installing it** — [`stage_agent_binary`] after binary
/// resolution (POSIX hosts only).
///
/// The agent's self-apply swaps the running binary from the returned path, so
/// the install command never runs and the agent is never shut down here; that
/// is the agent's job for a coordinated update. The upload dir lives inside the
/// agent's `<config>/updates` staging root, which the agent trusts and which no
/// other local user can write (AGT2-002, #4287); the agent removes it once the
/// update is applied.
///
/// The binary is read and its signature verified before the host is touched,
/// so a refused binary leaves nothing behind (not even an empty upload dir).
/// Split out so the in-process host tests (#5162) can drive it without a Tauri
/// `AppHandle`.
fn stage_verified_binary(
    agent_id: &str,
    session: &termihub_core::backends::ssh::handler::SshSession,
    remote_os: String,
    remote_path: &str,
    binary_path: &std::path::Path,
    version: &str,
    cancel: Option<&CancellationToken>,
) -> Result<StagedBinary, TerminalError> {
    let binary_bytes = std::fs::read(binary_path)
        .map_err(|e| TerminalError::RemoteError(format!("Failed to read binary: {e}")))?;
    // AGT-004: compute the SHA-256 of exactly the bytes we upload, so the agent
    // can re-verify the staged binary against it immediately before the swap.
    let expected_sha256 = agent_binary::sha256_hex_of_bytes(&binary_bytes);
    // AGT-005: verify the release signature over exactly these bytes before
    // staging them (#3330 — a release desktop never pushes an unsigned or
    // tampered binary), then forward it; the agent re-verifies it against its
    // compiled-in release key before the swap.
    agent_binary::verify_signature_for_digest(
        binary_path,
        &expected_sha256,
        &agent_binary::deploy_signature_policy(version),
    )
    .map_err(|e| TerminalError::RemoteError(e.to_string()))?;
    let signature = agent_binary::read_signature_sidecar(binary_path);

    let upload_dir = prepare_posix_upload_dir(session)?;
    let plan = posix_install_plan(remote_path, &upload_dir);
    bail_if_cancelled(cancel)?;
    log_progress(agent_id, "staging", "Staging agent binary…", 0.4);
    upload_binary_or_rollback(session, &binary_bytes, &plan.upload_path, cancel)?;
    if let Err(e) = bail_if_cancelled(cancel) {
        return Err(fail_with_rollback(session, &plan.upload_path, e));
    }
    info!(
        "Staged {} bytes to {} for coordinated update",
        binary_bytes.len(),
        plan.upload_path
    );
    log_progress(
        agent_id,
        "staged",
        "Binary staged; coordinating with connected hosts…",
        0.7,
    );

    Ok(StagedBinary {
        remote_os,
        is_windows: false,
        expected_sha256,
        signature,
        upload_path: Some(plan.upload_path),
    })
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Upload the agent binary, aborting promptly when `cancel` fires mid-transfer
/// (#4060). A failed upload — cancelled or not — rolls back the partial temp
/// file before returning, so no half-written binary lingers on the host
/// (#5162; before, only a cancel was rolled back). See [`fail_with_rollback`]
/// for how the error is reported.
fn upload_binary_or_rollback(
    session: &termihub_core::backends::ssh::handler::SshSession,
    binary_bytes: &[u8],
    upload_path: &str,
    cancel: Option<&CancellationToken>,
) -> Result<u64, TerminalError> {
    upload_bytes_via_sftp_cancellable(session, binary_bytes, upload_path, cancel)
        .map_err(|e| fail_with_rollback(session, upload_path, e))
}

/// Roll back the upload at `upload_path` after `err` failed the deploy, and
/// return the error to report.
///
/// - [`TerminalError::Cancelled`] stays `Cancelled` so the dialog reports
///   "cancelled"; a failed rollback is logged.
/// - A typed timeout (#3698) is returned as is **without** a rollback: the
///   server stopped responding, so a remove would only wait out another
///   deadline.
/// - Any other error gets the rollback outcome appended when the partial
///   upload could not be removed, so a stranded file is never silent.
fn fail_with_rollback(
    session: &termihub_core::backends::ssh::handler::SshSession,
    upload_path: &str,
    err: TerminalError,
) -> TerminalError {
    if err.is_timeout() {
        warn!("Upload to {upload_path} timed out; skipping rollback on a frozen host");
        return err;
    }
    match (rollback_partial_upload(session, upload_path), err) {
        (Ok(()), err) | (Err(_), err @ TerminalError::Cancelled) => err,
        (Err(rollback), err) => TerminalError::RemoteError(format!(
            "{err}; the partial agent upload at {upload_path} could not be removed: {rollback}"
        )),
    }
}

/// Remove a partially uploaded or staged binary after a failed deploy (G10,
/// #1242; #5162).
///
/// The upload target lives at a temp path (`plan.upload_path`, a private upload
/// dir on POSIX) that has not yet been moved into place, so removing it fully
/// rolls back the SFTP upload. A failure is logged and returned so the caller
/// can report it.
fn rollback_partial_upload(
    session: &termihub_core::backends::ssh::handler::SshSession,
    upload_path: &str,
) -> Result<(), TerminalError> {
    // SFTP remove works uniformly on POSIX and Windows hosts (the upload path is
    // a temp location that has not yet been moved into place).
    remove_via_sftp(session, upload_path)
        .inspect(|()| info!("Rolled back partial agent upload at {upload_path}"))
        .inspect_err(|e| warn!("Failed to roll back partial upload at {upload_path}: {e}"))
}

/// Trace one deploy/update step.
///
/// This used to emit an `agent-deploy-progress` event, but nothing in the
/// frontend listened for it (DEAD2-004, #4344): the Update dialog follows the
/// update through the `update_agent*` command results and the agents
/// projection region. The steps stay as log lines for diagnostics.
/// `progress` is a fraction (0.0–1.0), or -1 for indeterminate.
fn log_progress(agent_id: &str, step: &str, message: &str, progress: f64) {
    trace!(agent_id, step, progress, "agent deploy: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn failed_restore_note_keeps_an_unreplaced_agent() {
        let note = failed_restore_note("locked", Some("0.8.0"), Some("0.8.0".into()), "bak");
        assert!(
            note.contains("was not replaced and still runs (v0.8.0)"),
            "{note}"
        );
        assert!(note.contains("kept at bak"), "{note}");
        assert!(!note.contains("could not be restored"), "{note}");
        assert!(!note.contains("no working agent"), "{note}");
    }

    #[test]
    fn failed_restore_note_names_a_replaced_agent_that_runs() {
        let note = failed_restore_note("locked", Some("0.8.0"), Some("0.9.0".into()), "bak");
        assert!(note.contains("the installed agent runs v0.9.0"), "{note}");
        assert!(!note.contains("no working agent"), "{note}");
        // No previous version known (nothing ran before): a running install is
        // still named, never reported as gone.
        let note = failed_restore_note("locked", None, Some("0.9.0".into()), "bak");
        assert!(note.contains("runs v0.9.0"), "{note}");
    }

    #[test]
    fn failed_restore_note_reports_a_gone_agent_only_when_nothing_runs() {
        let note = failed_restore_note("locked", Some("0.8.0"), None, "bak");
        assert!(note.contains("could not be restored (locked)"), "{note}");
        assert!(note.contains("no working agent"), "{note}");
        assert!(note.contains("bak"), "{note}");
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
        let ver = agent_version_token(output);
        assert_eq!(ver, "0.1.0");
        assert!(version::is_agent_compatible(ver, "0.1.0"));
    }

    #[test]
    fn version_parsing_with_branch_annotation() {
        // Branch builds append "(branch: foo)" — parser must ignore it.
        let output = "termihub-agent 0.1.0 (branch: feature/666-persistent-connection-ux)";
        let ver = agent_version_token(output);
        assert_eq!(ver, "0.1.0");
        assert!(version::is_agent_compatible(ver, "0.1.0"));
    }

    #[test]
    fn version_parsing_bare() {
        let output = "0.2.0";
        let ver = agent_version_token(output);
        assert_eq!(ver, "0.2.0");
    }

    /// Regression (DUP2-010): a pre-release agent (`vX.Y.Z-beta.N` release) was
    /// reported incompatible because the old parser rejected the suffix.
    #[test]
    fn pre_release_agent_output_is_compatible() {
        let ver = agent_version_token("termihub-agent 0.2.0-beta.1");
        assert_eq!(ver, "0.2.0-beta.1");
        assert!(version::is_agent_compatible(ver, "0.2.0"));
        assert!(version::is_agent_compatible(ver, "0.2.0-beta.1"));
        assert!(!version::is_agent_compatible(ver, "0.3.0"));
    }
}

#[cfg(test)]
#[path = "agent_deploy_fake_host.rs"]
mod fake_host;

#[cfg(test)]
#[path = "agent_deploy_host_tests.rs"]
mod host_tests;
