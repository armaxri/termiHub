//! Container picker for **agent-hosted** Docker connections (PROD-017, #3424).
//!
//! The Docker connection editor lists the local runtime's containers through
//! [`list_docker_containers`](super::session::list_docker_containers). For an
//! agent-hosted Docker connection the containers live on the agent's host, so
//! [`list_agent_docker_containers`] asks the connected agent via the
//! `docker.list_containers` RPC (protocol 0.14.0) instead.
//!
//! An agent that predates the RPC answers JSON-RPC "method not found", which
//! `send_request` types as [`TerminalError::AgentUnsupported`]; that is reported
//! as `supported: false` — the picker then keeps today's typed name/ID field —
//! never as an error.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tracing::debug;

use termihub_core::backends::docker::ContainerInfo;
use termihub_core::config::ContainerRuntime;
use termihub_core::protocol::methods::{
    DockerListContainersParams, DockerListContainersResult, DOCKER_LIST_CONTAINERS,
};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Wait bound for one listing: the picker is interactive and must not hang for
/// the default one-minute request timeout on an unresponsive agent.
pub const AGENT_DOCKER_LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of [`list_agent_docker_containers`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDockerContainersResult {
    /// `false` when the agent is too old to list containers (the picker falls
    /// back to a typed name/ID and suggests updating the agent).
    pub supported: bool,
    /// The agent host's containers, running first (empty when unsupported).
    pub containers: Vec<ContainerInfo>,
}

/// Parse the frontend's runtime setting leniently: an unknown or missing value
/// means `auto`, exactly as the local listing does.
fn parse_runtime(runtime: Option<&str>) -> Option<ContainerRuntime> {
    runtime.and_then(|s| serde_json::from_value(serde_json::json!(s)).ok())
}

/// Ask an agent for its containers through `send` (one JSON-RPC request) and
/// decode the reply. Split out of the command so it is testable without a
/// Tauri `State` or a live agent.
pub fn list_agent_containers_via(
    runtime: Option<&str>,
    send: impl FnOnce(&str, Value) -> Result<Value, TerminalError>,
) -> Result<AgentDockerContainersResult, TerminalError> {
    let params = serde_json::to_value(DockerListContainersParams {
        runtime: parse_runtime(runtime),
    })
    .map_err(|e| TerminalError::InternalError(e.to_string()))?;
    match send(DOCKER_LIST_CONTAINERS, params) {
        Ok(value) => {
            let parsed: DockerListContainersResult =
                serde_json::from_value(value).map_err(|e| {
                    TerminalError::RemoteError(format!(
                        "Invalid {DOCKER_LIST_CONTAINERS} reply from agent: {e}"
                    ))
                })?;
            Ok(AgentDockerContainersResult {
                supported: true,
                containers: parsed.containers.into_iter().map(Into::into).collect(),
            })
        }
        Err(TerminalError::AgentUnsupported(_)) => Ok(AgentDockerContainersResult {
            supported: false,
            containers: Vec::new(),
        }),
        Err(e) => Err(e),
    }
}

/// List the containers of a connected agent host's container runtime, for the
/// Docker connection editor's picker on an agent-hosted connection (#3424).
/// `runtime` is the connection's `runtime` setting (`auto` / `docker` /
/// `podman`). Returns `supported: false` for an agent older than protocol
/// 0.14.0; rejects with the agent's error (e.g. its daemon is unreachable).
#[tauri::command]
pub async fn list_agent_docker_containers(
    agent_id: String,
    runtime: Option<String>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentDockerContainersResult, TerminalError> {
    debug!(agent_id, "Listing agent docker containers");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !manager.is_connected(&agent_id) {
            return Err(TerminalError::RemoteError(format!(
                "Agent {agent_id} not connected"
            )));
        }
        list_agent_containers_via(runtime.as_deref(), |method, params| {
            manager.send_request_bounded(&agent_id, method, params, AGENT_DOCKER_LIST_TIMEOUT)
        })
    })
    .await
    .unwrap_or_else(|e| Err(TerminalError::InternalError(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sends_the_typed_request_and_decodes_the_containers() {
        let mut sent = None;
        let result = list_agent_containers_via(Some("podman"), |method, params| {
            sent = Some((method.to_string(), params));
            Ok(json!({ "containers": [
                { "id": "a1", "name": "web", "image": "nginx", "state": "running",
                  "status": "Up 2 hours", "running": true },
                { "id": "b2", "name": "old", "image": "", "state": "exited",
                  "status": "Exited (0)", "running": false }
            ]}))
        })
        .expect("ok");
        assert_eq!(
            sent,
            Some((
                DOCKER_LIST_CONTAINERS.to_string(),
                json!({ "runtime": "podman" })
            ))
        );
        assert!(result.supported);
        assert_eq!(result.containers.len(), 2);
        assert_eq!(result.containers[0].name, "web");
        assert!(result.containers[0].running);
        assert!(!result.containers[1].running);
    }

    #[test]
    fn auto_or_unknown_runtime_is_sent_as_auto_or_omitted() {
        let mut sent = Vec::new();
        for rt in [None, Some("auto"), Some("bogus")] {
            list_agent_containers_via(rt, |_, params| {
                sent.push(params);
                Ok(json!({ "containers": [] }))
            })
            .expect("ok");
        }
        assert_eq!(
            sent,
            vec![json!({}), json!({ "runtime": "auto" }), json!({})]
        );
    }

    /// An agent older than protocol 0.14.0 answers "method not found": the
    /// picker must degrade to the typed field, not show an error.
    #[test]
    fn old_agent_method_not_found_is_unsupported_not_an_error() {
        let result = list_agent_containers_via(None, |_, _| {
            Err(TerminalError::AgentUnsupported("Method not found".into()))
        })
        .expect("unsupported is not an error");
        assert_eq!(
            result,
            AgentDockerContainersResult {
                supported: false,
                containers: Vec::new(),
            }
        );
    }

    #[test]
    fn runtime_errors_propagate_with_the_agents_message() {
        let err = list_agent_containers_via(None, |_, _| {
            Err(TerminalError::RemoteError(
                "Cannot connect to the Docker daemon".into(),
            ))
        })
        .expect_err("error");
        assert!(err.to_string().contains("Cannot connect to the Docker daemon"));
    }

    #[test]
    fn a_malformed_reply_is_an_error() {
        let err = list_agent_containers_via(None, |_, _| Ok(json!({ "containers": "nope" })))
            .expect_err("error");
        assert!(matches!(err, TerminalError::RemoteError(_)));
    }

    #[test]
    fn result_serializes_camel_case_for_the_frontend() {
        let v = serde_json::to_value(AgentDockerContainersResult {
            supported: false,
            containers: Vec::new(),
        })
        .unwrap();
        assert_eq!(v, json!({ "supported": false, "containers": [] }));
    }
}
