//! Process list + kill for daemon-hosted sessions (#3210).
//!
//! Agent-hosted SSH, Docker and WSL sessions are persistent, so their
//! [`ConnectionType`](termihub_core::connection::ConnectionType) lives in the
//! session daemon, not in the worker. The worker therefore cannot call the
//! backend's [`ProcessManager`] directly; it asks the daemon over the frame
//! protocol instead:
//!
//! - In the connect handshake the daemon sends [`MSG_CAPABILITIES`] with
//!   [`CAP_PROCESSES`] when its backend has a process manager. A daemon started
//!   by an older agent sends nothing, so the worker never sends it a request it
//!   would silently drop.
//! - The worker sends [`MSG_PROCESS_REQUEST`] (JSON [`ProcessRequest`]) and
//!   awaits the matching [`MSG_PROCESS_RESPONSE`] (JSON [`ProcessResponse`]) by
//!   request id.
//!
//! The daemon runs every operation through the session backend's own process
//! manager, so a list or kill only ever reaches that session's remote host,
//! container or distribution. Requests arrive only from the connection that
//! currently holds the session (single-attach), and replies go only to it.
//!
//! [`MSG_CAPABILITIES`]: super::protocol::MSG_CAPABILITIES
//! [`CAP_PROCESSES`]: super::protocol::CAP_PROCESSES
//! [`MSG_PROCESS_RESPONSE`]: super::protocol::MSG_PROCESS_RESPONSE

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tracing::debug;

use termihub_core::monitoring::{KillSignal, ProcessError, ProcessInfo, ProcessManager};

use super::client::{write_frame_timed, DaemonWriterHandle};
use super::protocol::MSG_PROCESS_REQUEST;

/// Upper bound on one list / kill inside the daemon. Generous: the first
/// operation of an SSH session opens its dedicated exec connection.
pub const DAEMON_OP_TIMEOUT: Duration = Duration::from_secs(45);

/// How long the worker waits for a reply; longer than [`DAEMON_OP_TIMEOUT`] so
/// the daemon's own timeout (a typed failure) normally wins.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// A process request from the worker to the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessRequest {
    /// Correlates the reply.
    pub id: u64,
    #[serde(flatten)]
    pub op: ProcessOp,
}

/// The operation a [`ProcessRequest`] asks for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ProcessOp {
    /// List the top processes by CPU.
    List,
    /// Deliver `signal` to exactly `pid`.
    Kill { pid: u32, signal: KillSignal },
}

/// The daemon's reply to a [`ProcessRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessResponse {
    /// The request's id.
    pub id: u64,
    pub outcome: ProcessOutcome,
}

/// What a [`ProcessOp`] produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProcessOutcome {
    Listed { processes: Vec<ProcessInfo> },
    Killed,
    Failed { error: WireProcessError },
}

/// A [`ProcessError`] as it crosses the daemon socket. `ProcessError`
/// serializes as the one-way IPC envelope, so this mirror carries the variant
/// and its fields losslessly in both directions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireProcessError {
    NotSupported,
    NotFound { pid: u32 },
    PermissionDenied { message: String },
    ListFailed { message: String },
    UnsupportedSignal { signal: KillSignal, reason: String },
    KillFailed { pid: u32, message: String },
    AgentOutdated,
}

impl From<ProcessError> for WireProcessError {
    fn from(e: ProcessError) -> Self {
        match e {
            ProcessError::NotSupported => Self::NotSupported,
            ProcessError::NotFound(pid) => Self::NotFound { pid },
            ProcessError::PermissionDenied(message) => Self::PermissionDenied { message },
            ProcessError::ListFailed(message) => Self::ListFailed { message },
            ProcessError::UnsupportedSignal { signal, reason } => {
                Self::UnsupportedSignal { signal, reason }
            }
            ProcessError::KillFailed { pid, message } => Self::KillFailed { pid, message },
            ProcessError::AgentOutdated => Self::AgentOutdated,
        }
    }
}

impl From<WireProcessError> for ProcessError {
    fn from(e: WireProcessError) -> Self {
        match e {
            WireProcessError::NotSupported => Self::NotSupported,
            WireProcessError::NotFound { pid } => Self::NotFound(pid),
            WireProcessError::PermissionDenied { message } => Self::PermissionDenied(message),
            WireProcessError::ListFailed { message } => Self::ListFailed(message),
            WireProcessError::UnsupportedSignal { signal, reason } => {
                Self::UnsupportedSignal { signal, reason }
            }
            WireProcessError::KillFailed { pid, message } => Self::KillFailed { pid, message },
            WireProcessError::AgentOutdated => Self::AgentOutdated,
        }
    }
}

// ── Daemon side ─────────────────────────────────────────────────────

