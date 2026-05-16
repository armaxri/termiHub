/// SSH authentication utilities for the desktop crate.
///
/// This is a thin sync wrapper around the canonical russh-based implementation
/// in [`termihub_core::backends::ssh::auth`]. All callers receive a bare
/// [`SshSession`] (russh `Handle`); the [`ForwardedChannelRegistry`] is
/// returned separately only when remote forwarding is needed (tunnel module).
use termihub_core::backends::ssh::auth::{
    check_ssh_agent_status as core_check_agent, connect_and_authenticate as core_connect,
};
pub use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, SshSession};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;

/// Connect to an SSH server and authenticate, returning the session.
///
/// Internally runs the async [`core_connect`] on the current Tokio runtime
/// via [`tokio::task::block_in_place`], so it is safe to call from both
/// Tokio worker threads (sync commands) and `spawn_blocking` threads
/// (monitoring, SFTP commands).
pub fn connect_and_authenticate(config: &SshConfig) -> Result<SshSession, TerminalError> {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(core_connect(config)))
        .map(|(session, _registry)| session)
        .map_err(|e| TerminalError::SshError(e.to_string()))
}

/// Connect and return both the session and the forwarded-channel registry.
///
/// Used by the tunnel session pool so the remote-forward tunnel can receive
/// incoming server-initiated channels.
pub fn connect_with_registry(
    config: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), TerminalError> {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(core_connect(config)))
        .map_err(|e| TerminalError::SshError(e.to_string()))
}

/// Check whether the SSH agent is running or stopped.
pub fn check_ssh_agent_status() -> String {
    core_check_agent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_ssh_agent_status_returns_valid_value() {
        let status = check_ssh_agent_status();
        assert!(
            status == "running" || status == "stopped",
            "unexpected status: {status}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn check_ssh_agent_status_stopped_when_sock_unset() {
        let orig = std::env::var("SSH_AUTH_SOCK").ok();
        // SAFETY: test-only
        unsafe { std::env::remove_var("SSH_AUTH_SOCK") };
        let status = check_ssh_agent_status();
        assert_eq!(status, "stopped");
        if let Some(val) = orig {
            unsafe { std::env::set_var("SSH_AUTH_SOCK", val) };
        }
    }
}
