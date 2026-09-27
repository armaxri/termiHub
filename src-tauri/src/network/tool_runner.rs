//! One code path for every built-in network tool, locally and on an agent
//! (#3731, DUP-027).
//!
//! Every network diagnostic — ping, ping sweep, port scan, traceroute, DNS,
//! open ports, Wake-on-LAN — runs a core [`Tool`](termihub_core::tool::Tool)
//! from a [`ToolRegistry`]:
//!
//! - **locally**, from the desktop's own registry
//!   ([`NetworkManager::tool_registry`]);
//! - **on an agent**, from the agent's registry behind `tool.*` — streamed via
//!   `tool.start` ([`agent_stream`]) or one-shot via `tool.run`.
//!
//! Either way the tool's streamed [`ToolEvent`]s are re-emitted through the same
//! [`StreamTool`] mapping, so the `network-*` Tauri events the frontend sees are
//! identical wherever a tool ran.
//!
//! # Agent version floor
//!
//! The agent's dedicated `network.*` methods were retired in protocol 0.12.0.
//! The desktop needs an agent that streams tool runs — it advertises the
//! `toolStreaming` capability, protocol [`NETWORK_TOOLS_MIN_AGENT_PROTOCOL`] and
//! later. An older agent is refused **before** anything is sent, with a clear
//! [`agent_outdated`](TerminalError::agent_outdated) error telling the user to
//! update the agent (the existing agent-update flow is the remedy). It is never
//! left to fail on a missing method.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use termihub_core::protocol::methods::TOOL_RUN;
use termihub_core::tool::{CollectingHost, ToolEvent, ToolHost, ToolRegistry};

use crate::network::agent_stream::{self, StreamOutcome, StreamTool};
use crate::network::NetworkManager;
use crate::run_location::ResolvedLocation;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// The oldest agent protocol that can run network tools: 0.9.0 added the
/// `toolStreaming` capability (`tool.start` / `tool.cancel`), which the desktop
/// checks for. Documented in `docs/remote-protocol.md`.
pub const NETWORK_TOOLS_MIN_AGENT_PROTOCOL: &str = "0.9.0";

/// The user-facing message for an agent below the network-tool floor.
///
/// Names the agent's version when it reported one, and always tells the user
/// the remedy: update the agent.
pub fn agent_too_old_message(agent_version: &str) -> String {
    let version = agent_version.trim();
    let which = if version.is_empty() {
        "This agent".to_string()
    } else {
        format!("This agent (version {version})")
    };
    format!(
        "{which} is too old to run network tools. Update the agent to use network tools \
         (agent protocol {NETWORK_TOOLS_MIN_AGENT_PROTOCOL} or newer is required)."
    )
}

/// Check that `agent_id` can run network tools (the version floor).
///
/// An agent that is not connected reports no capabilities and gets a plain
/// network error; a connected agent without `toolStreaming` gets the
/// [`agent_outdated`](TerminalError::agent_outdated) "update the agent" error.
pub fn ensure_agent_supports_network_tools(
    client: &Arc<dyn AgentRpcClient>,
    agent_id: &str,
) -> Result<(), TerminalError> {
    match client.get_capabilities(agent_id) {
        None => Err(TerminalError::NetworkError(format!(
            "agent {agent_id} is not connected"
        ))),
        Some(caps) if !caps.tool_streaming => Err(TerminalError::agent_outdated(
            agent_too_old_message(&caps.agent_version),
        )),
        Some(_) => Ok(()),
    }
}

/// Where a network tool runs.
#[derive(Clone)]
pub enum ToolTarget {
    /// On this computer, from the desktop's own registry.
    Local(Arc<ToolRegistry>),
    /// On a connected agent at or above the network-tool floor.
    Agent {
        client: Arc<dyn AgentRpcClient>,
        agent_id: String,
    },
}

impl ToolTarget {
    /// Build a target for `location`, enforcing the agent version floor.
    pub fn for_location(
        location: ResolvedLocation,
        registry: Arc<ToolRegistry>,
        client: Option<Arc<dyn AgentRpcClient>>,
    ) -> Result<Self, TerminalError> {
        match location {
            ResolvedLocation::Local => Ok(Self::Local(registry)),
            ResolvedLocation::Agent(agent_id) => {
                let client = client.ok_or_else(|| {
                    TerminalError::NetworkError("agent manager is not available".into())
                })?;
                ensure_agent_supports_network_tools(&client, &agent_id)?;
                Ok(Self::Agent { client, agent_id })
            }
        }
    }
}