/// Run `op` through the session backend's process `manager`, bounded by
/// [`DAEMON_OP_TIMEOUT`]. A backend without one is [`ProcessError::NotSupported`].
pub async fn serve(
    manager: Option<&Arc<dyn ProcessManager + Send + Sync>>,
    op: ProcessOp,
) -> ProcessOutcome {
    let Some(manager) = manager else {
        return failed(ProcessError::NotSupported);
    };
    match op {
        ProcessOp::List => {
            match tokio::time::timeout(DAEMON_OP_TIMEOUT, manager.list_processes()).await {
                Ok(Ok(processes)) => ProcessOutcome::Listed { processes },
                Ok(Err(e)) => failed(e),
                Err(_) => failed(ProcessError::ListFailed(format!(
                    "timed out after {DAEMON_OP_TIMEOUT:?}"
                ))),
            }
        }
        ProcessOp::Kill { pid, signal } => {
            match tokio::time::timeout(DAEMON_OP_TIMEOUT, manager.kill_process(pid, signal)).await {
                Ok(Ok(())) => ProcessOutcome::Killed,
                Ok(Err(e)) => failed(e),
                Err(_) => failed(ProcessError::KillFailed {
                    pid,
                    message: format!("timed out after {DAEMON_OP_TIMEOUT:?}"),
                }),
            }
        }
    }
}

fn failed(e: ProcessError) -> ProcessOutcome {
    ProcessOutcome::Failed { error: e.into() }
}

// ── Worker side ─────────────────────────────────────────────────────

/// Per-client process state shared between a [`DaemonClient`], its reader
/// task and the [`DaemonProcessManager`]s handed out for it.
///
/// [`DaemonClient`]: super::client::DaemonClient
#[derive(Debug, Default)]
pub struct ProcessChannel {
    /// Whether the connected daemon advertised process support.
    supported: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<ProcessOutcome>>>,
}

impl ProcessChannel {
    /// Whether the connected daemon serves process requests.
    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::SeqCst)
    }

    /// Record the connected daemon's advertised support.
    pub fn set_supported(&self, supported: bool) {
        self.supported.store(supported, Ordering::SeqCst);
    }

    /// Reserve a request id and the receiver its reply is delivered to.
    pub fn register(&self) -> (u64, oneshot::Receiver<ProcessOutcome>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.lock().insert(id, tx);
        (id, rx)
    }

    /// Drop a request that will not be answered (failed write, timeout).
    fn forget(&self, id: u64) {
        self.lock().remove(&id);
    }

    /// Route a [`MSG_PROCESS_RESPONSE`](super::protocol::MSG_PROCESS_RESPONSE)
    /// payload to its waiter. Malformed or unknown replies are dropped.
    pub fn deliver(&self, payload: &[u8]) {
        let response: ProcessResponse = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(e) => {
                debug!("Malformed process reply from daemon: {e}");
                return;
            }
        };
        match self.lock().remove(&response.id) {
            Some(tx) => {
                let _ = tx.send(response.outcome);
            }
            None => debug!("Process reply for unknown request {}", response.id),
        }
    }

    /// Fail every pending request (the daemon connection ended or changed).
    pub fn fail_all(&self) {
        self.lock().clear();
    }

    /// Number of requests awaiting a reply.
    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<ProcessOutcome>>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// [`ProcessManager`] for a daemon-hosted session: forwards each operation to
/// the session daemon, which runs it through the session backend's own
/// process manager.
pub struct DaemonProcessManager {
    writer: DaemonWriterHandle,
    channel: Arc<ProcessChannel>,
}

impl DaemonProcessManager {
    pub fn new(writer: DaemonWriterHandle, channel: Arc<ProcessChannel>) -> Self {
        Self { writer, channel }
    }

    /// Send `op` and await its outcome. `Err` is a transport failure message.
    async fn call(&self, op: ProcessOp) -> Result<ProcessOutcome, String> {
        let (id, rx) = self.channel.register();
        let payload = serde_json::to_vec(&ProcessRequest { id, op })
            .map_err(|e| format!("encode process request: {e}"))?;
        let sent = {
            let mut guard = self.writer.lock().await;
            match guard.as_mut() {
                Some(writer) => write_frame_timed(writer, MSG_PROCESS_REQUEST, &payload)
                    .await
                    .map_err(|e| e.to_string()),
                None => Err("the session is not attached".to_string()),
            }
        };
        if let Err(e) = sent {
            self.channel.forget(id);
            return Err(e);
        }
        match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Err("the session daemon connection closed".to_string()),
            Err(_) => {
                self.channel.forget(id);
                Err(format!(
                    "no reply from the session daemon in {REPLY_TIMEOUT:?}"
                ))
            }
        }
    }
}

#[async_trait::async_trait]
impl ProcessManager for DaemonProcessManager {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        match self.call(ProcessOp::List).await {
            Ok(ProcessOutcome::Listed { processes }) => Ok(processes),
            Ok(ProcessOutcome::Failed { error }) => Err(error.into()),
            Ok(ProcessOutcome::Killed) => Err(ProcessError::ListFailed(
                "unexpected reply from the session daemon".into(),
            )),
            Err(message) => Err(ProcessError::ListFailed(message)),
        }
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        match self.call(ProcessOp::Kill { pid, signal }).await {
            Ok(ProcessOutcome::Killed) => Ok(()),
            Ok(ProcessOutcome::Failed { error }) => Err(error.into()),
            Ok(ProcessOutcome::Listed { .. }) => Err(ProcessError::KillFailed {
                pid,
                message: "unexpected reply from the session daemon".into(),
            }),
            Err(message) => Err(ProcessError::KillFailed { pid, message }),
        }
    }
}

#[cfg(test)]
mod tests;
