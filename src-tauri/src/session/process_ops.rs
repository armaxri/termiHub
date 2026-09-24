//! Thin process-operations facade over a session's process-manager capability
//! (PROD-0028).
//!
//! Mirrors [`FileOps`](super::file_ops) but, because a `list_processes` /
//! `kill_process` may be a slow exec / SSH round-trip, it follows the monitoring
//! discipline (CONC-007) rather than the file-ops one: the owned
//! [`ProcessManager`] handle is cloned out from **under** the `sessions` lock,
//! the lock is released, and only then is the possibly-slow call awaited — so a
//! process refresh never stalls every other session operation.
//!
//! These are free functions rather than methods on
//! [`SessionManager`](super::manager::SessionManager) so the process feature adds
//! nothing to that file; they access the manager's `pub(super) sessions` map
//! directly (both live in the `session` module).

use std::sync::Arc;

use termihub_core::monitoring::{KillSignal, ProcessError, ProcessInfo, ProcessManager};

use super::manager::SessionManager;

/// Clone a session's process-manager handle out from under the `sessions` lock.
///
/// Returns [`ProcessError::NotSupported`] when the session exists but exposes no
/// process capability, and a [`ProcessError::ListFailed`] carrying a
/// session-not-found message when the id is unknown (the UI capability-gates, so
/// an unknown session here is a defensive backstop, not an expected path).
async fn resolve(
    manager: &SessionManager,
    session_id: &str,
) -> Result<Arc<dyn ProcessManager + Send + Sync>, ProcessError> {
    let sessions = manager.sessions.lock().await;
    let entry = sessions
        .get(session_id)
        .ok_or_else(|| ProcessError::ListFailed(format!("session {session_id} not found")))?;
    entry
        .connection
        .process_manager()
        .ok_or(ProcessError::NotSupported)
    // The lock guard drops here; the awaited call below runs lock-free.
}

/// Whether an active session can list / kill processes.
///
/// Used by `session_get_capabilities` to gate the frontend process table.
pub async fn supports_processes(manager: &SessionManager, session_id: &str) -> bool {
    let sessions = manager.sessions.lock().await;
    sessions
        .get(session_id)
        .map(|e| e.connection.process_manager().is_some())
        .unwrap_or(false)
}

/// List the top processes for a session.
pub async fn list_processes(
    manager: &SessionManager,
    session_id: &str,
) -> Result<Vec<ProcessInfo>, ProcessError> {
    let handle = resolve(manager, session_id).await?;
    handle.list_processes().await
}

/// Terminate `pid` in a session with `signal`. Targets the exact pid only.
pub async fn kill_process(
    manager: &SessionManager,
    session_id: &str,
    pid: u32,
    signal: KillSignal,
) -> Result<(), ProcessError> {
    let handle = resolve(manager, session_id).await?;
    handle.kill_process(pid, signal).await
}
