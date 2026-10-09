//! Post-reconnect recovery and SM-003 eviction folds for the agent manager
//! (ARCH-002 / TAURI-009 final slice, #3794).
//!
//! The backend-source `session-lifecycle` folds the agent I/O task runs around an
//! in-task transport reconnect (enter `Reconnecting`, exhausted `Failed`, the
//! post-reconnect resolve and its `SessionLost`/unconfirmed settle), the SM-003
//! eviction helpers, and the bounded post-reconnect `connection.list` probe.
//!
//! Carved verbatim out of the parent `agent_manager` module: no behaviour,
//! fold-order, channel, lock, task or timeout change.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

use termihub_core::ipc::ndjson::LineSplitter;
use termihub_core::protocol::methods::{ConnectionEvictedNotification, SessionListResult};

use super::{empty_params, read_handshake_line, serialize_request, MonitoringRoute};
use crate::session::manager::{AgentHostedSession, SessionManager};
use crate::session_projection::projection::{
    fold_agent_reconnect_failed, fold_agent_session_evicted, fold_agent_session_lost,
    fold_agent_session_recovered, fold_agent_session_unconfirmed,
    fold_agent_transport_reconnecting,
};
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};
use crate::terminal::backend::OutputSender;
use crate::terminal::jsonrpc;

/// Fold every hosted session's `session-lifecycle` region entry to `Reconnecting`
/// at the backend source on a transient agent-transport break (#2556).
///
/// The server-authoritative move of the enter fold #2555 introduced via a client
/// mirror: `agent_io_task` owns the transient break, so it folds the region itself
/// rather than the frontend `applyAgentReconnecting`. Status-only + loop-idle, so
/// the backend redrive is never armed for a transient break (the in-task loop is
/// the single owner). Off-path no-op when the `SessionManager` is not managed
/// (a headless projection unit-test app).
pub(crate) async fn fold_agent_hosted_reconnecting<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    error: Option<&str>,
) {
    let Some(manager) = app_handle.try_state::<SessionManager>() else {
        return;
    };
    for hosted in manager.agent_hosted_sessions(agent_id).await {
        fold_agent_transport_reconnecting(app_handle, &hosted.tab_id, error);
    }
}

/// Fold every hosted session's `session-lifecycle` region entry to the terminal
/// `Failed` state at the backend source when the agent's in-task reconnect loop
/// exhausts its budget (#2612/#2564). The fully-failed twin of
/// [`fold_agent_hosted_reconnecting`]: the in-task loop owns the transient break, so it
/// folds the definitive failure itself with the reconnect error rather than leaving the
/// region `Reconnecting` for the frontend `disconnected` resolver. Loop-idle, so no
/// redrive is armed for a definitively-failed session. Off-path no-op when the
/// `SessionManager` is not managed (a headless projection unit-test app).
pub(crate) async fn fold_agent_hosted_reconnect_failed<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    error: &str,
) {
    let Some(manager) = app_handle.try_state::<SessionManager>() else {
        return;
    };
    for hosted in manager.agent_hosted_sessions(agent_id).await {
        fold_agent_reconnect_failed(app_handle, &hosted.tab_id, Some(error));
    }
}

/// The agent's hosted-session identity tuples, or an empty vec when the
/// `SessionManager` is not managed (a headless projection unit-test app). Fetched
/// once per reconnect so the caller can both gate the `connection.list` round-trip
/// on there being a hosted tab to resolve and reuse the set for the region resolve
/// (#2556).
pub(super) async fn hosted_sessions_for_agent<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
) -> Vec<AgentHostedSession> {
    match app_handle.try_state::<SessionManager>() {
        Some(manager) => manager.agent_hosted_sessions(agent_id).await,
        None => Vec::new(),
    }
}

