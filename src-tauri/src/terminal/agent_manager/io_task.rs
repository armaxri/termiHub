//! The per-agent async I/O task (ARCH-002 / TAURI-009 final slice, #3794).
//!
//! [`agent_io_task`] owns one agent's russh session and channel: it routes
//! JSON-RPC responses and notifications, serves the manager's
//! [`AgentIoCommand`]s, and drives the in-task transport reconnect (enter fold,
//! [`reconnect_agent`], eviction fold, post-reconnect resolve, backlog replay).
//! The reconnect-backlog filter, the test-only transport sever and the
//! reconnect-lifecycle log vocabulary live beside it.
//!
//! Carved verbatim out of the parent `agent_manager` module. Since #3018 the
//! command path is bounded and prioritized through [`IoLanes`] (see
//! [`super::io_lanes`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::Engine;
use russh::ChannelMsg;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
use termihub_core::ipc::ndjson::LineSplitter;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tracing::{error, info, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::protocol::methods::{
    AgentForwardCloseParams, AgentForwardDataParams, SessionInputParams, SessionResizeParams,
};

use super::agent_stderr::AgentStderr;
use super::files_only::FilesOnlyRoutes;
use super::io_lanes::{AgentIoSender, CloseBudgetOnDrop, IoBudget, IoLanes, Next};
use super::stdout_reader::{frame, Frame};
use super::{
    dispatch_agent_notification, emit_agent_state, emit_agent_state_with_error, evicted_remote_ids,
    evicted_session_ids, fold_agent_hosted_reconnect_failed, fold_agent_hosted_reconnecting,
    fold_evicted_hosted_sessions, handle_agent_forward_notification, hosted_sessions_for_agent,
    list_recovered_session_ids_bounded, reattach_after_reconnect, reconcile_output_senders,
    reconnect_agent, resolve_hosted_sessions_after_reconnect, route_tool_run_notification,
    AgentIoCommand, AgentReaper, AgentRpcFailure, MonitoringRoute, ToolRunSender,
};
use super::{reap_agent, serialize_ki_respond, serialize_request};
use crate::connection::config::AgentSettings;
use crate::terminal::agent_forward::DesktopAgentForward;
use crate::terminal::agent_ki_prompt::{AgentKiPromptRelay, AgentPromptActivity};
use crate::terminal::agent_update_auth::read_update_auth_token;
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
use crate::terminal::jsonrpc;

// ── Async I/O task ───────────────────────────────────────────────────

/// TEST-ONLY (#2573): abruptly sever a desktop russh agent transport in-process
/// by dropping its channel and session handle.
///
/// Dropping both ends the russh session background task, which closes the
/// underlying TCP socket **without** a clean SSH disconnect — so the peer's sshd
/// handler sees an abrupt EOF/RST, exactly what a real transport loss produces.
/// This is the deterministic, cross-platform sever primitive the agent-reconnect
/// harness drives: no sshd kill, no `lsof`, no process-title matching, no root.
///
/// Shared by [`agent_io_task`]'s `TestSeverTransport` handling (the shipped path,
/// reached via [`AgentConnectionManager::test_sever_transport`]) and the real-sshd
/// reconnect integration tests, so both exercise the identical sever operation.
pub(super) fn test_sever_desktop_transport(
    channel: russh::Channel<russh::client::Msg>,
    session: Option<SshSession>,
) {
    drop(channel);
    drop(session);
}

/// Decide which queued I/O commands survive an agent reconnect (CONC-014).
///
/// While the transport is down the I/O task cannot drain its command channel, so
/// input/resize/control commands issued during the outage buffer up. Replaying
/// buffered terminal **input** into the freshly recovered session is a
/// correctness/safety hazard — stale keystrokes would land in a remote shell the
/// user saw as disconnected — so `SessionInput` is dropped outright. `SessionResize`
/// is coalesced to the latest dimensions per session so the recovered PTY is sized
/// correctly without replaying every intermediate drag. Every other command
/// (registrations, requests, agent-forward, disconnect) is control and is preserved
/// in its original order. The send-side gate (`send_session_input` while
/// `reconnecting`) already drops the bulk of the input; this handles the residue
/// that slipped in before the flag was set and enforces the resize policy.
pub(super) fn filter_reconnect_backlog(drained: Vec<AgentIoCommand>) -> Vec<AgentIoCommand> {
    let mut kept: Vec<AgentIoCommand> = Vec::new();
    // Latest resize per session, tracked in first-seen order for determinism.
    let mut resize_order: Vec<String> = Vec::new();
    let mut latest_resize: HashMap<String, (u16, u16)> = HashMap::new();
    for cmd in drained {
        match cmd {
            AgentIoCommand::SessionInput { .. } => {
                // Stale keystrokes — never replay into the recovered session.
            }
            AgentIoCommand::KiRespond { .. } => {
                // An answer for a round of the dropped agent connection: that
                // round is gone, and secrets are never replayed (#3375).
            }
            AgentIoCommand::SessionResize {
                session_id,
                cols,
                rows,
            } => {
                if !latest_resize.contains_key(&session_id) {
                    resize_order.push(session_id.clone());
                }
                latest_resize.insert(session_id, (cols, rows));
            }
            other => kept.push(other),
        }
    }
    for session_id in resize_order {
        if let Some((cols, rows)) = latest_resize.remove(&session_id) {
            kept.push(AgentIoCommand::SessionResize {
                session_id,
                cols,
                rows,
            });
        }
    }
    kept
}

/// Structured reconnect-lifecycle log vocabulary (OBS-004).
///
/// Each line carries `agent_id` (and the failure `error`) as a `tracing`
/// **field** rather than interpolating it into the message, so a supporter can
/// filter `termihub.log` by agent across a reconnect. The enclosing
/// [`agent_io_task`] span already scopes these to one agent; the explicit field
/// keeps each line self-describing when read in isolation.
pub(super) fn log_agent_connection_lost(agent_id: &str) {
    info!(agent_id = %agent_id, "connection lost, attempting reconnect");
}

pub(super) fn log_agent_reconnected(agent_id: &str) {
    info!(agent_id = %agent_id, "reconnected successfully");
}

pub(super) fn log_agent_reconnect_failed(agent_id: &str, error: &str) {
    error!(agent_id = %agent_id, error, "reconnection failed");
}

/// Settle an agent whose in-task reconnect budget is exhausted.
///
/// Order matters (CONC2-005, #4304): `alive` goes `false` **first**, so no
/// observer of the hosted tabs' `Failed` fold or of the `disconnected` event can
/// still read the agent as connected, nor route new work to it. Then:
///
/// * #2612/#2564: every hosted session's `session-lifecycle` region entry folds
///   `Reconnecting → Failed` at the backend source with the reconnect error, the
///   same authority the "Reconnect failed" overlay reads, rather than leaving it
///   stuck `Reconnecting` for the frontend `disconnected` handler to resolve.
///   Folded before the agent-state event so the overlay / tab-dot readers see
///   the failed region.
/// * the agent-state event announces `disconnected` with the error;
/// * G6 (#1239): the task self-reaps its own map entry — and only its own, see
///   [`reap_agent`] — instead of leaving a zombie for lazy eviction on the next
///   `connect_agent`.
pub(super) async fn give_up_after_exhausted_reconnect<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    alive: &Arc<AtomicBool>,
    reaper: &AgentReaper,
    error: &str,
) {
    alive.store(false, Ordering::SeqCst);
    fold_agent_hosted_reconnect_failed(app_handle, agent_id, error).await;
    emit_agent_state_with_error(app_handle, agent_id, "disconnected", Some(error));
    reap_agent(reaper, agent_id, alive);
}

