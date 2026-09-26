//! Stream agent-run network tools live (`tool.start`, #3353).
//!
//! The collect-and-return path in [`super::agent_tools`] waits for the agent's
//! whole run inside one RPC, so it is capped by the 60 s agent request timeout,
//! delivers every result at the end, and cannot stop the agent-side run. When
//! the agent advertises the `toolStreaming` capability the desktop instead:
//!
//! 1. registers a route for a fresh run id with the agent I/O task, **then**
//!    sends `tool.start` — so no early `tool.event` can be missed;
//! 2. re-emits each streamed [`ToolEvent`] as the *same* `network-*` Tauri event
//!    the local path emits, as it arrives (no request timeout applies);
//! 3. on Stop sends `tool.cancel`, then waits (bounded) for the agent's
//!    `tool.done`, which carries the partial aggregate, reported as canceled;
//! 4. fails the run if the agent transport breaks (the agent cancels the run on
//!    its side when the connection drops).
//!
//! An agent without the capability keeps the one-shot path, 60 s cap included.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::Sleep;
use tokio_util::sync::CancellationToken;

use termihub_core::network::types::{
    PingResult, PingStats, PingSweepResult, PingSweepSummary, PortScanResult, PortScanSummary,
    TracerouteHop,
};
use termihub_core::protocol::methods::{
    ToolCancelParams, ToolStartParams, TOOL_CANCEL, TOOL_START,
};
use termihub_core::tool::ToolEvent;

use crate::network::events::{self, name};
use crate::terminal::agent_manager::{AgentRpcClient, ToolRunMessage};

/// How long to wait for the agent's `tool.done` after sending `tool.cancel`.
/// The agent itself abandons a tool that ignores cancellation after 10 s.
pub const STREAM_CANCEL_GRACE: Duration = Duration::from_secs(15);

/// How a streaming run ended, as seen by the desktop.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamOutcome {
    /// The agent reported the run finished (`tool.done`).
    Done {
        /// The run's aggregate; absent when the run failed.
        result: Option<Value>,
        /// The agent's failure message, if any.
        error: Option<String>,
        /// Whether the run stopped early (Stop, or the agent's lifetime cap).
        cancelled: bool,
    },
    /// The run never finished normally: start refused, transport lost, or the
    /// agent did not confirm a cancel in time.
    Failed(String),
}

/// Whether `agent_id` can stream tool runs (advertised `toolStreaming`).
pub fn supports_streaming(client: &Arc<dyn AgentRpcClient>, agent_id: &str) -> bool {
    client
        .get_capabilities(agent_id)
        .is_some_and(|caps| caps.tool_streaming)
}

