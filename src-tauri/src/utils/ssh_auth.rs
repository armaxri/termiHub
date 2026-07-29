/// SSH authentication utilities for the desktop crate.
///
/// This is a thin sync wrapper around the canonical russh-based implementation
/// in [`termihub_core::backends::ssh::auth`]. All callers receive a bare
/// [`SshSession`] (russh `Handle`); the [`ForwardedChannelRegistry`] is
/// returned separately only when remote forwarding is needed (tunnel module).
use termihub_core::backends::ssh::auth::{
    check_ssh_agent_status as core_check_agent, connect_and_authenticate as core_connect,
    connect_and_authenticate_cancellable as core_connect_cancellable,
};
pub use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, SshSession};
use tokio_util::sync::CancellationToken;

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

/// Connect and return both the session and the forwarded-channel registry,
/// abortable via a [`CancellationToken`].
///
/// Cancelling the token aborts an in-flight TCP connect / SSH handshake
/// promptly. Used by the tunnel module so a Stop click during the connecting
/// phase interrupts a hung connect instead of waiting out the connect timeout
/// or the OS TCP timeout (#841).
///
/// Same runtime-context requirement as [`connect_and_authenticate`]: call only
/// from inside `spawn_blocking` or an async task (#828).
pub fn connect_with_registry_cancellable(
    config: &SshConfig,
    cancel: CancellationToken,
) -> Result<(SshSession, ForwardedChannelRegistry), TerminalError> {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(core_connect_cancellable(config, Some(cancel)))
    })
    .map_err(|e| TerminalError::SshError(e.to_string()))
}

/// Connect and authenticate, returning just the session, abortable via a
/// [`CancellationToken`].
///
/// Like [`connect_and_authenticate`] but a fired token aborts an in-flight TCP
/// connect / SSH handshake promptly instead of waiting out the connect or OS
/// TCP timeout. Used by the agent connect path so a Cancel while connecting
/// interrupts a hung connect to an unreachable host (G1, #1235).
///
/// Same runtime-context requirement as [`connect_and_authenticate`]: call only
/// from inside `spawn_blocking` or an async task (#828).
pub fn connect_and_authenticate_cancellable(
    config: &SshConfig,
    cancel: CancellationToken,
) -> Result<SshSession, TerminalError> {
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(core_connect_cancellable(config, Some(cancel)))
    })
    .map(|(session, _registry)| session)
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
        // This is a thin delegation to the core status check, which reads the
        // env — there is no local seam to inject. `temp-env` scopes the unset to
        // the closure, restores the original afterwards, and serializes with
        // other `temp-env` users, so the process-global `SSH_AUTH_SOCK` is no
        // longer mutated in a way that races sibling tests (#2127).
        temp_env::with_var("SSH_AUTH_SOCK", None::<&str>, || {
            assert_eq!(check_ssh_agent_status(), "stopped");
        });
    }

    /// Regression guard for #828.
    ///
    /// [`connect_and_authenticate`]/[`connect_with_registry_cancellable`] run the async
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
