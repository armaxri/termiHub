//! Route resolution of the graphical file side channel (#4191) per connection
//! shape, against an in-process fake agent (the live SSH route is covered by
//! the Docker-gated integration test in `graphical_file_channel_live_tests`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use termihub_core::config::SshConfig;

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
            linked_connection: None,
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
                linked_connection: None,
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
        ..
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
        ..
    } = result
    else {
        panic!("expected degraded, got {result:?}");
    };
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert!(!channel.same_host, "gateway tunnel keeps same_host false");
    assert_eq!(agent_id, None);
    assert!(message.contains("tiger-box"), "{message}");
}

// --- Linked saved SSH connection (#4194) ---

/// A fake saved-connection store for the linked route: what `lookup` answers,
/// how a connect fails, and how often the route was looked up or connected
/// (with the user-entered secrets the lookups were handed).
struct FakeLink {
    lookup: LinkedLookup,
    connect_error: LinkedConnectError,
    lookups: AtomicUsize,
    connects: AtomicUsize,
    supplied: std::sync::Mutex<Vec<Option<String>>>,
}

impl FakeLink {
    fn new(lookup: LinkedLookup) -> Arc<Self> {
        Self::failing(
            lookup,
            LinkedConnectError {
                message: "Connection refused by tiger-box".to_string(),
                auth_rejected: false,
            },
        )
    }