/// Run `tool_id` on the agent as a streaming run, handing each event to
/// `on_event` as it arrives, until the run finishes, fails, or — after `cancel`
/// fires — the agent confirms the cancel.
pub async fn stream_tool_run<F>(
    client: Arc<dyn AgentRpcClient>,
    agent_id: &str,
    tool_id: &str,
    params: Value,
    cancel: &CancellationToken,
    mut on_event: F,
) -> StreamOutcome
where
    F: FnMut(ToolEvent),
{
    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Err(e) = client.register_tool_run(agent_id, &run_id, tx) {
        return StreamOutcome::Failed(e.to_string());
    }
    let outcome = drive(
        &client,
        agent_id,
        &run_id,
        tool_id,
        params,
        cancel,
        &mut rx,
        &mut on_event,
    )
    .await;
    client.unregister_tool_run(agent_id, &run_id);
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn drive<F>(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    run_id: &str,
    tool_id: &str,
    params: Value,
    cancel: &CancellationToken,
    rx: &mut mpsc::UnboundedReceiver<ToolRunMessage>,
    on_event: &mut F,
) -> StreamOutcome
where
    F: FnMut(ToolEvent),
{
    let start = ToolStartParams {
        run_id: run_id.to_string(),
        tool_id: tool_id.to_string(),
        params,
    };
    if let Err(e) = request(client, agent_id, TOOL_START, &start).await {
        return StreamOutcome::Failed(e);
    }

    let mut grace: Option<Pin<Box<Sleep>>> = None;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(ToolRunMessage::Events(batch)) => batch.into_iter().for_each(&mut *on_event),
                Some(ToolRunMessage::Done(done)) => {
                    return StreamOutcome::Done {
                        result: done.result,
                        error: done.error,
                        cancelled: done.cancelled || cancel.is_cancelled(),
                    };
                }
                None => {
                    return StreamOutcome::Failed(
                        "agent connection lost during the tool run".to_string(),
                    );
                }
            },
            _ = cancel.cancelled(), if grace.is_none() => {
                // Fire-and-forget: the confirmation is the run's `tool.done`.
                let (client, agent_id) = (Arc::clone(client), agent_id.to_string());
                let params = ToolCancelParams { run_id: run_id.to_string() };
                tokio::spawn(async move {
                    let _ = request(&client, &agent_id, TOOL_CANCEL, &params).await;
                });
                grace = Some(Box::pin(tokio::time::sleep(STREAM_CANCEL_GRACE)));
            }
            _ = wait_optional(&mut grace) => {
                return StreamOutcome::Failed(
                    "agent did not confirm stopping the tool run".to_string(),
                );
            }
        }
    }
}

/// Send one blocking agent RPC off the async worker threads.
async fn request<P: serde::Serialize>(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
    method: &'static str,
    params: &P,
) -> Result<Value, String> {
    let params = serde_json::to_value(params).map_err(|e| e.to_string())?;
    let (client, agent_id) = (Arc::clone(client), agent_id.to_string());
    tokio::task::spawn_blocking(move || client.send_request(&agent_id, method, params))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Await the timer when armed; pend forever otherwise.
fn wait_optional(timer: &mut Option<Pin<Box<Sleep>>>) -> impl Future<Output = ()> + '_ {
    async move {
        match timer.as_mut() {
            Some(t) => t.as_mut().await,
            None => std::future::pending::<()>().await,
        }
    }
}

// ── Per-tool re-emission as the local path's `network-*` events ──────────────

/// A streaming network tool the desktop can run on an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamTool {
    PortScan,
    Ping,
    PingSweep,
    Traceroute,
}

