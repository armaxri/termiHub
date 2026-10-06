//! Route resolution of the graphical file side channel (#4191) per connection
//! shape, against an in-process fake agent (the live SSH route is covered by
//! the Docker-gated integration test in `graphical_file_channel_live_tests`).

use std::collections::HashMap;

use serde_json::json;

use super::*;

/// A fake agent host: a connected flag, an endpoint, and a stat table.
struct FakeAgent {
    connected: bool,
    dirs: HashMap<String, bool>,
}

impl FakeAgent {
    fn with_desktop(desktop: bool) -> Self {
        let mut dirs = HashMap::from([("/home/pi".to_string(), true)]);
        if desktop {
            dirs.insert("/home/pi/Desktop".to_string(), true);
        }
        dirs.insert("/home/pi/in".to_string(), true);
        Self {
            connected: true,
            dirs,
        }
    }
}

impl AgentFiles for FakeAgent {
    fn is_connected(&self, _agent_id: &str) -> bool {
        self.connected
    }

    fn endpoint(&self, agent_id: &str) -> Option<(String, String)> {
        (agent_id == "agent-1").then(|| ("lab-pi".to_string(), "pi".to_string()))
    }

    fn stat(&self, _agent_id: &str, path: &str) -> Result<FileEntry, String> {
        let path = path.replacen('~', "/home/pi", 1);
        match self.dirs.get(&path) {
            Some(is_directory) => Ok(FileEntry {
                path,
                is_directory: *is_directory,
                ..FileEntry::default()
            }),
            None => Err(format!("{path}: not found")),
        }
    }
}

fn agents(fake: FakeAgent) -> Option<Arc<dyn AgentFiles>> {
    Some(Arc::new(fake))
}

fn agent_route(target: &str) -> Option<AgentFileRoute> {
    Some(AgentFileRoute {
        agent_id: "agent-1".to_string(),
        target_host: target.to_string(),
    })
}

fn ssh_backend(target_is_loopback: bool) -> BackendSideChannel {
    BackendSideChannel {
        channel: Some(FileSideChannel {
            kind: FileSideChannelKind::Ssh,
            host: "tiger-box".to_string(),
            user: "arne".to_string(),
            same_host: target_is_loopback,
        }),
        session: None,
    }
}

fn ctx(settings: Value, agent: Option<AgentFileRoute>) -> FileChannelContext {
    FileChannelContext::new(&settings, agent)
}

#[tokio::test]
async fn setting_off_is_refused() {
    let result = resolve_file_channel(
        &ctx(json!({}), agent_route("localhost")),
        ssh_backend(true),
        agents(FakeAgent::with_desktop(true)),
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::Disabled
        }
    );
}

#[tokio::test]
async fn view_only_is_refused() {
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true, "viewOnly": true }), None),
        ssh_backend(true),
        None,
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::ViewOnly
        }
    );
}

#[tokio::test]
async fn direct_connection_has_no_route() {
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), None),
        BackendSideChannel::default(),
        None,
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::NoRoute
        }
    );
}

#[tokio::test]
async fn agent_route_resolves_the_agent_host_and_desktop_folder() {
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), agent_route("127.0.0.1")),
        BackendSideChannel::default(),
        agents(FakeAgent::with_desktop(true)),
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Ready {
            channel: FileSideChannel {
                kind: FileSideChannelKind::Agent,
                host: "lab-pi".to_string(),
                user: "pi".to_string(),
                same_host: true,
            },
            agent_id: Some("agent-1".to_string()),
            default_dir: "/home/pi/Desktop".to_string(),
        }
    );
}

#[tokio::test]
async fn agent_wins_over_the_tunnel() {
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), agent_route("office-pc")),
        ssh_backend(true),
        agents(FakeAgent::with_desktop(false)),
    )
    .await;
    let RemoteDesktopFileChannel::Ready {
        channel,
        default_dir,
        ..
    } = result
    else {
        panic!("expected ready, got {result:?}");
    };
    assert_eq!(channel.kind, FileSideChannelKind::Agent);
    assert!(!channel.same_host, "office-pc is not the agent host");
    assert_eq!(default_dir, "/home/pi", "no Desktop: home");
}

