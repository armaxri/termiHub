//! File-transfer side channel of a graphical session (#3770 phase 1, #4191).
//!
//! VNC moves files over the carrier the connection already has, never over
//! RFB: SFTP on the VNC SSH tunnel's own session, or the hosting agent's
//! host-level `connection.files.*` service (#3241 port forward). This module
//! turns a live session into the `remote_desktop_file_channel` answer the
//! frontend builds on — the route, `user@host`, and the resolved default
//! folder — or a typed reason why there is none.
//!
//! A direct connection may link a saved SSH connection as its route (#4194,
//! `fileTransferVia`): the session then opens its own SSH session to that
//! connection — its stored secret, its jump hosts, the usual host-key trust —
//! and moves files over SFTP on it. The session is kept for the graphical
//! session's lifetime and reused, and dropped as soon as the link no longer
//! resolves (the connection was deleted) or its SSH session died.
//!
//! Rules, enforced here rather than only in the UI: the feature is off unless
//! the connection opted in (`fileTransfer`), refused in view-only sessions, the
//! agent route wins over an SSH tunnel, which wins over a linked SSH
//! connection, and a direct connection without a (resolvable) link has no
//! route.
//! Route resolution runs on every call against the session's *current*
//! backend, so a VNC reconnect (which builds a new backend and tunnel)
//! re-resolves it by itself.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::session_pool::{PooledRef, SshGateway};
use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::config::SshConfig;
use termihub_core::connection::graphical_files::{
    default_dir, desktop_dir, expand_remote_dir, is_same_host, linked_ssh_channel,
    resolve_file_side_channel, FILE_TRANSFER_VIA_KEY,
};
use termihub_core::connection::{
    FileChannelPolicy, FileChannelUnavailable, FileSideChannel, FileSideChannelKind,
};
use termihub_core::files::{FileBrowser, FileEntry};
use termihub_core::protocol::methods::CONNECTION_FILES_STAT;

use crate::terminal::agent_manager::AgentRpcClient;

/// The settings key of the connection's default destination folder.
const FILE_TRANSFER_DIR_KEY: &str = "fileTransferDir";

/// The agent carrying an agent-routed graphical session (#3241), as the file
/// channel needs it: which agent, and the target as seen from the agent host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentFileRoute {
    pub agent_id: String,
    pub target_host: String,
}

/// The saved SSH connection a direct graphical session links as its file
/// route (#4194), and the VNC host it is compared with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkedFileRoute {
    /// The saved SSH connection's id (`fileTransferVia`).
    pub connection_id: String,
    /// The VNC host, as dialled from this computer.
    pub target_host: String,
}

/// What a graphical session remembers from its settings for file-channel
/// resolution. Captured at connect time — the settings an agent-routed backend
/// dials with no longer carry the agent route.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FileChannelContext {
    policy: FileChannelPolicy,
    configured_dir: Option<String>,
    agent: Option<AgentFileRoute>,
    linked: Option<LinkedFileRoute>,
}