/// Resolve where the network tool `tool` (a key in
/// [`agent_tools::tool`](super::agent_tools::tool)) runs, from its run-location
/// preference, enforcing the agent version floor.
pub fn resolve_target(manager: &NetworkManager, tool: &str) -> Result<ToolTarget, TerminalError> {
    let location = manager.resolve_tool_location(tool)?;
    let client = match location {
        ResolvedLocation::Local => None,
        ResolvedLocation::Agent(_) => manager.agent_rpc_client(),
    };
    ToolTarget::for_location(location, manager.tool_registry(), client)
}

/// The collected `tool.run` reply: `{ events, result }`. Only the aggregate
/// matters to a one-shot tool.
#[derive(Debug, Deserialize)]
struct ToolRunReply {
    result: Value,
}

/// Run a one-shot tool (`dns`, `open_ports`, `wol`) and return its aggregate.
pub async fn run_one_shot(
    target: &ToolTarget,
    tool_id: &str,
    params: Value,
) -> Result<Value, TerminalError> {
    match target {
        ToolTarget::Local(registry) => registry
            .run(
                tool_id,
                params,
                CollectingHost::new(),
                CancellationToken::new(),
            )
            .await
            .map_err(|e| TerminalError::NetworkError(e.to_string())),
        ToolTarget::Agent { client, agent_id } => {
            let request = json!({ "toolId": tool_id, "params": params });
            let (client, agent_id) = (Arc::clone(client), agent_id.clone());
            let reply = tokio::task::spawn_blocking(move || {
                client.send_request(&agent_id, TOOL_RUN, request)
            })
            .await
            .map_err(|e| TerminalError::NetworkError(e.to_string()))??;
            serde_json::from_value::<ToolRunReply>(reply)
                .map(|r| r.result)
                .map_err(|e| TerminalError::NetworkError(e.to_string()))
        }
    }
}

/// Run a streaming tool, handing `emit` each re-emitted `network-*` event: the
/// per-result events as they arrive, then exactly one completion or error event.
pub async fn run_streaming<E>(
    target: ToolTarget,
    tool: StreamTool,
    task_id: &str,
    params: Value,
    cancel: &CancellationToken,
    emit: E,
) where
    E: Fn(&'static str, Value) + Send + Sync + 'static,
{
    match target {
        ToolTarget::Local(registry) => {
            run_local_streaming(&registry, tool, task_id, params, cancel, emit).await
        }
        ToolTarget::Agent { client, agent_id } => {
            agent_stream::run_streaming(tool, client, &agent_id, task_id, params, cancel, emit)
                .await
        }
    }
}

/// A [`ToolHost`] that maps each streamed event to its `network-*` event.
struct EmitHost<E> {
    tool: StreamTool,
    task_id: String,
    emit: Arc<E>,
}

impl<E> ToolHost for EmitHost<E>
where
    E: Fn(&'static str, Value) + Send + Sync,
{
    fn emit(&self, event: ToolEvent) {
        if let Some((name, payload)) = self.tool.event_payload(&self.task_id, event) {
            (self.emit)(name, payload);
        }
    }
}

/// Run `tool` from the desktop's own registry, emitting live.
async fn run_local_streaming<E>(
    registry: &ToolRegistry,
    tool: StreamTool,
    task_id: &str,
    params: Value,
    cancel: &CancellationToken,
    emit: E,
) where
    E: Fn(&'static str, Value) + Send + Sync + 'static,
{
    let emit = Arc::new(emit);
    let host = Arc::new(EmitHost {
        tool,
        task_id: task_id.to_string(),
        emit: Arc::clone(&emit),
    });
    let outcome = match registry
        .run(tool.tool_id(), params, host, cancel.clone())
        .await
    {
        // The token is set while the tool runs; reading it *after* the run ends
        // reports a Stop as canceled rather than completed.
        Ok(result) => StreamOutcome::Done {
            result: Some(result),
            error: None,
            cancelled: cancel.is_cancelled(),
        },
        Err(e) => StreamOutcome::Failed(e.to_string()),
    };
    let (name, payload) = tool.completion_payload(task_id, outcome);
    emit(name, payload);
}

#[cfg(test)]
#[path = "tool_runner_tests.rs"]
mod tests;
