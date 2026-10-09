//! In-task agent transport reconnect (ARCH-002 / TAURI-009 final slice, #3794).
//!
//! [`reconnect_agent`] re-establishes the russh transport and re-initializes the
//! agent under the shared [`AGENT_RECONNECT_POLICY`] backoff, with a connect that
//! is cancellable on the shared `alive` flag (CONC-002).
//!
//! Carved out of the parent `agent_manager` module. Since #4304 each attempt's
//! post-auth handshake ([`reconnect_handshake`]) is bounded too, so an agent
//! that never answers `initialize` fails the attempt instead of hanging it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::protocol::methods::InitializeResult;
use termihub_core::reconnect_backoff::{
    policy_for, reconnect_reducer, system_jitter, BackoffConfig, ReconnectEvent, ReconnectKind,
    ReconnectPhase, INITIAL_RECONNECT_STATE,
};

use super::{
    build_initialize_params, read_handshake_line, serialize_request, AGENT_HANDSHAKE_TIMEOUT,
};
use crate::connection::config::AgentSettings;
use crate::terminal::agent_update_auth::token_path_from_initialize;
use crate::terminal::backend::RemoteAgentConfig;
use crate::terminal::jsonrpc;
use crate::utils::ssh_auth::connect_and_authenticate_cancellable;

/// Poll cadence for the reconnect connect-cancellation watcher (CONC-002).
pub(super) const RECONNECT_CANCEL_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(100);

/// Fire `token` as soon as the shared `alive` flag goes `false`.
///
/// Bridges the reconnect path's `alive` [`AtomicBool`] — flipped by a user
/// Disconnect or app shutdown (see [`disconnect_agent`](AgentConnectionManager::disconnect_agent))
/// — to the [`CancellationToken`] the cancellable SSH connect selects on, so a
/// hung reconnect to a black-holed host aborts promptly instead of parking the
/// I/O task for the full connect timeout (CONC-002). Returns once it has fired
/// the token; the caller aborts it when the connect completes first.
pub(super) async fn cancel_connect_when_disconnected(
    alive: Arc<AtomicBool>,
    token: CancellationToken,
) {
    while alive.load(Ordering::SeqCst) {
        tokio::time::sleep(RECONNECT_CANCEL_POLL_INTERVAL).await;
    }
    token.cancel();
}

/// The agent transport's in-task reconnect policy — the shared
/// `RECONNECT_POLICY` (SM-020, #3730): a 1 s first retry doubling to a 30 s
/// ceiling, 10 attempts, with bounded jitter so a fleet of agents dropped by
/// the same outage does not re-dial their hosts in lockstep. Driven through the
/// shared [`reconnect_reducer`] engine.
pub(crate) const AGENT_RECONNECT_POLICY: BackoffConfig = policy_for(ReconnectKind::AgentTransport);

/// Attempt to reconnect to an agent with exponential backoff.
///
/// Respects the `alive` flag — if it becomes `false` during the inter-attempt
/// delay the function returns immediately so the caller can exit cleanly. The
/// per-attempt SSH connect is also cancellable on `alive` (CONC-002), so a
/// Disconnect during a hung connect aborts it without waiting out the timeout.
#[allow(clippy::type_complexity)]
pub(super) async fn reconnect_agent(
    config: &RemoteAgentConfig,
    agent_settings: &AgentSettings,
    request_id: &mut u64,
    alive: &Arc<AtomicBool>,
) -> Result<
    (
        SshSession,
        russh::Channel<russh::client::Msg>,
        Vec<(String, Value)>,
        Option<String>,
    ),
    String,