impl FileChannelContext {
    /// Read the policy (`fileTransfer`, `viewOnly`), the default folder
    /// (`fileTransferDir`) and the linked SSH connection (`fileTransferVia`)
    /// from `settings`; `agent` is the session's agent route. The link is kept
    /// only for a direct connection — neither agent-hosted nor SSH-tunnelled —
    /// so a stale link never stands in for a tunnel that is down.
    pub(crate) fn new(settings: &Value, agent: Option<AgentFileRoute>) -> Self {
        let text = |key: &str| {
            settings
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let tunnelled = settings.get("useSshTunnel").and_then(Value::as_bool) == Some(true);
        let linked = match (&agent, tunnelled, text(FILE_TRANSFER_VIA_KEY)) {
            (None, false, Some(connection_id)) => Some(LinkedFileRoute {
                connection_id,
                target_host: text("host").unwrap_or_default(),
            }),
            _ => None,
        };
        Self {
            policy: FileChannelPolicy::from_settings(settings),
            configured_dir: text(FILE_TRANSFER_DIR_KEY),
            agent,
            linked,
        }
    }
}

/// A linked saved SSH connection, ready to connect: the settings resolved
/// into an [`SshConfig`] with its stored secret (in memory only) and its
/// jump-host chain expanded.
#[derive(Clone)]
pub(crate) struct LinkedSshTarget {
    pub connection_id: String,
    /// The connection's display name, shown as the route's carrier.
    pub name: String,
    pub config: SshConfig,
}

/// What looking up a linked saved SSH connection found (#4194).
#[derive(Clone)]
pub(crate) enum LinkedLookup {
    /// No saved SSH connection has the id (it was deleted, or is not an SSH
    /// connection): the session has no linked route.
    Missing,
    /// The connection exists but cannot be connected without the user (no
    /// stored secret, a locked store, an ambiguous id, a broken jump host).
    Unusable {
        name: String,
        host: String,
        user: String,
        /// Why, phrased to follow "File transfer to {host} is unavailable: ".
        message: String,
    },
    /// The connection, ready to connect.
    Found(Box<LinkedSshTarget>),
}

/// An SSH session opened to a linked saved SSH connection, with the pooled
/// jump-host gateway it rides when it has one.
pub(crate) struct LinkedSshConnection {
    session: Arc<SshSession>,
    _gateway: Option<PooledRef<Arc<SshGateway>>>,
}

/// Connect a linked saved SSH connection: directly, or through its pooled
/// jump-host gateway. Attended — an unknown host key is put to the user by the
/// registered host-key verifier, exactly as for any SSH connect.
pub(crate) async fn connect_linked_ssh(config: &SshConfig) -> Result<LinkedSshConnection, String> {
    if config.proxy_jump.is_empty() {
        let (session, _registry) =
            termihub_core::backends::ssh::auth::connect_and_authenticate(config)
                .await
                .map_err(|e| e.to_string())?;
        return Ok(LinkedSshConnection {
            session: Arc::new(session),
            _gateway: None,
        });
    }
    let (session, _registry, gateway, _liveness) =
        termihub_core::backends::ssh::jump_host::connect_target_through_pooled_gateway_with_liveness(
            config, None,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(LinkedSshConnection {
        session: Arc::new(session),
        _gateway: Some(gateway),
    })
}

/// Where linked saved SSH connections come from — a seam so route resolution
/// is testable without the connection store or a live server.
#[async_trait]
pub(crate) trait LinkedSshSource: Send + Sync {
    /// Look the saved SSH connection `connection_id` up (blocking: it reads the
    /// connection files and the credential store).
    fn lookup(&self, connection_id: &str) -> LinkedLookup;

    /// Open an SSH session to the looked-up connection.
    async fn connect(&self, config: &SshConfig) -> Result<LinkedSshConnection, String> {
        connect_linked_ssh(config).await
    }
}

/// Identifies the linked SSH session a cache holds: a different connection,
/// or the same one edited to point elsewhere, needs a new session.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkedKey {
    connection_id: String,
    host: String,
    port: u16,
    username: String,
}

impl LinkedKey {
    fn of(target: &LinkedSshTarget) -> Self {
        Self {
            connection_id: target.connection_id.clone(),
            host: target.config.host.clone(),
            port: target.config.port,
            username: target.config.username.clone(),
        }
    }
}

/// A graphical session's open linked SSH session, if any (#4194). Held for the
/// session's lifetime and reused across resolutions; the lock is held while
/// connecting, so concurrent resolutions never open (or prompt for) a second
/// session.
#[derive(Clone, Default)]
pub(crate) struct LinkedSshCache(Arc<tokio::sync::Mutex<Option<(LinkedKey, LinkedSshConnection)>>>);

/// The linked-route seam and the session's cache, as route resolution takes
/// them.
pub(crate) struct LinkedResolver {
    pub source: Arc<dyn LinkedSshSource>,
    pub cache: LinkedSshCache,
}

/// What resolving a linked route produced.
enum LinkedRoute {
    /// No usable link: no route from it.
    None,
    /// The link resolved and its session is up.
    Ready(FileSideChannel, Arc<SshSession>),
    /// The link resolved but its host refused or cannot be signed in to.
    Degraded(FileSideChannel, String),
}

/// Resolve the linked saved SSH connection of `route`: look it up, reuse the
/// cached session when it is still open and still for the same connection,
/// else connect a new one. A link that no longer resolves clears the cache,
/// so no stale session outlives its connection.
async fn resolve_linked_route(route: &LinkedFileRoute, linked: &LinkedResolver) -> LinkedRoute {
    let source = linked.source.clone();
    let id = route.connection_id.clone();
    let lookup = tokio::task::spawn_blocking(move || source.lookup(&id))
        .await
        .unwrap_or(LinkedLookup::Missing);
    let mut cache = linked.cache.0.lock().await;
    let target = match lookup {
        LinkedLookup::Missing => {
            *cache = None;
            return LinkedRoute::None;
        }
        LinkedLookup::Unusable {
            name,
            host,
            user,
            message,
        } => {
            *cache = None;
            let channel = linked_ssh_channel(&route.target_host, &host, &user, &name);
            return LinkedRoute::Degraded(channel, message);
        }
        LinkedLookup::Found(target) => target,
    };
    let channel = linked_ssh_channel(
        &route.target_host,
        &target.config.host,
        &target.config.username,
        &target.name,
    );
    let key = LinkedKey::of(&target);
    if let Some((held, conn)) = cache.as_ref() {
        if *held == key && !conn.session.is_closed() {
            return LinkedRoute::Ready(channel, conn.session.clone());
        }
    }
    *cache = None;
    match linked.source.connect(&target.config).await {
        Ok(conn) => {
            let session = conn.session.clone();
            *cache = Some((key, conn));
            LinkedRoute::Ready(channel, session)
        }
        Err(e) => LinkedRoute::Degraded(channel, e),
    }
}

/// The answer of `remote_desktop_file_channel` (#4191) — the phase-1 command
/// contract the drop overlay, Files popover and File Browser build on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RemoteDesktopFileChannel {
    /// A route exists and its host answered: files can move.
    #[serde(rename_all = "camelCase")]
    Ready {
        /// The route, file host, account and same-host verdict.
        #[cfg_attr(test, ts(type = "import(\"./FileSideChannel\").FileSideChannel"))]
        channel: FileSideChannel,
        /// The agent to address `connection.files.*` to (no `connectionId`),
        /// for an agent route; `None` for the SSH route.
        agent_id: Option<String>,
        /// Absolute default destination folder on the file host: the
        /// connection's folder, else `~/Desktop` when it exists, else `~`.
        default_dir: String,
    },
    /// A route exists but its host refused (SFTP disabled on the SSH server,
    /// the agent disconnected, …). VNC keeps running; a retry may succeed.
    #[serde(rename_all = "camelCase")]
    Degraded {
        #[cfg_attr(test, ts(type = "import(\"./FileSideChannel\").FileSideChannel"))]
        channel: FileSideChannel,
        agent_id: Option<String>,
        /// The user-facing reason.
        message: String,
    },
    /// No file transfer for this session.
    Unavailable {
        #[cfg_attr(
            test,
            ts(type = "import(\"./FileChannelUnavailable\").FileChannelUnavailable")
        )]
        reason: FileChannelUnavailable,
    },
}