impl StreamTool {
    /// The agent `ToolRegistry` id.
    pub fn tool_id(self) -> &'static str {
        match self {
            Self::PortScan => "port_scan",
            Self::Ping => "ping",
            Self::PingSweep => "ping_sweep",
            Self::Traceroute => "traceroute",
        }
    }

    /// The tool's `*-error` event name.
    pub fn error_event(self) -> &'static str {
        match self {
            Self::PortScan => name::SCAN_ERROR,
            Self::Ping => name::PING_ERROR,
            Self::PingSweep => name::SWEEP_ERROR,
            Self::Traceroute => name::TRACEROUTE_ERROR,
        }
    }

    /// The `(event name, payload)` for one streamed tool event, or `None` for an
    /// event kind this tool does not surface.
    pub fn event_payload(self, task_id: &str, event: ToolEvent) -> Option<(&'static str, Value)> {
        match (self, event.kind.as_str()) {
            (Self::PortScan, "result") => parse::<PortScanResult>(event.payload)
                .map(|r| (name::SCAN_RESULT, events::scan_result_payload(task_id, &r))),
            (Self::Ping, "result") => parse::<PingResult>(event.payload)
                .map(|r| (name::PING_RESULT, events::ping_result_payload(task_id, r))),
            (Self::PingSweep, "result") => parse::<PingSweepResult>(event.payload).map(|r| {
                (
                    name::SWEEP_RESULT,
                    events::sweep_result_payload(task_id, r.host, r.latency_ms, r.hostname),
                )
            }),
            (Self::Traceroute, "hop") => parse::<TracerouteHop>(event.payload).map(|h| {
                (
                    name::TRACEROUTE_HOP,
                    events::traceroute_hop_payload(task_id, h),
                )
            }),
            _ => None,
        }
    }

    /// The `(event name, payload)` that closes the run: the completion event, or
    /// the tool's error event.
    pub fn completion_payload(
        self,
        task_id: &str,
        outcome: StreamOutcome,
    ) -> (&'static str, Value) {
        match self.completion(task_id, outcome) {
            Ok(done) => done,
            Err(e) => (self.error_event(), events::error_payload(task_id, &e)),
        }
    }

    fn completion(
        self,
        task_id: &str,
        outcome: StreamOutcome,
    ) -> Result<(&'static str, Value), String> {
        let (result, cancelled) = match outcome {
            StreamOutcome::Failed(e) => return Err(e),
            StreamOutcome::Done { error: Some(e), .. } => return Err(e),
            StreamOutcome::Done {
                result, cancelled, ..
            } => (result, cancelled),
        };
        Ok(match self {
            // Traceroute has no aggregate; completion carries only the task id.
            Self::Traceroute => (
                name::TRACEROUTE_COMPLETE,
                events::traceroute_complete_payload(task_id),
            ),
            Self::PortScan => (
                name::SCAN_COMPLETE,
                events::scan_complete_payload(task_id, summary::<PortScanSummary>(result)?),
            ),
            Self::Ping => (
                name::PING_COMPLETE,
                events::ping_complete_payload(task_id, summary::<PingStats>(result)?, cancelled),
            ),
            Self::PingSweep => (
                name::SWEEP_COMPLETE,
                events::sweep_complete_payload(
                    task_id,
                    summary::<PingSweepSummary>(result)?,
                    cancelled,
                ),
            ),
        })
    }
}

/// Decode a run's aggregate into the tool's summary type.
fn summary<T: DeserializeOwned>(result: Option<Value>) -> Result<T, String> {
    let result = result.ok_or_else(|| "agent returned no result".to_string())?;
    serde_json::from_value(result).map_err(|e| e.to_string())
}

/// Decode an event payload; a malformed one is skipped rather than failing the
/// whole run (the completion still reports the aggregate).
fn parse<T: DeserializeOwned>(payload: Value) -> Option<T> {
    match serde_json::from_value(payload) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("dropping malformed streamed tool event: {e}");
            None
        }
    }
}

/// Stream `tool` on the agent, handing every re-emitted `network-*` event
/// (per-result events live, then exactly one completion or error event) to
/// `emit`.
pub async fn run_streaming<E>(
    tool: StreamTool,
    client: Arc<dyn AgentRpcClient>,
    agent_id: &str,
    task_id: &str,
    params: Value,
    cancel: &CancellationToken,
    mut emit: E,
) where
    E: FnMut(&'static str, Value),
{
    let outcome = stream_tool_run(client, agent_id, tool.tool_id(), params, cancel, |event| {
        if let Some((event_name, payload)) = tool.event_payload(task_id, event) {
            emit(event_name, payload);
        }
    })
    .await;
    let (event_name, payload) = tool.completion_payload(task_id, outcome);
    emit(event_name, payload);
}

/// [`run_streaming`] emitting straight to the frontend as Tauri events.
pub async fn run_streaming_to_app(
    tool: StreamTool,
    client: Arc<dyn AgentRpcClient>,
    agent_id: &str,
    app: &AppHandle,
    task_id: &str,
    params: Value,
    cancel: &CancellationToken,
) {
    run_streaming(
        tool,
        client,
        agent_id,
        task_id,
        params,
        cancel,
        |event_name, payload| {
            let _ = app.emit(event_name, payload);
        },
    )
    .await;
}

#[cfg(test)]
#[path = "agent_stream_tests.rs"]
mod tests;