> {
    // SM-020: the reconnect delay, attempt count, and give-up decision are driven
    // through the canonical reconnect engine ([`reconnect_backoff`]) on the
    // shared policy ([`AGENT_RECONNECT_POLICY`], #3730), with production jitter.
    // The separate bounded `connection.list` re-probe budget and the
    // `fold_agent_session_*` paths are unchanged.
    let mut jitter = system_jitter;
    // A fresh drop arms the first backoff window.
    let mut state = reconnect_reducer(
        &INITIAL_RECONNECT_STATE,
        ReconnectEvent::Drop,
        &AGENT_RECONNECT_POLICY,
        &mut jitter,
    );

    while state.phase == ReconnectPhase::Waiting {
        // The armed backoff delay for the attempt about to start.
        let backoff = tokio::time::Duration::from_millis(state.delay_ms.max(0) as u64);
        // The backoff timer fires: begin an attempt (advances the attempt count).
        state = reconnect_reducer(
            &state,
            ReconnectEvent::Attempt,
            &AGENT_RECONNECT_POLICY,
            &mut jitter,
        );
        // 0-based attempt index, preserved for the existing `attempt + 1` logs.
        let attempt = state.attempt - 1;

        // Sleep in small increments so we can respect the alive flag promptly
        let deadline = tokio::time::Instant::now() + backoff;
        loop {
            if !alive.load(Ordering::SeqCst) {
                return Err("Reconnect stopped by user".to_string());
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline - now;
            let sleep_ms = remaining.as_millis().min(100).try_into().unwrap_or(100u64);
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_ms)).await;
        }

        if !alive.load(Ordering::SeqCst) {
            return Err("Reconnect stopped by user".to_string());
        }

        let ssh_config = config.to_ssh_config();

        // 1. Connect — cancellable so a user Disconnect / app shutdown (which
        //    flips `alive`) aborts a hung connect to a black-holed host promptly,
        //    instead of parking the I/O task for the whole connect timeout
        //    (CONC-002). The connect itself stays bounded by the 45 s
        //    `SshConfig::connect_timeout`. A watcher task fires the token the
        //    moment `alive` goes false; it also covers the handshake below and
        //    is aborted once the attempt settles.
        let connect_token = CancellationToken::new();
        // Not app-owned (#3105): connect-scoped; aborted once the connect returns.
        let cancel_watcher = tokio::spawn(cancel_connect_when_disconnected(
            alive.clone(),
            connect_token.clone(),
        ));
        let connect_result =
            connect_and_authenticate_cancellable(&ssh_config, connect_token.clone());
        let session = match connect_result {
            Ok(s) => s,
            Err(e) => {
                cancel_watcher.abort();
                // A Disconnect that fired the token aborts the loop now rather
                // than looping into another backoff (CONC-002).
                if !alive.load(Ordering::SeqCst) {
                    return Err("Reconnect stopped by user".to_string());
                }
                warn!("Reconnect attempt {} failed (SSH): {}", attempt + 1, e);
                state = reconnect_reducer(
                    &state,
                    ReconnectEvent::Failure,
                    &AGENT_RECONNECT_POLICY,
                    &mut jitter,
                );
                continue;
            }
        };

        // 2-4. The post-auth handshake, bounded as one step and raced against
        //    the same `alive`-driven cancel token (CONC2-004, #4304): an agent
        //    that execs but never answers `initialize` fails this attempt after
        //    `AGENT_HANDSHAKE_TIMEOUT`, so backoff and give-up proceed instead of
        //    the task hanging in `reconnecting` forever.
        let handshake = reconnect_handshake(
            &session,
            config,
            agent_settings,
            request_id,
            AGENT_HANDSHAKE_TIMEOUT,
            &connect_token,
        )
        .await;
        cancel_watcher.abort();
        match handshake {
            Ok((channel, buffered, token_path)) => {
                return Ok((session, channel, buffered, token_path));
            }
            Err(e) => {
                if !alive.load(Ordering::SeqCst) {
                    return Err("Reconnect stopped by user".to_string());
                }
                warn!("Reconnect attempt {} failed ({})", attempt + 1, e);
            }
        }

        // The init handshake did not complete (channel closed / rejected / parse
        // failure): this attempt failed. Arm the next backoff window, or give up
        // once the attempt budget is spent (the `while` then exits).
        state = reconnect_reducer(
            &state,
            ReconnectEvent::Failure,
            &AGENT_RECONNECT_POLICY,
            &mut jitter,
        );
    }

    Err(format!(
        "Failed to reconnect after {} attempts",
        AGENT_RECONNECT_POLICY.max_attempts
    ))
}