/// What the session's current backend contributes: its own (SSH tunnel)
/// channel and the session to open SFTP on. Read under the connection lock,
/// used after it is released.
#[derive(Default)]
pub(crate) struct BackendSideChannel {
    pub channel: Option<FileSideChannel>,
    pub session: Option<Arc<SshSession>>,
}

/// The agent calls the agent route needs — a seam so route resolution is
/// testable without a live agent. Blocking (agent RPCs are synchronous).
pub(crate) trait AgentFiles: Send + Sync {
    fn is_connected(&self, agent_id: &str) -> bool;
    /// `(host, user)` the agent runs on, when known.
    fn endpoint(&self, agent_id: &str) -> Option<(String, String)>;
    /// `connection.files.stat` on the agent host (no `connectionId`).
    fn stat(&self, agent_id: &str, path: &str) -> Result<FileEntry, String>;
}

impl AgentFiles for Arc<dyn AgentRpcClient> {
    fn is_connected(&self, agent_id: &str) -> bool {
        AgentRpcClient::is_connected(self.as_ref(), agent_id)
    }

    fn endpoint(&self, agent_id: &str) -> Option<(String, String)> {
        self.agent_endpoint(agent_id)
    }

    fn stat(&self, agent_id: &str, path: &str) -> Result<FileEntry, String> {
        let value = self
            .send_request(agent_id, CONNECTION_FILES_STAT, json!({ "path": path }))
            .map_err(|e| e.to_string())?;
        serde_json::from_value(value).map_err(|e| format!("unexpected stat reply: {e}"))
    }
}

/// The agent route's channel: the file host is the agent host (falling back to
/// the agent id when the agent's address is unknown).
fn agent_channel(agents: Option<&dyn AgentFiles>, route: &AgentFileRoute) -> FileSideChannel {
    let (host, user) = agents
        .and_then(|a| a.endpoint(&route.agent_id))
        .unwrap_or_else(|| (route.agent_id.clone(), String::new()));
    FileSideChannel {
        kind: FileSideChannelKind::Agent,
        same_host: is_same_host(&route.target_host, &host),
        host,
        user,
        linked_connection: None,
    }
}

/// Resolve the session's file channel and, for a usable route, its default
/// folder. Never errors: a refused host becomes [`RemoteDesktopFileChannel::Degraded`].
/// Without the linked-route seam (see [`resolve_file_channel_routed`]).
#[cfg(test)]
pub(crate) async fn resolve_file_channel(
    ctx: &FileChannelContext,
    backend: BackendSideChannel,
    agents: Option<Arc<dyn AgentFiles>>,
) -> RemoteDesktopFileChannel {
    resolve_file_channel_routed(ctx, backend, agents, None)
        .await
        .0
}

