//! Post-reconnect re-attach of this desktop's hosted agent sessions (#4017).
//!
//! Since #3369 a freshly (re-)launched agent worker leaves every orphaned
//! daemon session **unattached** — running, listed by `connection.list` with
//! `attached: false`, but streaming to nobody until a desktop attaches it. An
//! in-task transport reconnect spawns exactly such a fresh worker, so without an
//! explicit `connection.attach` the recovered tab folded back to `Connected`
//! while its output stayed frozen (the nightly agent-reconnect grade).
//!
//! After the post-reconnect `connection.list`, the I/O task therefore sends a
//! plain (non-takeover) `connection.attach` for each hosted session the new
//! worker lists as unattached, over the raw channel before the I/O loop resumes.
//! A plain attach never takes a session away from another desktop (SM-003).

use std::collections::HashSet;

use serde_json::Value;
use tracing::{info, warn};

use termihub_core::ipc::ndjson::LineSplitter;
use termihub_core::protocol::errors::SESSION_HELD_BY_OTHER;
use termihub_core::protocol::methods::{SessionAttachParams, CONNECTION_ATTACH};

use super::recovery::{evicted_remote_ids, fold_evicted_hosted_sessions, RecoveredSessions};
use super::serialize_request;
use super::stdout_reader::{frame, read_handshake_line, Frame};
use crate::session::manager::AgentHostedSession;
use crate::terminal::jsonrpc;

/// Re-attach this desktop's unattached hosted sessions after a reconnect and
/// return the session ids to treat as recovered plus the notifications read on
/// the way. `None` in means `connection.list` never answered: nothing is
/// attached and `None` goes out, so the caller settles every hosted tab (SM-001).
///
/// A session that fails to re-attach is dropped from the recovered set, so its
/// tab settles to "session lost" instead of a silently frozen `Connected`. One
/// another desktop took meanwhile is folded `Evicted` and kept in the set, so
/// the resolve leaves it alone.
pub(crate) async fn reattach_after_reconnect<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
    line_buf: &mut LineSplitter,
    hosted: &[AgentHostedSession],
    recovered: Option<RecoveredSessions>,
) -> (Option<HashSet<String>>, Vec<(String, Value)>) {
    let Some(recovered) = recovered else {
        return (None, Vec::new());
    };
    let evicted = evicted_remote_ids(app_handle, hosted);
    let to_attach = sessions_to_reattach(hosted, &recovered, &evicted);
    let mut live = recovered.live;
    if to_attach.is_empty() {
        return (Some(live), Vec::new());
    }
    let outcome =
        reattach_hosted_sessions(channel, agent_id, request_id, line_buf, &to_attach).await;
    for id in &outcome.failed {
        live.remove(id);
    }
    fold_evicted_hosted_sessions(app_handle, hosted, &outcome.held_elsewhere);
    (Some(live), outcome.notifications)
}

/// Wall-clock cap for one post-reconnect `connection.attach`. The raw-channel
/// read has no timeout of its own, so a hung agent must not strand the task.
const REATTACH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Messages tolerated before the attach response, mirroring the list probe.
const MAX_SKIPPED: u32 = 1000;

/// The hosted sessions to re-attach: those the new worker lists as unattached,
/// excluding tabs in the SM-003 `Evicted` state (another desktop controls them;
/// only an explicit Reclaim may take them back).
pub(super) fn sessions_to_reattach(
    hosted: &[AgentHostedSession],
    recovered: &RecoveredSessions,
    evicted_remote: &[String],
) -> Vec<String> {
    let mut seen = HashSet::new();
    hosted
        .iter()
        .map(|h| h.remote_session_id.clone())
        .filter(|id| recovered.unattached.contains(id) && !evicted_remote.contains(id))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// What the post-reconnect re-attach achieved.
#[derive(Debug, Default)]
pub(super) struct ReattachOutcome {
    /// Sessions that could not be re-attached (error, timeout or I/O failure):
    /// the caller treats them as not recovered, so their tabs settle honestly.
    pub(super) failed: HashSet<String>,
    /// Sessions another desktop took in the meantime (`SESSION_HELD_BY_OTHER`):
    /// alive elsewhere, so the caller folds their tabs `Evicted`.
    pub(super) held_elsewhere: HashSet<String>,
    /// Notifications read while waiting for the attach responses — typically the
    /// re-attached session's buffered output — for the caller to dispatch.
    pub(super) notifications: Vec<(String, Value)>,
}

/// How one attach response was classified.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AttachReply {
    Attached,
    HeldElsewhere,
    Failed,
}

