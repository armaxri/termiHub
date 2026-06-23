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
/// Internally runs the async [`core_connect`] on the current Tokio runtime via
/// [`tokio::task::block_in_place`] + [`tokio::runtime::Handle::current`]. **Both
/// require a multi-threaded Tokio runtime worker context on the calling thread**
/// — call this only from inside `spawn_blocking` or an async task (as the
/// monitoring/SFTP commands do). Calling it from a synchronous `#[tauri::command]`
/// (which Tauri runs on the main thread) or a raw `std::thread` aborts the whole
/// process (#828).
pub fn connect_and_authenticate(config: &SshConfig) -> Result<SshSession, TerminalError> {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(core_connect(config)))
        .map(|(session, _registry)| session)
        .map_err(|e| TerminalError::SshError(e.to_string()))
}

/// Connect and return both the session and the forwarded-channel registry.
///
/// Used by the tunnel session pool so the remote-forward tunnel can receive
/// incoming server-initiated channels.
///
/// Same runtime-context requirement as [`connect_and_authenticate`]: call only
/// from inside `spawn_blocking` or an async task, never from a synchronous
/// command thread or a raw `std::thread` (#828).
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

    /// Regression guard for #828.
    ///
    /// [`connect_and_authenticate`]/[`connect_with_registry`] run the async
    /// russh connect via `tokio::task::block_in_place` +
    /// `Handle::current().block_on(..)`. Both require a Tokio runtime context on
    /// the calling thread. A `spawn_blocking` thread carries that context; a
    /// synchronous `#[tauri::command]` (which Tauri runs on the main thread) and
    /// a raw `std::thread` do not — invoking these helpers there aborts the
    /// whole process. The fix is to drive such work from an `async` command via
    /// `spawn_blocking` (mirroring `monitoring_open`). This locks in the thread
    /// invariant the fix depends on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_helpers_require_a_runtime_context() {
        // A `spawn_blocking` thread carries the runtime context — SSH/SFTP work
        // runs here after the fix.
        let in_spawn_blocking =
            tokio::task::spawn_blocking(|| tokio::runtime::Handle::try_current().is_ok())
                .await
                .expect("spawn_blocking join");
        assert!(
            in_spawn_blocking,
            "spawn_blocking threads must carry a Tokio runtime context"
        );

        // A raw std::thread does not — this is the #828 crash path the buggy
        // sync commands hit.
        let on_raw_thread = std::thread::spawn(|| tokio::runtime::Handle::try_current().is_ok())
            .join()
            .expect("thread join");
        assert!(
            !on_raw_thread,
            "a raw std::thread must lack a Tokio runtime context"
        );
    }
}
