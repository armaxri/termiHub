//! SSH process listing + termination (PROD-0028).
//!
//! A remote host reachable over SSH is a Linux-like target, so its process
//! table and kills are gathered exactly like the SSH monitoring stats — running
//! a command over an SSH exec channel and parsing the output. The only
//! SSH-specific part is *how* the command runs; the `ps` parsing, the kill-signal
//! mapping, and the kill-result classification are all provided by the shared
//! [`ExecProcessManager`](crate::monitoring::ExecProcessManager).
//!
//! The exec channel is opened on a dedicated SSH session cached behind an
//! `Arc<Mutex<Option<…>>>` (mirroring [`SftpFileBrowser`](super::SftpFileBrowser)):
//! the first list/kill connects, and subsequent operations reuse the same
//! authenticated session so a 5-second process-table refresh does not re-run the
//! SSH handshake (and never re-prompts for credentials) each tick. A transport
//! failure drops the cached session and reconnects once.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::SshConfig;
use crate::errors::CoreError;
use crate::monitoring::{ExecProcessManager, ProcessCommandOutput, ProcessExecSource};

use super::exec::ssh_exec_with_stdin;
use super::handler::{ForwardedChannelRegistry, SshSession};
use super::jump_host::{connect_target, GatewayHold};

/// A connected SSH session for process operations, plus the resources that must
/// outlive it (the pooled jump-host gateway and forwarded-channel registry keep
/// a ProxyJump chain open, #939).
struct Connected {
    session: SshSession,
    _registry: ForwardedChannelRegistry,
    _gateway: Option<GatewayHold>,
}

/// A [`ProcessExecSource`] that runs commands over a cached SSH exec channel.
struct SshProcessExecSource {
    config: SshConfig,
    state: Arc<Mutex<Option<Connected>>>,
}

impl SshProcessExecSource {
    fn new(config: SshConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(None)),
        }
    }

    /// Establish a fresh session from the stored config.
    async fn connect(&self) -> Result<Connected, CoreError> {
        let (session, registry, gateway) = connect_target(&self.config, None).await?;
        Ok(Connected {
            session,
            _registry: registry,
            _gateway: gateway,
        })
    }
}

/// Convert a captured SSH exec result into the transport-agnostic
/// [`ProcessCommandOutput`] the shared manager classifies.
fn to_command_output(output: super::exec::SshExecOutput) -> ProcessCommandOutput {
    ProcessCommandOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_status: Some(output.exit_status),
    }
}

#[async_trait::async_trait]
impl ProcessExecSource for SshProcessExecSource {
    async fn exec(&self, command: &str) -> Result<ProcessCommandOutput, CoreError> {
        let mut guard = self.state.lock().await;

        // Connect lazily on first use so opening a session costs nothing until
        // the process table is actually opened.
        if guard.is_none() {
            *guard = Some(self.connect().await?);
        }

        // First attempt on the cached session.
        let first = match guard.as_ref() {
            Some(c) => ssh_exec_with_stdin(&c.session, command, "").await,
            None => Err(CoreError::Other("ssh process session missing".into())),
        };
        match first {
            Ok(output) => Ok(to_command_output(output)),
            Err(_transport_error) => {
                // The cached session is likely dead (idle timeout, dropped TCP).
                // Drop it and reconnect exactly once — a second failure is a real
                // error the caller surfaces honestly.
                *guard = None;
                let reconnected = self.connect().await?;
                let output = ssh_exec_with_stdin(&reconnected.session, command, "").await?;
                *guard = Some(reconnected);
                Ok(to_command_output(output))
            }
        }
    }
}

/// Build the SSH process manager for a connected host.
///
/// Called from [`Ssh::connect`](super::Ssh) with a clone of the SSH config,
/// mirroring how the monitoring provider and file browser are wired. The
/// returned manager connects lazily on the first list/kill.
pub(crate) fn ssh_process_manager(config: SshConfig) -> ExecProcessManager {
    ExecProcessManager::new(Arc::new(SshProcessExecSource::new(config)))
}