#[tokio::test]
async fn agent_route_uses_the_configured_folder() {
    let result = resolve_file_channel(
        &ctx(
            json!({ "fileTransfer": true, "fileTransferDir": " ~/in " }),
            agent_route("localhost"),
        ),
        BackendSideChannel::default(),
        agents(FakeAgent::with_desktop(true)),
    )
    .await;
    assert!(
        matches!(&result, RemoteDesktopFileChannel::Ready { default_dir, .. } if default_dir == "/home/pi/in"),
        "{result:?}"
    );
}

#[tokio::test]
async fn disconnected_agent_is_degraded_not_an_error() {
    let fake = FakeAgent {
        connected: false,
        ..FakeAgent::with_desktop(true)
    };
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), agent_route("localhost")),
        BackendSideChannel::default(),
        agents(fake),
    )
    .await;
    let RemoteDesktopFileChannel::Degraded {
        channel,
        agent_id,
        message,
    } = result
    else {
        panic!("expected degraded, got {result:?}");
    };
    assert_eq!(channel.host, "lab-pi");
    assert_eq!(agent_id.as_deref(), Some("agent-1"));
    assert!(message.contains("not connected"), "{message}");
}

#[tokio::test]
async fn unknown_agent_endpoint_falls_back_to_the_agent_id() {
    let route = Some(AgentFileRoute {
        agent_id: "agent-2".to_string(),
        target_host: "localhost".to_string(),
    });
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), route),
        BackendSideChannel::default(),
        None,
    )
    .await;
    let RemoteDesktopFileChannel::Degraded { channel, .. } = result else {
        panic!("expected degraded without an agent manager, got {result:?}");
    };
    assert_eq!(channel.host, "agent-2");
    assert_eq!(channel.user, "");
}

#[tokio::test]
async fn ssh_route_without_a_live_tunnel_session_is_degraded() {
    let result = resolve_file_channel(
        &ctx(json!({ "fileTransfer": true }), None),
        ssh_backend(false),
        None,
    )
    .await;
    let RemoteDesktopFileChannel::Degraded {
        channel,
        agent_id,
        message,
    } = result
    else {
        panic!("expected degraded, got {result:?}");
    };
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert!(!channel.same_host, "gateway tunnel keeps same_host false");
    assert_eq!(agent_id, None);
    assert!(message.contains("tiger-box"), "{message}");
}

#[test]
fn context_reads_policy_and_trimmed_folder() {
    let c = ctx(
        json!({ "fileTransfer": true, "viewOnly": false, "fileTransferDir": "  " }),
        None,
    );
    assert_eq!(c.configured_dir, None);
    assert!(c.policy.file_transfer);
    let c = ctx(json!({ "fileTransferDir": null }), agent_route("h"));
    assert_eq!(c.policy, FileChannelPolicy::default(), "off by default");
    assert_eq!(c.agent, agent_route("h"));
}

#[test]
fn contract_serializes_with_a_status_tag() {
    let ready = RemoteDesktopFileChannel::Ready {
        channel: FileSideChannel {
            kind: FileSideChannelKind::Ssh,
            host: "tiger-box".to_string(),
            user: "arne".to_string(),
            same_host: true,
        },
        agent_id: None,
        default_dir: "/home/arne/Desktop".to_string(),
    };
    assert_eq!(
        serde_json::to_value(ready).unwrap(),
        json!({
            "status": "ready",
            "channel": { "kind": "ssh", "host": "tiger-box", "user": "arne", "sameHost": true },
            "agentId": null,
            "defaultDir": "/home/arne/Desktop",
        })
    );
    assert_eq!(
        serde_json::to_value(RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::NoRoute
        })
        .unwrap(),
        json!({ "status": "unavailable", "reason": "noRoute" })
    );
}