/// Resolve each hosted session's region entry after a successful in-task reconnect,
/// folded at the **backend source** rather than the frontend `TerminalView`
/// resolver:
///  - a session the agent recovered **in place** (its `remote_session_id` is in
///    `live_ids`) folds back to `Connected` — the survived-recovery half of #2556;
///  - a session the agent did **not** recover (absent from `live_ids`) folds the
///    terminal `SessionLost` state — the gone-session half (#2564). Previously this
///    was left `Reconnecting` for the frontend `TerminalView` `connected` handler to
///    resolve via `setTerminalExited`; the backend now owns the region authority so
///    the "Session lost" overlay renders straight from the region (#2512). The
///    frontend only reflects the local presentation view-state (`terminalExitedTabs`,
///    which mounts the overlay) via `settleSessionLost`, pending the full
///    view-state migration (#2139).
///
/// The fully-failed (`agent → disconnected`, the agent's in-task reconnect loop
/// exhausted) resolve is folded by its sibling [`fold_agent_hosted_reconnect_failed`]
/// (`Reconnecting → Failed`, #2612/#2564). The remaining frontend-owned piece is the
/// local terminal **view-state** (`terminalExitedTabs` / `terminalViewMode` /
/// `terminalExitInfo`), which mounts the overlay and has no server-side home until the
/// stateless-UI view-state migration (#2139); a precise follow-up carries it.
pub(crate) async fn resolve_agent_hosted_sessions<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    live_ids: &std::collections::HashSet<String>,
) {
    for h in hosted {
        if live_ids.contains(&h.remote_session_id) {
            // Guard the user-cancel race (SM-002). The agent recovered this session
            // in place, but if the user hit Stop while the transport was
            // re-establishing, `cancel_reconnect` (store.rs) has already folded the
            // tab to `Disconnected(User)` — or the tab was removed. Silently folding
            // `Connected` here would resurrect a tab the user explicitly Stopped and
            // re-adopt a session they asked to abandon. So only fold when the tab is
            // still `Reconnecting`; otherwise tear the recovered agent session down
            // instead of adopting it, mirroring the redrive create/re-attach guard
            // (`redrive.rs` `still_connecting`), so nothing outlives the cancelled tab.
            if still_reconnecting(app_handle, &h.tab_id) {
                fold_agent_session_recovered(app_handle, &h.tab_id);
            } else {
                close_abandoned_session(app_handle, h).await;
            }
        } else if !fold_agent_session_lost(app_handle, &h.tab_id) {
            // SM2-002: the tab was not awaiting recovery (the user stopped it, or
            // it already ended), so it keeps its status instead of being relabelled
            // `SessionLost`.
            close_abandoned_session(app_handle, h).await;
        }
    }
}

/// Tear down the agent session of a hosted tab that a recovery fold skipped
/// because the tab was no longer awaiting recovery (SM-002 / SM2-002, #4305).
///
/// Only a tab the user ended (`Disconnected`) or closed (no region entry) is torn
/// down, so nothing outlives the tab the user abandoned and it leaves
/// `agent_hosted_sessions` — no later transport break can find it again. Every
/// other status is left alone:
///  - `Evicted` (SM-003): the session is controlled by, or was just released by,
///    another desktop — tearing it down would kill that desktop's live process,
///    and it is never silently re-claimed either: the tab waits for a Reclaim;
///  - `Failed` / `AuthFailed` / `SessionLost`: the tab already shows its ending
///    and the user decides what happens next;
///  - `Connecting` / `Connected`: another path owns the tab now.
async fn close_abandoned_session<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &AgentHostedSession,
) {
    let status = app_handle
        .try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.status(&hosted.tab_id));
    if !matches!(status, None | Some(SessionStatus::Disconnected)) {
        return;
    }
    if let Some(manager) = app_handle.try_state::<SessionManager>() {
        let _ = manager.close_session(&hosted.session_id).await;
    }
}

/// Whether the tab is in the sticky SM-003 `Evicted` state.
pub(crate) fn is_evicted_tab<R: Runtime>(app: &AppHandle<R>, tab_id: &str) -> bool {
    app.try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.status(tab_id))
        == Some(SessionStatus::Evicted)
}

/// The remote session ids of every hosted session whose tab is `Evicted` (SM-003).
pub(super) fn evicted_remote_ids<R: Runtime>(
    app: &AppHandle<R>,
    hosted: &[AgentHostedSession],
) -> Vec<String> {
    hosted
        .iter()
        .filter(|h| is_evicted_tab(app, &h.tab_id))
        .map(|h| h.remote_session_id.clone())
        .collect()
}

/// The session ids named by `connection.evicted` notifications (SM-003).
pub(crate) fn evicted_session_ids(
    notifications: &[(String, Value)],
) -> std::collections::HashSet<String> {
    notifications
        .iter()
        .filter(|(method, _)| method == termihub_core::protocol::methods::CONNECTION_EVICTED)
        .filter_map(|(_, params)| {
            serde_json::from_value::<ConnectionEvictedNotification>(params.clone())
                .ok()
                .map(|n| n.session_id)
        })
        .collect()
}