    fn failing(lookup: LinkedLookup, connect_error: LinkedConnectError) -> Arc<Self> {
        Arc::new(Self {
            lookup,
            connect_error,
            lookups: AtomicUsize::new(0),
            connects: AtomicUsize::new(0),
            supplied: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn target(ask_again: Option<LinkedSecretRequest>) -> LinkedLookup {
        LinkedLookup::Found(Box::new(LinkedSshTarget {
            connection_id: "Lab/Tiger".to_string(),
            name: "Tiger".to_string(),
            config: SshConfig {
                host: "tiger-box".to_string(),
                username: "arne".to_string(),
                ..SshConfig::default()
            },
            ask_again,
        }))
    }

    fn found() -> Arc<Self> {
        Self::new(Self::target(None))
    }

    fn supplied(&self) -> Vec<Option<String>> {
        self.supplied.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl LinkedSshSource for FakeLink {
    fn lookup(&self, _connection_id: &str, supplied: Option<&str>) -> LinkedLookup {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        self.supplied
            .lock()
            .unwrap()
            .push(supplied.map(str::to_string));
        self.lookup.clone()
    }

    async fn connect(
        &self,
        _config: &SshConfig,
    ) -> Result<LinkedSshConnection, LinkedConnectError> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Err(self.connect_error.clone())
    }
}

/// What the Tiger link asks for when no password is saved (#4265).
fn password_request() -> LinkedSecretRequest {
    LinkedSecretRequest {
        connection_id: "Lab/Tiger".to_string(),
        source_file: None,
        kind: LinkedSecretKind::Password,
        auth_method: "password".to_string(),
        host: "tiger-box".to_string(),
        username: "arne".to_string(),
        store_locked: false,
        can_save: true,
        rejected: false,
    }
}

fn resolver(link: &Arc<FakeLink>) -> LinkedResolver {
    LinkedResolver {
        source: link.clone(),
        cache: LinkedSshCache::default(),
    }
}

/// A direct VNC connection to `office-pc` linked to the saved SSH connection
/// `Lab/Tiger`, with file transfer on.
fn linked_settings() -> Value {
    json!({
        "host": "office-pc",
        "fileTransfer": true,
        "fileTransferVia": "Lab/Tiger",
    })
}

#[test]
fn context_reads_the_link_only_for_a_direct_connection() {
    let link = |settings: Value, agent| ctx(settings, agent).linked;
    assert_eq!(
        link(linked_settings(), None),
        Some(LinkedFileRoute {
            connection_id: "Lab/Tiger".to_string(),
            target_host: "office-pc".to_string(),
        })
    );
    let mut tunnelled = linked_settings();
    tunnelled["useSshTunnel"] = json!(true);
    assert_eq!(link(tunnelled, None), None, "an SSH tunnel is the route");
    assert_eq!(
        link(linked_settings(), agent_route("office-pc")),
        None,
        "an agent-hosted connection uses the agent"
    );
    let mut blank = linked_settings();
    blank["fileTransferVia"] = json!("  ");
    assert_eq!(link(blank, None), None, "no link chosen");
    let mut null = linked_settings();
    null["fileTransferVia"] = Value::Null;
    assert_eq!(link(null, None), None);
}

#[tokio::test]
async fn linked_connection_that_cannot_connect_is_degraded_on_its_own_host() {
    let link = FakeLink::found();
    let (result, session) = resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        BackendSideChannel::default(),
        None,
        Some(&resolver(&link)),
    )
    .await;
    let RemoteDesktopFileChannel::Degraded {
        channel,
        agent_id,
        message,
        needs_secret,
    } = result
    else {
        panic!("expected degraded, got {result:?}");
    };
    assert_eq!(needs_secret, None, "a refused host is not a missing secret");
    assert_eq!(channel.kind, FileSideChannelKind::Ssh);
    assert_eq!(channel.host, "tiger-box", "labels name the real file host");
    assert_eq!(channel.user, "arne");
    assert_eq!(channel.linked_connection.as_deref(), Some("Tiger"));
    assert!(!channel.same_host, "office-pc is not tiger-box");
    assert_eq!(agent_id, None);
    assert!(message.contains("tiger-box"), "{message}");
    assert!(message.contains("Connection refused"), "{message}");
    assert!(session.is_none());
    assert_eq!(link.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn linked_connection_on_the_vnc_host_is_the_desktop_host() {
    let link = FakeLink::found();
    let mut settings = linked_settings();
    settings["host"] = json!("Tiger-Box");
    let (result, _) = resolve_file_channel_routed(
        &ctx(settings, None),
        BackendSideChannel::default(),
        None,
        Some(&resolver(&link)),
    )
    .await;
    let RemoteDesktopFileChannel::Degraded { channel, .. } = result else {
        panic!("expected degraded, got {result:?}");
    };
    assert!(channel.same_host);
}

#[tokio::test]
async fn deleted_link_falls_back_to_no_route() {
    let link = FakeLink::new(LinkedLookup::Missing);
    let (result, session) = resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        BackendSideChannel::default(),
        None,
        Some(&resolver(&link)),
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::NoRoute
        }
    );
    assert!(session.is_none(), "no stale route");
    assert_eq!(link.connects.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn link_without_a_stored_secret_is_degraded_with_the_reason() {
    let link = FakeLink::new(LinkedLookup::Unusable {
        name: "Tiger".to_string(),
        host: "tiger-box".to_string(),
        user: "arne".to_string(),
        message: "no password is saved for it".to_string(),
        secret: Some(Box::new(password_request())),
    });
    let (result, _) = resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        BackendSideChannel::default(),
        None,
        Some(&resolver(&link)),
    )
    .await;
    let RemoteDesktopFileChannel::Degraded {
        channel,
        message,
        needs_secret,
        ..
    } = result
    else {
        panic!("expected degraded, got {result:?}");
    };
    assert_eq!(channel.host, "tiger-box");
    assert_eq!(channel.linked_connection.as_deref(), Some("Tiger"));
    assert!(message.contains("no password is saved"), "{message}");
    // #4265: the answer asks for the password; only the UI, on a user action,
    // turns that into a prompt.
    assert_eq!(needs_secret, Some(password_request()));
    assert_eq!(link.connects.load(Ordering::SeqCst), 0);
}

/// Resolve the linked Office-PC route against `link` with `resolver`'s cache.
async fn resolve_linked(link: &LinkedResolver) -> RemoteDesktopFileChannel {
    resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        BackendSideChannel::default(),
        None,
        Some(link),
    )
    .await
    .0
}

/// #4265: without a supplied secret the lookup gets none — resolution itself
/// never asks anybody (unattended callers such as the transfer relaunch
/// resolve exactly like this).
#[tokio::test]
async fn resolution_without_a_supplied_secret_hands_none_to_the_lookup() {
    let link = FakeLink::found();
    let resolver = resolver(&link);
    resolve_linked(&resolver).await;
    assert_eq!(link.supplied(), vec![None]);
}

/// A secret the user entered is handed to every later lookup of the session,
/// so a reconnect of the linked SSH session never asks again.
#[tokio::test]
async fn a_supplied_secret_is_kept_for_the_session() {
    let link = FakeLink::found();
    let resolver = resolver(&link);
    resolver.cache.supply_secret("typed".to_string()).await;
    resolve_linked(&resolver).await;
    resolve_linked(&resolver).await;
    assert_eq!(
        link.supplied(),
        vec![Some("typed".to_string()), Some("typed".to_string())]
    );
}

/// A user-entered secret the server rejects is dropped, and the answer asks
/// for it again, marked as rejected so the prompt can say why.
#[tokio::test]
async fn a_rejected_supplied_secret_is_dropped_and_asked_for_again() {
    let link = FakeLink::failing(
        FakeLink::target(Some(password_request())),
        LinkedConnectError {
            message: "Authentication failed".to_string(),
            auth_rejected: true,
        },
    );
    let resolver = resolver(&link);
    resolver.cache.supply_secret("wrong".to_string()).await;
    let RemoteDesktopFileChannel::Degraded {
        message,
        needs_secret,
        ..
    } = resolve_linked(&resolver).await
    else {
        panic!("expected degraded");
    };
    assert!(message.contains("Authentication failed"), "{message}");
    let request = needs_secret.expect("asked for again");
    assert!(request.rejected);
    resolve_linked(&resolver).await;
    assert_eq!(
        link.supplied(),
        vec![Some("wrong".to_string()), None],
        "the rejected secret is not tried again"
    );
}

/// A user-entered secret whose host is merely unreachable is kept: a Retry
/// reconnects with it instead of asking again.
#[tokio::test]
async fn an_unreachable_host_keeps_the_supplied_secret() {
    let link = FakeLink::new(FakeLink::target(Some(password_request())));
    let resolver = resolver(&link);
    resolver.cache.supply_secret("typed".to_string()).await;
    let RemoteDesktopFileChannel::Degraded { needs_secret, .. } = resolve_linked(&resolver).await
    else {
        panic!("expected degraded");
    };
    assert_eq!(needs_secret, None);
    resolve_linked(&resolver).await;
    assert_eq!(link.supplied()[1].as_deref(), Some("typed"));
}

/// A link that no longer resolves drops the session's entered secret with it.
#[tokio::test]
async fn a_deleted_link_drops_the_supplied_secret() {
    let link = FakeLink::new(LinkedLookup::Missing);
    let resolver = resolver(&link);
    resolver.cache.supply_secret("typed".to_string()).await;
    resolve_linked(&resolver).await;
    resolve_linked(&resolver).await;
    assert_eq!(link.supplied(), vec![Some("typed".to_string()), None]);
}

#[tokio::test]
async fn link_is_not_looked_up_when_file_transfer_is_off_or_view_only() {
    let link = FakeLink::found();
    for (key, reason) in [
        ("fileTransfer", FileChannelUnavailable::Disabled),
        ("viewOnly", FileChannelUnavailable::ViewOnly),
    ] {
        let mut settings = linked_settings();
        settings[key] = json!(key == "viewOnly");
        let (result, _) = resolve_file_channel_routed(
            &ctx(settings, None),
            BackendSideChannel::default(),
            None,
            Some(&resolver(&link)),
        )
        .await;
        assert_eq!(result, RemoteDesktopFileChannel::Unavailable { reason });
    }
    assert_eq!(link.lookups.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tunnel_and_agent_routes_win_over_a_link() {
    let link = FakeLink::found();
    // A tunnel channel the backend offers wins even with a link in the
    // settings (the context drops the link for a tunnelled connection).
    let (result, _) = resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        ssh_backend(false),
        None,
        Some(&resolver(&link)),
    )
    .await;
    let RemoteDesktopFileChannel::Degraded { channel, .. } = result else {
        panic!("expected the tunnel route (degraded without a session), got {result:?}");
    };
    assert_eq!(channel.host, "tiger-box");
    assert_eq!(channel.linked_connection, None, "the tunnel, not the link");
    let (result, _) = resolve_file_channel_routed(
        &ctx(linked_settings(), agent_route("127.0.0.1")),
        BackendSideChannel::default(),
        agents(FakeAgent::with_desktop(true)),
        Some(&resolver(&link)),
    )
    .await;
    let RemoteDesktopFileChannel::Ready { channel, .. } = result else {
        panic!("expected the agent route, got {result:?}");
    };
    assert_eq!(channel.kind, FileSideChannelKind::Agent);
    assert_eq!(link.lookups.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn link_without_a_saved_connection_store_is_no_route() {
    let (result, _) = resolve_file_channel_routed(
        &ctx(linked_settings(), None),
        BackendSideChannel::default(),
        None,
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
            linked_connection: None,
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

/// The SSH route end to end (#4191): a live VNC session through the
/// `ssh-password` fixture's tunnel resolves to `Ready` with the default folder
/// read over SFTP on the tunnel's own session. Gated on the Docker fixtures
/// (`docker compose --profile vnc up -d ssh-password vnc-server`); hard-fails
/// under `TERMIHUB_REQUIRE_DOCKER=1`.
#[cfg(feature = "vnc")]
mod live {
    use termihub_core::backends::vnc::Vnc;
    use termihub_core::connection::ConnectionType;

    use super::*;
    use crate::utils::docker_fixture_gate::fixture_ready;

    /// A fixture's host port: `var` when set, else `base` shifted by this
    /// checkout's test-port offset (env or `dev.local.json`, #4338).
    fn env_port(var: &str, base: u16) -> u16 {
        termihub_core::test_fixtures::fixture_port(var, base)
    }

    /// Trust the loopback fixtures' host keys (first registration wins).
    fn trust_fixture_host_keys() {
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };
        struct TrustLocalFixtures;
        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustLocalFixtures {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }
        let _ = set_host_key_verifier(Arc::new(TrustLocalFixtures));
    }

    #[tokio::test]
    async fn ssh_tunnel_route_resolves_ready_with_the_default_folder() {
        let ssh_port = env_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201);
        let vnc_port = env_port("TERMIHUB_TEST_VNC_PORT", 2501);
        if !fixture_ready("ssh-password", ssh_port) || !fixture_ready("vnc-server", vnc_port) {
            return;
        }
        trust_fixture_host_keys();
        let settings = json!({
            "host": "vnc-server",
            "port": 5900,
            "password": "testpass",
            "useSshTunnel": true,
            "sshHost": "127.0.0.1",
            "sshPort": ssh_port,
            "sshUsername": "testuser",
            "sshPassword": "testpass",
            "fileTransfer": true,
        });
        let mut vnc = Vnc::new();
        vnc.connect(settings.clone())
            .await
            .expect("VNC through the SSH tunnel");
        let g = vnc.graphical().expect("graphical");
        let backend = BackendSideChannel {
            channel: g.file_side_channel(),
            session: g.file_side_channel_ssh_session(),
        };

        let result = resolve_file_channel(&ctx(settings, None), backend, None).await;
        let RemoteDesktopFileChannel::Ready {
            channel,
            agent_id,
            default_dir,
        } = result
        else {
            panic!("expected ready, got {result:?}");
        };
        assert_eq!(channel.kind, FileSideChannelKind::Ssh);
        assert_eq!(channel.user, "testuser");
        assert!(!channel.same_host, "vnc-server is not the SSH host");
        assert_eq!(agent_id, None);
        assert!(
            default_dir == "/home/testuser" || default_dir == "/home/testuser/Desktop",
            "{default_dir}"
        );
        vnc.disconnect().await.expect("disconnect");
    }

    /// The saved `ssh-password` fixture linked to a direct VNC connection.
    struct FixtureLink(SshConfig);

    #[async_trait::async_trait]
    impl LinkedSshSource for FixtureLink {
        fn lookup(&self, _connection_id: &str, _supplied: Option<&str>) -> LinkedLookup {
            LinkedLookup::Found(Box::new(LinkedSshTarget {
                connection_id: "Lab/Fixture".to_string(),
                name: "Fixture".to_string(),
                config: self.0.clone(),
                ask_again: None,
            }))
        }
    }

    /// The linked route end to end (#4194): a direct VNC connection linked to
    /// a saved SSH connection opens its own SSH session, reads the default
    /// folder over SFTP, and reuses that session on the next resolution.
    #[tokio::test]
    async fn linked_ssh_route_resolves_ready_and_reuses_its_session() {
        let ssh_port = env_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201);
        if !fixture_ready("ssh-password", ssh_port) {
            return;
        }
        trust_fixture_host_keys();
        let link = LinkedResolver {
            source: Arc::new(FixtureLink(SshConfig {
                host: "127.0.0.1".to_string(),
                port: ssh_port,
                username: "testuser".to_string(),
                auth_method: "password".to_string(),
                password: Some("testpass".to_string()),
                ..SshConfig::default()
            })),
            cache: LinkedSshCache::default(),
        };
        let settings = json!({
            "host": "office-pc",
            "fileTransfer": true,
            "fileTransferVia": "Lab/Fixture",
        });
        let context = ctx(settings, None);
        let (result, first) =
            resolve_file_channel_routed(&context, BackendSideChannel::default(), None, Some(&link))
                .await;
        let RemoteDesktopFileChannel::Ready {
            channel,
            default_dir,
            ..
        } = result
        else {
            panic!("expected ready, got {result:?}");
        };
        assert_eq!(channel.kind, FileSideChannelKind::Ssh);
        assert_eq!(channel.host, "127.0.0.1");
        assert_eq!(channel.linked_connection.as_deref(), Some("Fixture"));
        assert!(!channel.same_host, "office-pc is not the SSH host");
        assert!(default_dir.starts_with("/home/testuser"), "{default_dir}");
        let (_, second) =
            resolve_file_channel_routed(&context, BackendSideChannel::default(), None, Some(&link))
                .await;
        assert!(
            Arc::ptr_eq(&first.expect("session"), &second.expect("session")),
            "the linked session is reused"
        );
    }
}

/// #4348: an RDP session — even agent-hosted, where the agent route exists —
/// reports `notOffered`, not `disabled` (which would point to a "File
/// Transfer" setting RDP does not have).
#[tokio::test]
async fn a_type_without_the_feature_reports_not_offered() {
    let settings = json!({ "host": "office-pc" });
    let result = resolve_file_channel(
        &FileChannelContext::for_type(false, &settings, agent_route("localhost")),
        ssh_backend(true),
        agents(FakeAgent::with_desktop(true)),
    )
    .await;
    assert_eq!(
        result,
        RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::NotOffered
        }
    );
    // A type that offers it still reads its opt-in (off → Disabled).
    let result = resolve_file_channel(
        &FileChannelContext::for_type(true, &settings, agent_route("localhost")),
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
    assert_eq!(
        serde_json::to_value(RemoteDesktopFileChannel::Unavailable {
            reason: FileChannelUnavailable::NotOffered
        })
        .unwrap(),
        json!({ "status": "unavailable", "reason": "notOffered" })
    );
}