/// Resolve the session's file channel — agent, SSH tunnel, then the linked
/// saved SSH connection (#4194) — and, for a usable route, its default folder.
/// Also returns the SSH session an SSH route's SFTP channel opens on (the
/// tunnel's or the linked connection's). Never errors: a refused host becomes
/// [`RemoteDesktopFileChannel::Degraded`]. The link is looked up only when
/// the policy allows file transfer and neither the agent nor a tunnel route
/// exists; without `linked` (no saved-connection store) it counts as none.
pub(crate) async fn resolve_file_channel_routed(
    ctx: &FileChannelContext,
    backend: BackendSideChannel,
    agents: Option<Arc<dyn AgentFiles>>,
    linked: Option<&LinkedResolver>,
) -> (RemoteDesktopFileChannel, Option<Arc<SshSession>>) {
    let agent = ctx
        .agent
        .as_ref()
        .map(|route| agent_channel(agents.as_deref(), route));
    let mut ssh_session = backend.session;
    let mut linked_channel = None;
    if agent.is_none() && backend.channel.is_none() && ctx.policy.refusal().is_none() {
        if let (Some(route), Some(linked)) = (&ctx.linked, linked) {
            match resolve_linked_route(route, linked).await {
                LinkedRoute::None => {}
                LinkedRoute::Ready(channel, session) => {
                    linked_channel = Some(channel);
                    ssh_session = Some(session);
                }
                LinkedRoute::Degraded(channel, message) => {
                    let message = format!(
                        "File transfer to {} is unavailable: {message}",
                        channel.host
                    );
                    let degraded = RemoteDesktopFileChannel::Degraded {
                        channel,
                        agent_id: None,
                        message,
                    };
                    return (degraded, None);
                }
            }
        }
    }
    let channel =
        match resolve_file_side_channel(ctx.policy, agent, backend.channel, linked_channel) {
            Ok(channel) => channel,
            Err(reason) => return (RemoteDesktopFileChannel::Unavailable { reason }, None),
        };
    let configured = ctx.configured_dir.clone();
    let (agent_id, dir) = match (&channel.kind, &ctx.agent) {
        (FileSideChannelKind::Agent, Some(route)) => {
            let id = route.agent_id.clone();
            let dir = match agents {
                Some(agents) => {
                    let blocking_id = id.clone();
                    tokio::task::spawn_blocking(move || {
                        agent_default_dir(agents.as_ref(), &blocking_id, configured.as_deref())
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("agent lookup failed: {e}")))
                }
                None => Err("The agent manager is not available".to_string()),
            };
            (Some(id), dir)
        }
        _ => {
            let dir = match ssh_session.clone() {
                Some(session) => ssh_default_dir(session, configured.as_deref()).await,
                None => Err("The SSH tunnel is not connected".to_string()),
            };
            (None, dir)
        }
    };
    let resolved = match dir {
        Ok(default_dir) => RemoteDesktopFileChannel::Ready {
            channel,
            agent_id,
            default_dir,
        },
        Err(message) => RemoteDesktopFileChannel::Degraded {
            message: format!(
                "File transfer to {} is unavailable: {message}",
                channel.host
            ),
            channel,
            agent_id,
        },
    };
    (resolved, ssh_session)
}

/// The default folder on the agent host, via `connection.files.stat`.
fn agent_default_dir(
    agents: &dyn AgentFiles,
    agent_id: &str,
    configured: Option<&str>,
) -> Result<String, String> {
    if !agents.is_connected(agent_id) {
        return Err("the agent is not connected".to_string());
    }
    let home = agents.stat(agent_id, "~")?.path;
    if let Some(dir) = configured.and_then(|c| expand_remote_dir(c, &home)) {
        return Ok(agents.stat(agent_id, &dir).map(|e| e.path).unwrap_or(dir));
    }
    let desktop_exists = agents
        .stat(agent_id, &desktop_dir(&home))
        .is_ok_and(|e| e.is_directory);
    Ok(default_dir(None, &home, desktop_exists))
}

/// The default folder on the SSH host, over an SFTP channel opened on the
/// tunnel's session (closed again when this returns).
async fn ssh_default_dir(
    session: Arc<SshSession>,
    configured: Option<&str>,
) -> Result<String, String> {
    let sftp = SftpFileBrowser::from_session(session)
        .await
        .map_err(|e| format!("SFTP is not enabled on the SSH server ({e})"))?;
    let home = sftp.realpath(".").await.map_err(|e| e.to_string())?;
    if let Some(dir) = configured.and_then(|c| expand_remote_dir(c, &home)) {
        return Ok(sftp.realpath(&dir).await.unwrap_or(dir));
    }
    let desktop_exists = sftp
        .stat(&desktop_dir(&home))
        .await
        .is_ok_and(|e| e.is_directory);
    Ok(default_dir(None, &home, desktop_exists))
}

#[cfg(test)]
#[path = "graphical_file_channel_tests.rs"]
mod tests;
