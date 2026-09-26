//! Container discovery — a `docker ps -a`-style listing (PROD-017).
//!
//! Backs the container picker in the Docker connection editor: instead of
//! typing an exact container name or ID for
//! [`ContainerMode::Existing`](crate::config::ContainerMode::Existing), the user
//! picks from the containers the selected runtime knows about.
//!
//! The runtime is reached exactly as [`connect`](crate::connection::ConnectionType::connect)
//! reaches it (`DOCKER_HOST`, the active Docker CLI context, the platform
//! default socket, or the Podman socket — see [`super::connect_to_runtime`]),
//! so the picker never lists a different daemon than the session would use.
//!
//! The daemon round-trip ([`list_containers`]) is a thin shell over the pure
//! [`summarize_containers`], which carries all the ordering / naming logic and
//! is unit-tested without a live daemon.

use std::collections::HashMap;

use bollard::container::ListContainersOptions;
use serde::{Deserialize, Serialize};

use crate::config::ContainerRuntime;
use crate::errors::SessionError;

/// One container as shown in the connection-editor picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// Full container ID.
    pub id: String,
    /// Primary container name without the leading `/` (falls back to the
    /// 12-character short ID when the daemon reports no name).
    pub name: String,
    /// Image the container was created from (empty when unknown).
    pub image: String,
    /// Machine-readable state (`running`, `exited`, `paused`, …; empty when
    /// unknown).
    pub state: String,
    /// Human-readable status (e.g. `Up 3 hours`, `Exited (0) 2 days ago`).
    pub status: String,
    /// Whether the container is running — only running containers can host an
    /// interactive shell in existing-container mode.
    pub running: bool,
}

/// Length of the conventional short container ID (`docker ps` column).
const SHORT_ID_LEN: usize = 12;

/// Convert the daemon's container summaries into picker entries.
///
/// Ordering: running containers first, then by name (case-insensitive), with
/// the ID as a final tie-breaker so the order is fully deterministic.
/// Entries without an ID are dropped — they cannot be exec'd into.
pub fn summarize_containers(raw: Vec<bollard::models::ContainerSummary>) -> Vec<ContainerInfo> {
    let mut out: Vec<ContainerInfo> = raw
        .into_iter()
        .filter_map(|c| {
            let id = c.id.filter(|id| !id.is_empty())?;
            let name = c
                .names
                .unwrap_or_default()
                .into_iter()
                .map(|n| n.trim_start_matches('/').to_string())
                .find(|n| !n.is_empty())
                .unwrap_or_else(|| id.chars().take(SHORT_ID_LEN).collect());
            let state = c.state.unwrap_or_default();
            let running = state.eq_ignore_ascii_case("running");
            Some(ContainerInfo {
                id,
                name,
                image: c.image.unwrap_or_default(),
                state,
                status: c.status.unwrap_or_default(),
                running,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// List every container (running and stopped) of the selected runtime.
///
/// Errors when the runtime is unreachable, with the same explanatory message a
/// connect attempt would produce — the picker shows it and falls back to a
/// typed name/ID.
pub async fn list_containers(
    runtime: &ContainerRuntime,
) -> Result<Vec<ContainerInfo>, SessionError> {
    let client = super::connect_to_runtime(runtime).await?;
    let raw = client
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            filters: HashMap::new(),
            ..Default::default()
        }))
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to list containers: {e}")))?;
    Ok(summarize_containers(raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::ContainerSummary;

    fn summary(id: &str, names: &[&str], state: &str) -> ContainerSummary {
        ContainerSummary {
            id: Some(id.to_string()),
            names: Some(names.iter().map(|n| n.to_string()).collect()),
            image: Some("ubuntu:22.04".to_string()),
            state: Some(state.to_string()),
            status: Some(format!("{state} status")),
            ..Default::default()
        }
    }

    #[test]
    fn strips_leading_slash_and_maps_fields() {
        let out = summarize_containers(vec![summary("abc123", &["/web"], "running")]);
        assert_eq!(
            out,
            vec![ContainerInfo {
                id: "abc123".to_string(),
                name: "web".to_string(),
                image: "ubuntu:22.04".to_string(),
                state: "running".to_string(),
                status: "running status".to_string(),
                running: true,
            }]
        );
    }

    #[test]
    fn running_first_then_name_case_insensitive() {
        let out = summarize_containers(vec![
            summary("1", &["/zeta"], "exited"),
            summary("2", &["/Beta"], "running"),
            summary("3", &["/alpha"], "exited"),
            summary("4", &["/gamma"], "running"),
        ]);
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Beta", "gamma", "alpha", "zeta"]);
        assert!(out[0].running && out[1].running);
        assert!(!out[2].running && !out[3].running);
    }

    #[test]
    fn missing_name_falls_back_to_short_id() {
        let id = "0123456789abcdef0123";
        let out = summarize_containers(vec![summary(id, &[], "running")]);
        assert_eq!(out[0].name, "0123456789ab");
    }

    #[test]
    fn missing_id_is_dropped() {
        let mut no_id = summary("x", &["/ghost"], "running");
        no_id.id = None;
        let mut empty_id = summary("x", &["/ghost2"], "running");
        empty_id.id = Some(String::new());
        assert!(summarize_containers(vec![no_id, empty_id]).is_empty());
    }

    #[test]
    fn paused_and_unknown_state_are_not_running() {
        let mut unknown = summary("u", &["/u"], "running");
        unknown.state = None;
        let out = summarize_containers(vec![summary("p", &["/p"], "paused"), unknown]);
        assert!(out.iter().all(|c| !c.running));
        assert!(out.iter().any(|c| c.state.is_empty()));
    }

    #[test]
    fn serializes_camel_case() {
        let info = ContainerInfo {
            id: "i".into(),
            name: "n".into(),
            image: "img".into(),
            state: "running".into(),
            status: "Up".into(),
            running: true,
        };
        let json = serde_json::to_value(&info).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "i", "name": "n", "image": "img",
                "state": "running", "status": "Up", "running": true
            })
        );
    }
}
