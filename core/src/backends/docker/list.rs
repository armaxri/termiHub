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
use crate::errors::{ConnectFailureKind, SessionError};
use crate::session::docker::ComposeTarget;

/// One container as shown in the connection-editor picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[cfg_attr(test, ts(rename = "DockerContainerInfo", optional_fields))]
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
    /// Docker Compose project the container belongs to, from the
    /// `com.docker.compose.project` label (#3425); `None` for a container not
    /// started by Compose. The picker groups containers by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_project: Option<String>,
    /// Docker Compose service the container runs, from the
    /// `com.docker.compose.service` label (#3425); `None` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_service: Option<String>,
}

/// Label Docker Compose stamps with the project name on every container it creates.
pub const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
/// Label Docker Compose stamps with the service name on every container it creates.
pub const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";

/// Read the Compose project and service from a container's labels (#3425).
///
/// Each is independent — a container can carry one label without the other —
/// and a missing, empty or whitespace-only value is `None`.
pub fn compose_labels(
    labels: Option<&HashMap<String, String>>,
) -> (Option<String>, Option<String>) {
    let get = |key: &str| {
        labels
            .and_then(|l| l.get(key))
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    (get(COMPOSE_PROJECT_LABEL), get(COMPOSE_SERVICE_LABEL))
}

/// Label Docker Compose stamps with a container's replica number (`1`, `2`, …).
pub const COMPOSE_CONTAINER_NUMBER_LABEL: &str = "com.docker.compose.container-number";

/// Pick the container a Compose-service target connects to (#3784).
///
/// Only containers whose `com.docker.compose.project` and
/// `com.docker.compose.service` labels equal the target are considered;
/// containers without Compose labels never match. Of those, only running
/// ones qualify. When the service is scaled to several running replicas the
/// one with the **lowest** `com.docker.compose.container-number` wins
/// (a missing or non-numeric number sorts last), then the name, then the ID —
/// so the choice is deterministic and stable across reconnects.
///
/// Returns the chosen container's ID.
///
/// # Errors
///
/// A [`ConnectFailureKind::NotFound`] failure when no container belongs to the
/// service, or when none of its containers is running.
pub fn pick_compose_container(
    raw: &[bollard::models::ContainerSummary],
    target: &ComposeTarget,
) -> Result<String, SessionError> {
    let members: Vec<&bollard::models::ContainerSummary> = raw
        .iter()
        .filter(|c| c.id.as_deref().is_some_and(|id| !id.is_empty()))
        .filter(|c| {
            let (project, service) = compose_labels(c.labels.as_ref());
            project.as_deref() == Some(target.project.as_str())
                && service.as_deref() == Some(target.service.as_str())
        })
        .collect();
    if members.is_empty() {
        return Err(SessionError::classified(
            ConnectFailureKind::NotFound,
            format!("No container belongs to Compose service '{target}'"),
        ));
    }
    let replica = |c: &bollard::models::ContainerSummary| -> u64 {
        c.labels
            .as_ref()
            .and_then(|l| l.get(COMPOSE_CONTAINER_NUMBER_LABEL))
            .and_then(|n| n.trim().parse::<u64>().ok())
            .unwrap_or(u64::MAX)
    };
    let name = |c: &bollard::models::ContainerSummary| -> String {
        c.names
            .as_ref()
            .and_then(|n| n.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default()
    };
    members
        .iter()
        .filter(|c| {
            c.state
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case("running"))
        })
        .min_by(|a, b| {
            replica(a)
                .cmp(&replica(b))
                .then_with(|| name(a).cmp(&name(b)))
                .then_with(|| a.id.cmp(&b.id))
        })
        .and_then(|c| c.id.clone())
        .ok_or_else(|| {
            SessionError::classified(
                ConnectFailureKind::NotFound,
                format!(
                    "Compose service '{target}' has no running container ({} stopped)",
                    members.len()
                ),
            )
        })
}

/// The container listing a Compose-service resolution needs (#3784) — a seam
/// so the connect path's resolution is testable without a live daemon.
#[async_trait::async_trait]
pub(crate) trait ContainerLister: Sync {
    /// List every container (running or not) matching the daemon-side
    /// `label` filters.
    async fn list_by_labels(
        &self,
        labels: Vec<String>,
    ) -> Result<Vec<bollard::models::ContainerSummary>, SessionError>;
}

#[async_trait::async_trait]
impl ContainerLister for bollard::Docker {
    async fn list_by_labels(
        &self,
        labels: Vec<String>,
    ) -> Result<Vec<bollard::models::ContainerSummary>, SessionError> {
        let mut filters = HashMap::new();
        filters.insert("label".to_string(), labels);
        self.list_containers(Some(ListContainersOptions::<String> {
            all: true,
            filters,
            ..Default::default()
        }))
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to list containers: {e}")))
    }
}

/// Resolve a Compose-service target to its running container's ID (#3784).
///
/// Asks the daemon for the service's containers by label, then applies
/// [`pick_compose_container`] (which re-checks the labels, so a daemon that
/// ignores the filter still resolves correctly).
pub(crate) async fn resolve_compose_container(
    lister: &dyn ContainerLister,
    target: &ComposeTarget,
) -> Result<String, SessionError> {
    let raw = lister
        .list_by_labels(vec![
            format!("{COMPOSE_PROJECT_LABEL}={}", target.project),
            format!("{COMPOSE_SERVICE_LABEL}={}", target.service),
        ])
        .await?;
    pick_compose_container(&raw, target)
}

/// Wire form for the agent's `docker.list_containers` result (#3424).
impl From<ContainerInfo> for crate::protocol::methods::DockerContainerEntry {
    fn from(c: ContainerInfo) -> Self {
        Self {
            id: c.id,
            name: c.name,
            image: c.image,
            state: c.state,
            status: c.status,
            running: c.running,
            compose_project: c.compose_project,
            compose_service: c.compose_service,
        }
    }
}

/// Back from the wire: the desktop shows an agent's containers exactly like
/// local ones (#3424).
impl From<crate::protocol::methods::DockerContainerEntry> for ContainerInfo {
    fn from(c: crate::protocol::methods::DockerContainerEntry) -> Self {
        Self {
            id: c.id,
            name: c.name,
            image: c.image,
            state: c.state,
            status: c.status,
            running: c.running,
            compose_project: c.compose_project,
            compose_service: c.compose_service,
        }
    }
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
            let (compose_project, compose_service) = compose_labels(c.labels.as_ref());
            Some(ContainerInfo {
                id,
                name,
                image: c.image.unwrap_or_default(),
                state,
                status: c.status.unwrap_or_default(),
                running,
                compose_project,
                compose_service,
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
                compose_project: None,
                compose_service: None,
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
            compose_project: None,
            compose_service: None,
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

    /// The agent wire DTO (#3424) round-trips losslessly and has the same JSON
    /// shape as the local picker entry, so both paths feed the same UI.
    #[test]
    fn wire_entry_round_trips_with_identical_json() {
        use crate::protocol::methods::DockerContainerEntry;
        let info = ContainerInfo {
            id: "abc".into(),
            name: "web".into(),
            image: "nginx".into(),
            state: "exited".into(),
            status: "Exited (0)".into(),
            running: false,
            compose_project: Some("shop".into()),
            compose_service: Some("db".into()),
        };
        let wire = DockerContainerEntry::from(info.clone());
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::to_value(&info).unwrap()
        );
        assert_eq!(ContainerInfo::from(wire), info);
    }

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn compose_labels_present() {
        let l = labels(&[
            (COMPOSE_PROJECT_LABEL, "shop"),
            (COMPOSE_SERVICE_LABEL, "web"),
            ("other", "x"),
        ]);
        assert_eq!(
            compose_labels(Some(&l)),
            (Some("shop".to_string()), Some("web".to_string()))
        );
    }

    #[test]
    fn compose_labels_absent() {
        assert_eq!(compose_labels(None), (None, None));
        assert_eq!(compose_labels(Some(&labels(&[("a", "b")]))), (None, None));
    }

    #[test]
    fn compose_labels_partial_and_blank() {
        let only_project = labels(&[(COMPOSE_PROJECT_LABEL, "shop")]);
        assert_eq!(
            compose_labels(Some(&only_project)),
            (Some("shop".to_string()), None)
        );
        let only_service = labels(&[(COMPOSE_SERVICE_LABEL, "web")]);
        assert_eq!(
            compose_labels(Some(&only_service)),
            (None, Some("web".to_string()))
        );
        let blank = labels(&[(COMPOSE_PROJECT_LABEL, "  "), (COMPOSE_SERVICE_LABEL, "")]);
        assert_eq!(compose_labels(Some(&blank)), (None, None));
    }

    #[test]
    fn summarize_carries_compose_labels() {
        let mut compose = summary("c1", &["/shop-web-1"], "running");
        compose.labels = Some(labels(&[
            (COMPOSE_PROJECT_LABEL, "shop"),
            (COMPOSE_SERVICE_LABEL, "web"),
        ]));
        let out = summarize_containers(vec![compose, summary("p1", &["/plain"], "running")]);
        let web = out.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(web.compose_project.as_deref(), Some("shop"));
        assert_eq!(web.compose_service.as_deref(), Some("web"));
        let plain = out.iter().find(|c| c.id == "p1").unwrap();
        assert_eq!(
            (plain.compose_project.clone(), plain.compose_service.clone()),
            (None, None)
        );
    }

    #[test]
    fn serializes_compose_fields_camel_case_when_present() {
        let info = ContainerInfo {
            id: "i".into(),
            name: "n".into(),
            image: "img".into(),
            state: "running".into(),
            status: "Up".into(),
            running: true,
            compose_project: Some("shop".into()),
            compose_service: Some("web".into()),
        };
        let json = serde_json::to_value(&info).expect("serialize");
        assert_eq!(json["composeProject"], "shop");
        assert_eq!(json["composeService"], "web");
    }

    /// Wire shape (#3425): the compose fields are omitted when absent, so an
    /// entry without them is byte-identical to the pre-0.15.0 shape.
    #[test]
    fn wire_entry_omits_absent_compose_fields() {
        use crate::protocol::methods::DockerContainerEntry;
        let wire = DockerContainerEntry {
            id: "a".into(),
            name: "plain".into(),
            image: "nginx".into(),
            state: "running".into(),
            status: "Up".into(),
            running: true,
            compose_project: None,
            compose_service: None,
        };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!({
                "id": "a", "name": "plain", "image": "nginx",
                "state": "running", "status": "Up", "running": true
            })
        );
    }

    #[test]
    fn wire_entry_carries_compose_fields_when_present() {
        use crate::protocol::methods::DockerContainerEntry;
        let json = serde_json::json!({
            "id": "a", "name": "shop-web-1", "image": "nginx",
            "state": "running", "status": "Up", "running": true,
            "composeProject": "shop", "composeService": "web"
        });
        let wire: DockerContainerEntry = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(wire.compose_project.as_deref(), Some("shop"));
        assert_eq!(wire.compose_service.as_deref(), Some("web"));
        assert_eq!(serde_json::to_value(&wire).unwrap(), json);
    }

    /// A pre-0.15.0 agent's response (no compose fields) still parses.
    #[test]
    fn old_agent_result_without_compose_fields_parses() {
        use crate::protocol::methods::DockerListContainersResult;
        let result: DockerListContainersResult = serde_json::from_value(serde_json::json!({
            "containers": [{
                "id": "a", "name": "web", "image": "nginx",
                "state": "running", "status": "Up", "running": true
            }]
        }))
        .unwrap();
        let info = ContainerInfo::from(result.containers[0].clone());
        assert_eq!(info.compose_project, None);
        assert_eq!(info.compose_service, None);
        assert_eq!(info.name, "web");
    }

    // --- Compose-service resolution (#3784) ---

    fn target(project: &str, service: &str) -> ComposeTarget {
        ComposeTarget {
            project: project.into(),
            service: service.into(),
        }
    }

    fn replica(
        id: &str,
        project: &str,
        service: &str,
        number: &str,
        state: &str,
    ) -> ContainerSummary {
        let mut c = summary(id, &[&format!("/{project}-{service}-{number}")], state);
        c.labels = Some(labels(&[
            (COMPOSE_PROJECT_LABEL, project),
            (COMPOSE_SERVICE_LABEL, service),
            (COMPOSE_CONTAINER_NUMBER_LABEL, number),
        ]));
        c
    }

    fn not_found(err: SessionError) -> String {
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::NotFound),
            "{err}"
        );
        err.to_string()
    }

    #[test]
    fn compose_single_running_match() {
        let raw = vec![
            summary("plain", &["/web"], "running"),
            replica("other", "shop", "db", "1", "running"),
            replica("web1", "shop", "web", "1", "running"),
        ];
        assert_eq!(
            pick_compose_container(&raw, &target("shop", "web")).unwrap(),
            "web1"
        );
    }

    #[test]
    fn compose_multiple_replicas_pick_lowest_running_number() {
        let raw = vec![
            replica("r10", "shop", "web", "10", "running"),
            replica("r1", "shop", "web", "1", "exited"),
            replica("r3", "shop", "web", "3", "running"),
            replica("r2", "shop", "web", "2", "running"),
        ];
        // #1 is stopped; of the running ones #2 is the lowest — numerically,
        // not lexically (10 > 2).
        assert_eq!(
            pick_compose_container(&raw, &target("shop", "web")).unwrap(),
            "r2"
        );
        // Order of the listing does not matter.
        let mut reversed = raw.clone();
        reversed.reverse();
        assert_eq!(
            pick_compose_container(&reversed, &target("shop", "web")).unwrap(),
            "r2"
        );
    }

    #[test]
    fn compose_missing_number_sorts_last() {
        let mut unnumbered = replica("u", "shop", "web", "x", "running");
        unnumbered
            .labels
            .as_mut()
            .unwrap()
            .remove(COMPOSE_CONTAINER_NUMBER_LABEL);
        let raw = vec![unnumbered, replica("r5", "shop", "web", "5", "running")];
        assert_eq!(
            pick_compose_container(&raw, &target("shop", "web")).unwrap(),
            "r5"
        );
    }

    #[test]
    fn compose_none_running_is_not_found() {
        let raw = vec![
            replica("r1", "shop", "web", "1", "exited"),
            replica("r2", "shop", "web", "2", "paused"),
        ];
        let msg = not_found(pick_compose_container(&raw, &target("shop", "web")).unwrap_err());
        assert!(
            msg.contains("shop/web") && msg.contains("no running container"),
            "{msg}"
        );
        assert!(msg.contains("2 stopped"), "{msg}");
    }

    #[test]
    fn compose_no_member_is_not_found() {
        // Containers not started by Compose (no labels) never match, nor does
        // the same service name in another project.
        let raw = vec![
            summary("plain", &["/web"], "running"),
            replica("x", "other", "web", "1", "running"),
        ];
        let msg = not_found(pick_compose_container(&raw, &target("shop", "web")).unwrap_err());
        assert!(
            msg.contains("No container belongs to Compose service 'shop/web'"),
            "{msg}"
        );
        let msg = not_found(pick_compose_container(&[], &target("shop", "web")).unwrap_err());
        assert!(msg.contains("shop/web"), "{msg}");
    }

    struct FakeLister {
        raw: Vec<ContainerSummary>,
        seen: std::sync::Mutex<Vec<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl ContainerLister for FakeLister {
        async fn list_by_labels(
            &self,
            labels: Vec<String>,
        ) -> Result<Vec<ContainerSummary>, SessionError> {
            self.seen.lock().unwrap().push(labels);
            Ok(self.raw.clone())
        }
    }

    #[tokio::test]
    async fn resolve_filters_by_compose_labels_and_picks() {
        let lister = FakeLister {
            // The fake ignores the filter, as an old daemon might: the pick
            // still re-checks the labels.
            raw: vec![
                replica("db", "shop", "db", "1", "running"),
                replica("w2", "shop", "web", "2", "running"),
                replica("w1", "shop", "web", "1", "running"),
            ],
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let id = resolve_compose_container(&lister, &target("shop", "web"))
            .await
            .unwrap();
        assert_eq!(id, "w1");
        assert_eq!(
            *lister.seen.lock().unwrap(),
            vec![vec![
                "com.docker.compose.project=shop".to_string(),
                "com.docker.compose.service=web".to_string(),
            ]]
        );
    }
}