/// Classify the response to attach request `req_id`, or `None` when `message`
/// is not that response.
pub(super) fn classify_attach_reply(
    message: &jsonrpc::JsonRpcMessage,
    req_id: u64,
) -> Option<AttachReply> {
    match message {
        jsonrpc::JsonRpcMessage::Response { id, .. } if *id == req_id => {
            Some(AttachReply::Attached)
        }
        jsonrpc::JsonRpcMessage::Error { id, code, .. } if *id == req_id => {
            Some(if *code == Some(SESSION_HELD_BY_OTHER) {
                AttachReply::HeldElsewhere
            } else {
                AttachReply::Failed
            })
        }
        _ => None,
    }
}

/// Re-attach each of `session_ids` over the freshly reconnected `channel`.
///
/// `line_buf` is the I/O task's line buffer: bytes read past an attach response
/// stay in it so the resumed I/O loop continues from a line boundary, and any
/// complete notification lines are collected into the outcome rather than lost.
pub(super) async fn reattach_hosted_sessions(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
    line_buf: &mut LineSplitter,
    session_ids: &[String],
) -> ReattachOutcome {
    let mut outcome = ReattachOutcome::default();
    for session_id in session_ids {
        let reply = tokio::time::timeout(
            REATTACH_TIMEOUT,
            attach_one(
                channel,
                agent_id,
                request_id,
                line_buf,
                session_id,
                &mut outcome.notifications,
            ),
        )
        .await
        .unwrap_or_else(|_| {
            warn!("Agent {agent_id}: connection.attach for {session_id} timed out after reconnect");
            AttachReply::Failed
        });
        match reply {
            AttachReply::Attached => {
                info!("Agent {agent_id}: re-attached session {session_id} after reconnect");
            }
            AttachReply::HeldElsewhere => {
                info!("Agent {agent_id}: session {session_id} is held by another desktop");
                outcome.held_elsewhere.insert(session_id.clone());
            }
            AttachReply::Failed => {
                warn!("Agent {agent_id}: could not re-attach session {session_id}");
                outcome.failed.insert(session_id.clone());
            }
        }
    }
    drain_complete_lines(agent_id, line_buf, &mut outcome.notifications);
    outcome
}

/// Send one plain `connection.attach` and read until its response.
async fn attach_one(
    channel: &mut russh::Channel<russh::client::Msg>,
    agent_id: &str,
    request_id: &mut u64,
    line_buf: &mut LineSplitter,
    session_id: &str,
    notifications: &mut Vec<(String, Value)>,
) -> AttachReply {
    *request_id += 1;
    let req_id = *request_id;
    let params = SessionAttachParams {
        session_id: session_id.to_string(),
        takeover: false,
    };
    let Ok(params) = serde_json::to_value(params) else {
        return AttachReply::Failed;
    };
    let Ok(line) = serialize_request(req_id, CONNECTION_ATTACH, params) else {
        return AttachReply::Failed;
    };
    if channel.data(line.as_bytes()).await.is_err() {
        return AttachReply::Failed;
    }
    let mut skipped: u32 = 0;
    loop {
        let Ok(line) = read_handshake_line(channel, agent_id, line_buf).await else {
            return AttachReply::Failed;
        };
        let Ok(message) = jsonrpc::parse_message(&line) else {
            continue;
        };
        if let Some(reply) = classify_attach_reply(&message, req_id) {
            return reply;
        }
        if let jsonrpc::JsonRpcMessage::Notification { method, params } = message {
            notifications.push((method, params));
        }
        skipped += 1;
        if skipped > MAX_SKIPPED {
            warn!("Agent {agent_id}: too many messages before connection.attach response");
            return AttachReply::Failed;
        }
    }
}

/// Move every complete notification line out of `line_buf`, leaving only a
/// trailing partial line for the resumed I/O loop to finish.
///
/// Stops at an over-cap line: the splitter then discards the rest of it, so
/// the resumed I/O loop starts at the next line boundary (the frame error is
/// logged by [`frame`]). In practice this cannot occur here: every chunk was
/// pushed by [`read_handshake_line`], which rejects an over-cap line itself.
pub(super) fn drain_complete_lines(
    agent_id: &str,
    line_buf: &mut LineSplitter,
    notifications: &mut Vec<(String, Value)>,
) {
    while let Some(item) = line_buf.next_line() {
        let line = match frame(agent_id, item) {
            Frame::Line(line) => line,
            Frame::Skip => continue,
            Frame::Fatal(_) => break,
        };
        if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
            jsonrpc::parse_message(&line)
        {
            notifications.push((method, params));
        }
    }
}

#[cfg(test)]
#[path = "reattach_tests.rs"]
mod tests;
