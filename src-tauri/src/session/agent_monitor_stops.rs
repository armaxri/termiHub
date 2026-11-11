//! Deferred stops for agent-side monitoring subscriptions (#5301).
//!
//! An agent-mediated monitor ([`RemoteMonitoringProxy`]) stops in two halves:
//! the desktop half (the push task, the output route, the status-derivation
//! driver) always comes down locally, but the agent half — the agent's own
//! collect loop — only stops when the agent answers
//! `connection.monitoring.unsubscribe`. If that request fails (agent
//! unreachable, the transport mid-reconnect, a timed-out request), the agent
//! keeps polling with nothing on the desktop to see or stop it: a TCP-listen
//! agent keeps its monitoring subscriptions across a client disconnect (it only
//! detaches sessions), so the loop runs until the agent itself shuts down.
//!
//! [`defer_stop`] closes that gap: it keeps retrying the unsubscribe in the
//! background, with backoff, until the agent confirms it — or until the same
//! agent host is monitored again ([`begin_subscribe`]), at which point the new
//! subscription replaces the old one on the agent and the stop is no longer
//! wanted. A per-host gate serialises a retry's unsubscribe against a new
//! subscribe, so a late retry can never stop a monitor the user just reopened.
//!
//! The registry is process-wide because the proxies for one agent host are
//! distinct instances (each run-location open builds a fresh one) that must
//! agree on whether a stop is still owed.
//!
//! [`RemoteMonitoringProxy`]: super::remote_proxy::RemoteMonitoringProxy

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tracing::{debug, info, warn};

use termihub_core::protocol::methods::{
    MonitoringUnsubscribeParams, CONNECTION_MONITORING_UNSUBSCRIBE,
};

use crate::terminal::agent_manager::AgentRpcClient;

/// First wait before a deferred stop is retried.
const RETRY_INITIAL: Duration = Duration::from_secs(1);

/// Longest wait between two retries. A stop is retried until the agent
/// confirms it, so an agent that is offline for hours costs one failed
/// (local, instant) request every this-often — and its loop stops the moment
/// it is reachable again.
const RETRY_MAX: Duration = Duration::from_secs(30);

/// Monitoring bookkeeping of one agent host (`agent_id`, `host`).
#[derive(Default)]
struct HostState {
    /// Bumped by every [`begin_subscribe`]: a deferred stop targets the
    /// generation that was live when its unsubscribe failed, and is dropped
    /// once a newer subscription supersedes it.
    generation: AtomicU64,
    /// Held across a subscribe request and across a retry's unsubscribe
    /// request, so the two never race on the agent.
    gate: Arc<tokio::sync::Mutex<()>>,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    /// The generation a stop is still owed for, if any.
    target: Option<u64>,
    /// Whether a retry task is running for this host.
    task_running: bool,
}

type Registry = Mutex<HashMap<(String, String), Arc<HostState>>>;

static HOSTS: LazyLock<Registry> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn host_state(agent_id: &str, host: &str) -> Arc<HostState> {
    HOSTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry((agent_id.to_string(), host.to_string()))
        .or_default()
        .clone()
}

fn lock_pending(state: &HostState) -> std::sync::MutexGuard<'_, Pending> {
    state
        .pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start a new subscription on `agent_id`'s `host`: supersede any deferred
/// stop for it and return the gate guard to hold across the subscribe
/// request.
pub(crate) async fn begin_subscribe(
    agent_id: &str,
    host: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let state = host_state(agent_id, host);
    let guard = state.gate.clone().lock_owned().await;
    state.generation.fetch_add(1, Ordering::SeqCst);
    guard
}

/// Whether a stop is still owed for `agent_id`'s `host` (test observability).
#[cfg(test)]
pub(crate) fn stop_pending(agent_id: &str, host: &str) -> bool {
    lock_pending(&host_state(agent_id, host)).target.is_some()
}

/// Keep retrying `connection.monitoring.unsubscribe` for `agent_id`'s `host`
/// in the background until the agent confirms it or a newer subscription
/// supersedes it. Called after the inline unsubscribe failed. Idempotent: at
/// most one retry task runs per host.
pub(crate) fn defer_stop(agent_id: &str, host: &str, client: Arc<dyn AgentRpcClient>) {
    let state = host_state(agent_id, host);
    {
        let mut pending = lock_pending(&state);
        pending.target = Some(state.generation.load(Ordering::SeqCst));
        if pending.task_running {
            return;
        }
        pending.task_running = true;
    }
    warn!(
        agent_id,
        host, "Agent did not confirm the monitoring stop; retrying in the background"
    );
    let agent_id = agent_id.to_string();
    let host = host.to_string();
    // Not app-owned (#3105): ends once the agent confirms the stop or a new
    // subscription for the same host supersedes it.
    tokio::spawn(retry_stop(state, agent_id, host, client));
}

async fn retry_stop(
    state: Arc<HostState>,
    agent_id: String,
    host: String,
    client: Arc<dyn AgentRpcClient>,
) {
    let mut wait = RETRY_INITIAL;
    loop {
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(RETRY_MAX);

        let _gate = state.gate.lock().await;
        let current = state.generation.load(Ordering::SeqCst);
        let target = lock_pending(&state).target;
        if target != Some(current) {
            // Superseded by a newer subscription (or already satisfied).
            debug!(agent_id, host, "Deferred monitoring stop superseded");
            finish(&state);
            return;
        }

        if send_unsubscribe(&client, &agent_id, &host).await {
            info!(
                agent_id,
                host, "Agent confirmed the deferred monitoring stop"
            );
            finish(&state);
            return;
        }
        debug!(agent_id, host, "Deferred monitoring stop failed; retrying");
    }
}

/// Clear the owed stop and the running flag together, so a [`defer_stop`]
/// arriving now starts a fresh task rather than relying on this ending one.
fn finish(state: &HostState) {
    let mut pending = lock_pending(state);
    pending.target = None;
    pending.task_running = false;
}

async fn send_unsubscribe(client: &Arc<dyn AgentRpcClient>, agent_id: &str, host: &str) -> bool {
    let params = match serde_json::to_value(MonitoringUnsubscribeParams {
        host: host.to_string(),
    }) {
        Ok(params) => params,
        Err(_) => return false,
    };
    let client = client.clone();
    let agent_id = agent_id.to_string();
    tokio::task::spawn_blocking(move || {
        client.send_request(&agent_id, CONNECTION_MONITORING_UNSUBSCRIBE, params)
    })
    .await
    .map(|result| result.is_ok())
    .unwrap_or(false)
}

#[cfg(test)]
#[path = "agent_monitor_stops_tests.rs"]
mod tests;