/// Fold every hosted tab whose remote session is in `evicted` to the explicit
/// `Evicted` state (SM-003, single-attach): another desktop controls it now.
pub(crate) fn fold_evicted_hosted_sessions<R: Runtime>(
    app: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    evicted: &std::collections::HashSet<String>,
) {
    for h in hosted {
        if evicted.contains(&h.remote_session_id) {
            fold_agent_session_evicted(app, &h.tab_id);
        }
    }
}

/// Whether the tab is still in the `Reconnecting` status — the guard the agent-task
/// recover resolve uses to avoid flipping a user-Stopped tab back to `Connected`
/// (SM-002). The agent transport reconnect leaves the reconnect engine `Idle` with
/// the status `Reconnecting` (unlike the redrive's `Connecting` sub-phase), so the
/// guard keys on the status, not the engine phase. A cancelled tab has folded to
/// `Disconnected(User)` and a removed tab has no entry — both fail the check and take
/// the teardown path.
fn still_reconnecting<R: Runtime>(app: &AppHandle<R>, tab_id: &str) -> bool {
    app.try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.status(tab_id))
        == Some(SessionStatus::Reconnecting)
}

/// Resolve every hosted session's region entry after the agent's in-task transport
/// reconnect, given the post-reconnect `connection.list` result — the single point
/// that lifts a hosted tab out of `Reconnecting` (SM-001).
///
///  - `Some(live_ids)`: delegate to [`resolve_agent_hosted_sessions`] — a session the
///    agent recovered in place folds back to `Connected`, one it did not folds the
///    terminal `SessionLost` state (#2564).
///  - Either way, only a tab still `Reconnecting` is folded (SM2-002, #4305): a tab
///    the user stopped during the break, or one that already ended, keeps its
///    status, and a stopped tab's agent session is torn down.
///  - `None`: the transport came back but `connection.list` never answered within the
///    bounded retry budget, so which sessions survived cannot be confirmed. Settle
///    **every** hosted tab to the terminal `SessionLost` state via
///    [`fold_agent_session_unconfirmed`]. Leaving them `Reconnecting` here is the
///    SM-001 no-exit state: the fold keeps the reconnect loop `Idle`, the backend
///    timer arms only on `Waiting`, and no other task drives the machine — so nothing
///    would ever move the tab again except a manual Stop. Settling instead surfaces an
///    honest, actionable failure (the "session lost" overlay with a manual restart).
pub(crate) async fn resolve_hosted_sessions_after_reconnect<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    hosted: &[AgentHostedSession],
    live_ids: Option<&std::collections::HashSet<String>>,
) {
    match live_ids {
        Some(live_ids) => resolve_agent_hosted_sessions(app_handle, hosted, live_ids).await,
        None => {
            for h in hosted {
                if !fold_agent_session_unconfirmed(app_handle, &h.tab_id) {
                    // SM2-002: a tab the user stopped during the break keeps its
                    // status, and its agent session is torn down like the live
                    // branch's.
                    close_abandoned_session(app_handle, h).await;
                }
            }
        }
    }
}

/// Drop output/monitoring senders whose session id is not in `live_ids`.
///
/// Used after a successful reconnect to reconcile the I/O task's per-session
/// sender maps against the sessions the agent actually recovered, so senders
/// for sessions that did not survive the reconnect are released (G7, #1239).
pub(super) fn reconcile_output_senders(
    session_outputs: &mut HashMap<String, OutputSender>,
    monitoring_outputs: &mut HashMap<String, MonitoringRoute>,
    live_ids: &std::collections::HashSet<String>,
) {
    session_outputs.retain(|id, _| live_ids.contains(id));
    monitoring_outputs.retain(|id, _| live_ids.contains(id));
}

/// The sessions a freshly reconnected agent reports via `connection.list`.
///
/// `live` is every listed session id. `unattached` is the subset the new agent
/// worker does **not** hold (`attached: false`): since #3369 a re-launched agent
/// no longer adopts orphaned sessions at start-up — they keep running with no
/// holder until a desktop attaches. A hosted session in that set is alive but
/// streams nothing until this desktop re-attaches it (#4017).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct RecoveredSessions {
    pub(crate) live: std::collections::HashSet<String>,
    pub(crate) unattached: std::collections::HashSet<String>,
}

impl RecoveredSessions {
    /// Split a `connection.list` result into all ids and the unattached ones.
    pub(crate) fn from_list(list: SessionListResult) -> Self {
        let mut recovered = Self::default();
        for entry in list.sessions {
            if !entry.attached {
                recovered.unattached.insert(entry.session_id.clone());
            }
            recovered.live.insert(entry.session_id);
        }
        recovered
    }
}