/// Drive one agent's live I/O and reconnect loop.
///
/// Owns the russh `SshSession` and `Channel` exclusively. Concurrently polls
/// incoming SSH data and outgoing commands using `tokio::select!`. Routes
/// JSON-RPC responses to waiting callers and notifications to registered
/// session output channels.
///
/// Wrapped in an `agent_io` span (OBS-004) keyed by `agent_id`, so every nested
/// log event — handshake, parse errors, reconnect attempts — is groupable and
/// filterable by the agent it belongs to when a `termihub.log` interleaves many
/// concurrent agents.
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip_all, fields(agent_id = %agent_id))]
pub(super) async fn agent_io_task<R: Runtime>(
    session: SshSession,
    mut channel: russh::Channel<russh::client::Msg>,
    command_rx: UnboundedReceiver<AgentIoCommand>,
    command_tx: UnboundedSender<AgentIoCommand>,
    io_budget: Arc<IoBudget>,
    alive: Arc<AtomicBool>,
    reconnecting: Arc<AtomicBool>,
    app_handle: AppHandle<R>,
    agent_id: String,
    config: RemoteAgentConfig,
    agent_settings: AgentSettings,
    mut request_id: u64,
    reaper: AgentReaper,
    pending_notifications: Vec<(String, Value)>,
    ki_activity: Arc<AgentPromptActivity>,
    update_auth_token_path: Option<String>,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    // #3018: however this task ends — return, panic or a teardown abort — fail
    // every producer still waiting for data credit, so none waits forever.
    let _close_budget = CloseBudgetOnDrop(io_budget.clone());
    // Control commands are served ahead of queued data; gated data holds its
    // credit until written (see `io_lanes`).
    let mut lanes = IoLanes::new(command_rx, io_budget.clone());
    // The gated sender the ssh-agent relay's pump tasks use (#1727). They run
    // as their own tasks, so awaiting credit there never blocks this loop.
    let relay_tx = AgentIoSender::new(command_tx.clone(), io_budget.clone(), reconnecting.clone());
    // AGT-003 (#3213): refreshed from every (re)connect's `initialize`, since a
    // re-launched agent is a new instance with a new token file.
    let mut update_auth_token_path = update_auth_token_path;
    // Agent stdout framing (#4303): capped, UTF-8-safe, linear.
    let mut line_buf = LineSplitter::new();
    // The agent's stderr side-band: framed log records re-emitted at their
    // real level/target, anything else passed through as `WARN` (#2854).
    let mut agent_stderr = AgentStderr::new(agent_id.clone());
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    // Files-only agent sessions (#4081): remote session id → its proxy's watch.
    let mut files_only_routes = FilesOnlyRoutes::default();
    // Streaming tool runs (#3353): run id → where its notifications go.
    let mut tool_runs: HashMap<String, ToolRunSender> = HashMap::new();
    let mut pending_responses: HashMap<u64, oneshot::Sender<Result<Value, AgentRpcFailure>>> =
        HashMap::new();
    // Desktop end of the ssh-agent relay (#1727): bridges forwarded ssh-agent
    // streams the agent opens to the operator's own local agent.
    let agent_forward = DesktopAgentForward::new();
    // Agent-relayed SSH keyboard-interactive prompts (#3375): shown with the
    // same dialog as a direct connection, labelled "via <agent host>".
    let ki_relay = {
        let command_tx = command_tx.clone();
        AgentKiPromptRelay::new(
            config.host.clone(),
            termihub_core::backends::ssh::keyboard_interactive::keyboard_interactive_prompter(),
            Arc::new(move |request_id, responses| {
                let _ = command_tx.send(AgentIoCommand::KiRespond {
                    request_id,
                    responses,
                });
            }),
            ki_activity,
        )
    };
    let mut connection_error: Option<String> = None;

    // Replay notifications that arrived during the `initialize` handshake before
    // entering the live loop (#1660). Agent-level notices (`agent.update_*`) go
    // straight to the frontend; session/monitoring notifications route through
    // the (as-yet-empty) sender maps and are no-ops until a session registers,
    // matching how a post-init notification for an unknown session behaves.
    for (method, params) in &pending_notifications {
        dispatch_agent_notification(
            &app_handle,
            &agent_id,
            method,
            params,
            &session_outputs,
            &monitoring_outputs,
            &mut files_only_routes,
            &b64,
        );
    }

    // Keep the current session handle alive. On reconnect this is replaced so
    // the old session is dropped and the new one is held for the next loop iteration.
    let mut current_session: Option<SshSession> = Some(session);

    // TEST-ONLY (#2573): set when a `TestSeverTransport` command broke the inner
    // loop, so the reconnect path knows to drop the transport eagerly (a real
    // break has already closed the socket). Never set on the production path.
    let mut test_severed = false;

    'outer: loop {
        // connection_broken is true when we need to reconnect.
        let connection_broken = loop {
            tokio::select! {
                biased;

                // 1. Process incoming commands: control first, then the oldest
                //    queued data (#3018).
                next = lanes.next_command() => {
                    // `_credit` returns the data command's budget once this arm
                    // has written it (dropped at the end of the arm, or on any
                    // early exit from it).
                    let (cmd, _credit) = match next {
                        Next::Control(c) => (c, None),
                        Next::Data(c, credit) => (c, Some(credit)),
                        Next::Closed => {
                            // Sender dropped — clean shutdown
                            alive.store(false, Ordering::SeqCst);
                            return;
                        }
                    };
                    match cmd {
                        AgentIoCommand::ReadUpdateAuthToken { reply } => {
                            let token = match (current_session.as_ref(), update_auth_token_path.as_deref()) {
                                (Some(session), Some(path)) => read_update_auth_token(session, path).await,
                                _ => None,
                            };
                            let _ = reply.send(token);
                        }
                        AgentIoCommand::Request { method, params, response_tx } => {
                            request_id += 1;
                            match serialize_request(request_id, &method, params) {
                                Ok(line) => {
                                    if let Err(e) = channel.data(line.as_bytes()).await {
                                        let _ = response_tx
                                            .send(Err(AgentRpcFailure::transport_closed(format!("Write failed: {}", e))));
                                    } else {
                                        pending_responses.insert(request_id, response_tx);
                                    }
                                }
                                Err(e) => {
                                    let _ = response_tx.send(Err(e.into()));
                                }
                            }
                        }
                        AgentIoCommand::SessionInput { session_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            // DUP-001: build the request from the shared param DTO.
                            if let Ok(params) = serde_json::to_value(SessionInputParams {
                                session_id,
                                data: encoded,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::CONNECTION_WRITE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::SessionResize { session_id, cols, rows } => {
                            request_id += 1;
                            if let Ok(params) = serde_json::to_value(SessionResizeParams {
                                session_id,
                                cols,
                                rows,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::CONNECTION_RESIZE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::AgentForwardData { stream_id, data } => {
                            request_id += 1;
                            let encoded = b64.encode(&data);
                            if let Ok(params) = serde_json::to_value(AgentForwardDataParams {
                                stream_id,
                                data: encoded,
                            }) {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::AGENT_FORWARD_DATA,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::KiRespond { request_id: round_id, responses } => {
                            request_id += 1;
                            if let Some(line) =
                                serialize_ki_respond(request_id, &round_id, responses.as_deref())
                            {
                                // Never logged; the line is wiped once written.
                                let _ = channel.data(line.as_bytes()).await;
                            }
                        }
                        AgentIoCommand::AgentForwardClose { stream_id } => {
                            request_id += 1;
                            if let Ok(params) =
                                serde_json::to_value(AgentForwardCloseParams { stream_id })
                            {
                                if let Ok(line) = serialize_request(
                                    request_id,
                                    termihub_core::protocol::methods::AGENT_FORWARD_CLOSE,
                                    params,
                                ) {
                                    let _ = channel.data(line.as_bytes()).await;
                                }
                            }
                        }
                        AgentIoCommand::RegisterSession { session_id, output_tx } => {
                            session_outputs.insert(session_id, output_tx);
                        }
                        AgentIoCommand::UnregisterSession { session_id } => {
                            session_outputs.remove(&session_id);
                            files_only_routes.remove(&session_id);
                        }
                        AgentIoCommand::RegisterFilesOnly { session_id, files_only_tx } => {
                            files_only_routes.register(session_id, files_only_tx);
                        }
                        AgentIoCommand::RegisterMonitoring { session_id, monitoring_tx } => {
                            monitoring_outputs.insert(session_id, monitoring_tx.into());
                        }
                        AgentIoCommand::RegisterMonitoringStatus { session_id, status_tx } => {
                            if let Some(route) = monitoring_outputs.get_mut(&session_id) {
                                route.status = Some(status_tx);
                            }
                        }
                        AgentIoCommand::UnregisterMonitoring { session_id } => {
                            monitoring_outputs.remove(&session_id);
                        }
                        AgentIoCommand::RegisterForwardStream { stream_id, sink } => {
                            agent_forward.register_stream(stream_id, sink);
                        }
                        AgentIoCommand::UnregisterForwardStream { stream_id } => {
                            agent_forward.on_close(&stream_id);
                        }
                        AgentIoCommand::RegisterToolRun { run_id, tx } => {
                            tool_runs.insert(run_id, tx);
                        }
                        AgentIoCommand::UnregisterToolRun { run_id } => {
                            tool_runs.remove(&run_id);
                        }
                        AgentIoCommand::Disconnect => {
                            alive.store(false, Ordering::SeqCst);
                            return;
                        }
                        AgentIoCommand::TestSeverTransport => {
                            // TEST-ONLY (#2573): model an abrupt transport loss.
                            // Flag it, record the cause, and break into the same
                            // reconnect path a real EOF takes; the transport is
                            // dropped eagerly just below so the peer sees the break
                            // at once.
                            info!("test-only in-process transport sever");
                            test_severed = true;
                            connection_error =
                                Some("test-only in-process transport sever (#2573)".to_string());
                            break true;
                        }
                    }
                }

                // 2. Poll incoming SSH channel data
                msg = channel.wait() => {
                    match msg {
                        None => {
                            // Channel closed cleanly
                            break true;
                        }
                        Some(ChannelMsg::Data { ref data }) => {
                            // Process all complete newline-delimited JSON lines
                            let mut frame_error = None;
                            for item in line_buf.push(data) {
                                let line = match frame(&agent_id, item) {
                                    Frame::Line(line) => line,
                                    Frame::Skip => continue,
                                    Frame::Fatal(e) => {
                                        frame_error = Some(e);
                                        break;
                                    }
                                };

                                match jsonrpc::parse_message(&line) {
                                    Ok(jsonrpc::JsonRpcMessage::Response { id, result }) => {
                                        if let Some(tx) = pending_responses.remove(&id) {
                                            let _ = tx.send(Ok(result));
                                        }
                                    }
                                    Ok(jsonrpc::JsonRpcMessage::Error {
                                        id,
                                        code,
                                        message,
                                        data,
                                    }) => {
                                        if let Some(tx) = pending_responses.remove(&id) {
                                            let _ = tx.send(Err(AgentRpcFailure::from_error_response(
                                                code,
                                                message,
                                                data.as_ref(),
                                            )));
                                        }
                                    }
                                    Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) => {
                                        // The ssh-agent relay's streams (#1727)
                                        // route to the desktop's local agent, not
                                        // to a session output channel.
                                        if !ki_relay.handle_notification(&method, &params)
                                            && !handle_agent_forward_notification(
                                            &agent_forward,
                                            &relay_tx,
                                            &method,
                                            &params,
                                            &b64,
                                        ) && !route_tool_run_notification(
                                            &mut tool_runs,
                                            &method,
                                            &params,
                                        ) {
                                            dispatch_agent_notification(
                                                &app_handle,
                                                &agent_id,
                                                &method,
                                                &params,
                                                &session_outputs,
                                                &monitoring_outputs,
                                                &mut files_only_routes,
                                                &b64,
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "failed to parse agent message");
                                    }
                                }
                            }
                            if let Some(e) = frame_error {
                                // An over-cap stdout line (#4303): the agent is
                                // broken or hostile. Drop this transport the
                                // way a lost one is dropped (already logged by
                                // `frame`).
                                connection_error = Some(e.to_string());
                                break true;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                            // stderr from the remote agent process (SSH_EXTENDED_DATA_STDERR = 1):
                            // framed log records re-emitted at their real level (#2854).
                            agent_stderr.push(data);
                        }
                        Some(ChannelMsg::Eof) => {
                            // Remote side sent EOF — connection is gone
                            break true;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            if exit_status != 0 {
                                let msg = format!("Agent process exited with status {}", exit_status);
                                error!(exit_status, "agent process exited with nonzero status");
                                connection_error = Some(msg);
                            }
                            break true;
                        }
                        _ => {}
                    }
                }
            }
        };

        if !connection_broken {
            break;
        }

        // The agent that asked for these answers is gone; close their dialogs
        // (a reconnected agent re-asks if its connect is still running, #3375).
        ki_relay.cancel_all();

        // The agent cancels a connection's streaming tool runs when it drops
        // (#3353), so none survives into the reconnected session. Drop every
        // route: each run's receiver sees its channel close and fails the run.
        tool_runs.clear();
        // Likewise every relayed stream (#3241): the agent's end died with the
        // transport, so each desktop port forward sees its stream end and its
        // graphical session re-dials through a fresh one once the agent is back.
        agent_forward.clear();

        // CONC-014: the transport is down and this task will not drain `command_rx`
        // again until the reconnect resolves. Flag it so `send_session_input` drops
        // terminal input at the source for the duration of the outage rather than
        // letting it pile up unbounded and replay stale keystrokes into the
        // recovered session. Cleared after the post-reconnect backlog is filtered
        // below (or left set on the failure path, where the entry is reaped anyway).
        reconnecting.store(true, Ordering::SeqCst);
        // #3018: wake every producer waiting for data credit so it sees the
        // outage and gives up (input is dropped per CONC-014) instead of parking
        // its caller for the whole reconnect window.
        io_budget.interrupt();

        // TEST-ONLY (#2573): a synthetic in-process sever breaks the inner loop
        // without the socket having died, so release the desktop russh transport
        // eagerly — the peer's sshd handler then sees the abrupt EOF at once,
        // faithfully modelling a real drop, before we re-establish below. `channel`
        // is moved out here and reassigned on a successful reconnect; on the Err
        // path the task returns without touching it again. A real transport break
        // leaves `test_severed` false, so this path is inert in production.
        if test_severed {
            test_severed = false;
            test_sever_desktop_transport(channel, current_session.take());
        }

        // Connection lost — try to reconnect. Fold every hosted session's
        // `session-lifecycle` region entry to `Reconnecting` at the source (#2556):
        // the in-task loop owns this transient break, so it folds the region itself
        // (status-only, redrive never armed) rather than relying on the frontend
        // `applyAgentReconnecting` client mirror. Folded before the agent-state
        // event so the overlay/tab-dot readers see the reconnecting region.
        fold_agent_hosted_reconnecting(&app_handle, &agent_id, connection_error.as_deref()).await;
        emit_agent_state_with_error(
            &app_handle,
            &agent_id,
            "reconnecting",
            connection_error.as_deref(),
        );
        log_agent_connection_lost(&agent_id);

        // CONC-003: fail every in-flight request the moment the link drops, so
        // its caller (and the `spawn_blocking` thread it pins) unblocks now
        // rather than parking for the entire reconnect window. New requests
        // issued during the outage are bounded separately by the
        // `AGENT_REQUEST_TIMEOUT` in `send_request`. The reconnect-resolved
        // drains below then run against an already-empty map (the io_task does
        // not touch `command_rx`/`pending_responses` while reconnecting).
        for (_, tx) in pending_responses.drain() {
            let _ = tx.send(Err(AgentRpcFailure::transport_closed(
                "Agent connection lost",
            )));
        }

        match reconnect_agent(&config, &agent_settings, &mut request_id, &alive).await {
            Ok((new_session, new_channel, reconnect_notifications, new_token_path)) => {
                update_auth_token_path = new_token_path;
                // Replace the current session handle with the new one.
                // This drops the old (broken) session and keeps the new one alive
                // for the next iteration of the outer loop.
                current_session = Some(new_session);
                channel = new_channel;
                line_buf.clear();
                // A partial stderr line belongs to the dropped agent process.
                agent_stderr.flush();
                connection_error = None;

                // Replay any notifications the agent emitted before answering
                // `initialize` on this reconnect (#1660). Sessions are already
                // registered here, so a buffered `connection.output` routes to
                // its channel and an `agent.update_*` notice reaches the frontend.
                for (method, params) in &reconnect_notifications {
                    dispatch_agent_notification(
                        &app_handle,
                        &agent_id,
                        method,
                        params,
                        &session_outputs,
                        &monitoring_outputs,
                        &mut files_only_routes,
                        &b64,
                    );
                }

                // G7 (#1239): reconcile the output/monitoring senders against the
                // sessions the agent actually recovered. Senders keyed by ids that
                // did not come back are stale — drop them so the maps don't leak.
                // #2556/#2564: the same recovered-id set resolves each hosted
                // session's `session-lifecycle` region entry at the backend source —
                // `Reconnecting → Connected` for a session that survived in place, or
                // `Reconnecting → SessionLost` for one the agent did not recover.
                // Fetch it once when there is either a sender to reconcile or a hosted
                // tab to resolve; skip the extra round-trip when neither applies.
                let hosted = hosted_sessions_for_agent(&app_handle, &agent_id).await;
                // SM-003: sessions the fresh worker found held by another desktop
                // (`connection.evicted`, reason `heldByPeer`, emitted during its
                // start-up recovery) fold the explicit `Evicted` state *before* the
                // resolve below, so a peer-held — alive — session is never
                // relabelled "session lost". The dispatch above also spawns this
                // fold; doing it inline here orders it ahead of the resolve.
                let held_elsewhere = evicted_session_ids(&reconnect_notifications);
                fold_evicted_hosted_sessions(&app_handle, &hosted, &held_elsewhere);
                if !session_outputs.is_empty()
                    || !monitoring_outputs.is_empty()
                    || !hosted.is_empty()
                {
                    // SM-001: the transport is back, but the hosted tabs are still
                    // folded to `Reconnecting(Idle)` (no timer armed — the in-task
                    // loop owns the break). They are resolved off `Reconnecting`
                    // ONLY from the `connection.list` result here, so this call must
                    // ALWAYS settle them to a terminal outcome. `list_recovered_
                    // session_ids` has no timeout of its own, so a bounded, per-
                    // attempt-timed retry both recovers a transient first failure and
                    // guarantees this returns (a hung agent can no longer strand the
                    // task — and every hosted tab — in a no-exit reconnecting state).
                    let recovered = list_recovered_session_ids_bounded(
                        &mut channel,
                        &agent_id,
                        &mut request_id,
                    )
                    .await;
                    // #4017: re-attach the hosted sessions the fresh worker left
                    // unattached (#3369), or their output never flows again.
                    let (live_ids, reattach_notifications) = reattach_after_reconnect(
                        &app_handle,
                        &mut channel,
                        &agent_id,
                        &mut request_id,
                        &mut line_buf,
                        &hosted,
                        recovered,
                    )
                    .await;
                    if let Some(ref live_ids) = live_ids {
                        // SM-003: keep the output sender of every evicted hosted
                        // session too — it is alive on another desktop, and an
                        // explicit Reclaim re-attaches it through the same channel.
                        let mut keep = live_ids.clone();
                        keep.extend(evicted_remote_ids(&app_handle, &hosted));
                        reconcile_output_senders(
                            &mut session_outputs,
                            &mut monitoring_outputs,
                            &keep,
                        );
                        files_only_routes.retain(&keep);
                    }
                    // Route the output read while waiting for the attach replies
                    // (the re-attached sessions' buffered output) to their tabs.
                    for (method, params) in &reattach_notifications {
                        dispatch_agent_notification(
                            &app_handle,
                            &agent_id,
                            method,
                            params,
                            &session_outputs,
                            &monitoring_outputs,
                            &mut files_only_routes,
                            &b64,
                        );
                    }
                    // Always resolve: `Some` → recovered/lost per the listed ids;
                    // `None` (list unavailable after the bounded budget) → settle every
                    // hosted tab to the terminal `SessionLost` state rather than leaving
                    // it stuck `Reconnecting` forever (SM-001).
                    resolve_hosted_sessions_after_reconnect(
                        &app_handle,
                        &hosted,
                        live_ids.as_ref(),
                    )
                    .await;
                }

                // CONC-014: filter the command backlog that accumulated in the
                // narrow window between the transport dying and `reconnecting` being
                // set (the send-side gate drops the bulk of it, but a few frames can
                // slip in). Terminal `SessionInput` is dropped so stale keystrokes
                // are never replayed into the recovered session; `SessionResize` is
                // coalesced to the latest per session so the recovered PTY still gets
                // correct dimensions; all control commands are preserved in order.
                // Survivors are re-queued through `command_tx` and processed normally
                // by the resumed loop. Clear the flag only after this drain so no new
                // input races in ahead of it. #3018: the drain covers the queued data
                // lane too, releases the credit of whatever the filter drops, and
                // re-queues survivors ungated (they keep their credit) — so this task
                // never waits on its own budget and cannot self-deadlock.
                for cmd in lanes.drain_reconnect_backlog() {
                    let _ = command_tx.send(cmd);
                }
                reconnecting.store(false, Ordering::SeqCst);

                emit_agent_state(&app_handle, &agent_id, "connected");
                log_agent_reconnected(&agent_id);
                // #3593: a reconnect may follow an agent crash — check its crash
                // reports once, off this loop (spawned, bounded, best-effort).
                crate::utils::agent_crash_notice::spawn_check(&app_handle, &agent_id);
                // Notify all pending requests that the connection was lost
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err(AgentRpcFailure::transport_closed(
                        "Connection lost during request",
                    )));
                }
                continue 'outer;
            }
            Err(e) => {
                log_agent_reconnect_failed(&agent_id, &e);
                give_up_after_exhausted_reconnect(&app_handle, &agent_id, &alive, &reaper, &e)
                    .await;
                // Notify all pending requests
                for (_, tx) in pending_responses.drain() {
                    let _ = tx.send(Err(AgentRpcFailure::transport_closed("Agent disconnected")));
                }
                return;
            }
        }
    }
}