/// One reconnect attempt's post-auth handshake: open the exec channel, launch
/// the agent, write `initialize` and read its answer — the whole of it bounded
/// by `timeout` and aborted as soon as `cancel` fires (CONC2-004, #4304).
///
/// Returns the ready channel, the notifications the agent sent before
/// answering (replayed after the channel is handed back, #1660) and the new
/// instance's update auth token path (AGT-003, #3213); or a short reason the
/// attempt failed, which the caller counts as a [`ReconnectEvent::Failure`].
#[allow(clippy::type_complexity)]
pub(super) async fn reconnect_handshake(
    session: &SshSession,
    config: &RemoteAgentConfig,
    agent_settings: &AgentSettings,
    request_id: &mut u64,
    timeout: std::time::Duration,
    cancel: &CancellationToken,
) -> Result<
    (
        russh::Channel<russh::client::Msg>,
        Vec<(String, Value)>,
        Option<String>,
    ),
    String,
> {
    let steps = async {
        // 2. Open channel and start agent
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("channel: {e}"))?;
        let exec_cmd = config.agent_exec_command();
        channel
            .exec(false, exec_cmd.as_str())
            .await
            .map_err(|e| format!("exec: {e}"))?;

        // 3. Initialize
        *request_id += 1;
        let enabled_files: Vec<&str> = config
            .external_connection_files
            .iter()
            .filter(|f| f.enabled)
            .map(|f| f.path.as_str())
            .collect();
        let init_params = build_initialize_params(agent_settings, &enabled_files);
        let req_line = serialize_request(
            *request_id,
            termihub_core::protocol::methods::INITIALIZE,
            init_params,
        )
        .map_err(|e| format!("serialize init: {e}"))?;
        channel
            .data(req_line.as_bytes())
            .await
            .map_err(|e| format!("write init: {e}"))?;

        // 4. Read the initialize response, skipping any notifications the agent
        // emits before answering (e.g. output from a session it recovered on
        // startup). Loop until the message whose id matches our request arrives.
        // Notifications it emits first are buffered for replay after the
        // channel is handed back, so an on-attach notice is not dropped (#1660).
        // The buffer is per attempt: a failed attempt's belongs to a channel
        // that is being discarded.
        const MAX_PRE_INIT_MESSAGES: u32 = 1000;
        let mut line_buf = String::new();
        let mut skipped: u32 = 0;
        let mut buffered: Vec<(String, Value)> = Vec::new();
        loop {
            let resp_line = read_handshake_line(&mut channel, &config.host, &mut line_buf)
                .await
                .ok_or_else(|| "channel closed during init read".to_string())?;
            let msg = jsonrpc::parse_message(&resp_line)
                .map_err(|e| format!("parse init response: {e}"))?;
            match jsonrpc::classify_handshake_message(msg, *request_id) {
                jsonrpc::HandshakeOutcome::Response(result) => {
                    // Only the token path matters here; the capabilities are
                    // ignored, and a malformed result still counts as a
                    // successful re-initialize (as before DUP-001, #3226).
                    let token_path =
                        serde_json::from_value::<InitializeResult<serde::de::IgnoredAny>>(result)
                            .ok()
                            .and_then(|r| token_path_from_initialize(&r));
                    return Ok((channel, buffered, token_path));
                }
                jsonrpc::HandshakeOutcome::Rejected(message) => {
                    return Err(format!("init rejected: {message}"));
                }
                jsonrpc::HandshakeOutcome::Buffer { method, params } => {
                    skipped += 1;
                    if skipped > MAX_PRE_INIT_MESSAGES {
                        return Err("too many messages before init response".to_string());
                    }
                    buffered.push((method, params));
                }
                jsonrpc::HandshakeOutcome::Skip => {
                    skipped += 1;
                    if skipped > MAX_PRE_INIT_MESSAGES {
                        return Err("too many messages before init response".to_string());
                    }
                }
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("handshake cancelled".to_string()),
        res = tokio::time::timeout(timeout, steps) => res.unwrap_or_else(|_| {
            Err(format!(
                "handshake timed out: no initialize response within {}s",
                timeout.as_secs_f32()
            ))
        }),
    }
}