/// Number of `connection.list` attempts after an in-task transport reconnect before
/// giving up and settling the hosted tabs (SM-001). The transport is already back, so a
/// first failure is usually transient; a small bounded retry recovers it while still
/// guaranteeing the loop always terminates.
const RECOVERY_LIST_ATTEMPTS: u32 = 3;

/// Wall-clock cap per post-reconnect `connection.list` attempt (SM-001).
/// [`list_recovered_session_ids`] reads via [`read_handshake_line`], which has **no
/// timeout of its own** — so without this a reconnected-but-unresponsive agent that never
/// answers `connection.list` would block `agent_io_task`, and every hosted tab, forever.
/// Bounding each attempt guarantees the resolve path is always reached.
const RECOVERY_LIST_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Delay between bounded `connection.list` retry attempts (SM-001).
const RECOVERY_LIST_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// Bounded, per-attempt-timed wrapper over [`list_recovered_session_ids`] (SM-001).
///
/// Retries the list up to [`RECOVERY_LIST_ATTEMPTS`] times, each attempt capped at
/// [`RECOVERY_LIST_ATTEMPT_TIMEOUT`], so a transient failure right after reconnect
/// recovers while a hung agent can never strand the task. Returns the first successful
/// list, or `None` once the budget is exhausted — the caller then settles the hosted tabs
/// to a terminal state rather than leaving them stuck `Reconnecting`.
pub(super) async fn list_recovered_session_ids_bounded(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
) -> Option<RecoveredSessions> {
    for attempt in 1..=RECOVERY_LIST_ATTEMPTS {
        match tokio::time::timeout(
            RECOVERY_LIST_ATTEMPT_TIMEOUT,
            list_recovered_session_ids(channel, agent_id, request_id),
        )
        .await
        {
            Ok(Some(ids)) => return Some(ids),
            Ok(None) => warn!(
                "Agent {}: connection.list after reconnect failed (attempt {}/{})",
                agent_id, attempt, RECOVERY_LIST_ATTEMPTS
            ),
            Err(_) => warn!(
                "Agent {}: connection.list after reconnect timed out (attempt {}/{})",
                agent_id, attempt, RECOVERY_LIST_ATTEMPTS
            ),
        }
        if attempt < RECOVERY_LIST_ATTEMPTS {
            tokio::time::sleep(RECOVERY_LIST_RETRY_DELAY).await;
        }
    }
    warn!(
        "Agent {}: connection.list unavailable after {} attempts; settling hosted sessions",
        agent_id, RECOVERY_LIST_ATTEMPTS
    );
    None
}

/// List the session ids the agent currently reports over the (freshly
/// reconnected) channel, for post-reconnect reconciliation (G7, #1239).
///
/// Sends `connection.list` and reads until the matching response arrives,
/// skipping any interleaved notifications. Returns `None` on any I/O or parse
/// failure so the caller leaves the sender maps untouched rather than dropping
/// senders it could not confirm as dead.
async fn list_recovered_session_ids(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
) -> Option<RecoveredSessions> {
    *request_id += 1;
    let req_id = *request_id;
    let line = serialize_request(
        req_id,
        termihub_core::protocol::methods::CONNECTION_LIST,
        empty_params(),
    )
    .ok()?;
    channel.data(line.as_bytes()).await.ok()?;

    const MAX_SKIPPED: u32 = 1000;
    let mut buf = LineSplitter::new();
    let mut skipped: u32 = 0;
    loop {
        let resp = read_handshake_line(channel, agent_id, &mut buf)
            .await
            .ok()?;
        match jsonrpc::parse_message(&resp) {
            Ok(jsonrpc::JsonRpcMessage::Response { id, result }) if id == req_id => {
                // Parse the reply into the shared `SessionListResult` DTO (DUP-001);
                // a malformed reply degrades to an empty id set.
                let recovered = serde_json::from_value::<SessionListResult>(result)
                    .map(RecoveredSessions::from_list)
                    .unwrap_or_default();
                return Some(recovered);
            }
            Ok(jsonrpc::JsonRpcMessage::Error { id, .. }) if id == req_id => return None,
            _ => {
                skipped += 1;
                if skipped > MAX_SKIPPED {
                    warn!(
                        "Agent {}: too many messages before connection.list response",
                        agent_id
                    );
                    return None;
                }
            }
        }
    }
}
