//! File-transfer side channel of a graphical session (#3770 phase 1, #4191).
//!
//! VNC moves files over the carrier the connection already has, never over
//! RFB: SFTP on the VNC SSH tunnel's own session, or the hosting agent's
//! host-level `connection.files.*` service (#3241 port forward). This module
//! turns a live session into the `remote_desktop_file_channel` answer the
//! frontend builds on — the route, `user@host`, and the resolved default
//! folder — or a typed reason why there is none.
//!
//! Rules, enforced here rather than only in the UI: the feature is off unless
//! the connection opted in (`fileTransfer`), refused in view-only sessions, the
//! agent route wins over an SSH tunnel, and a direct connection has no route.
//! Route resolution runs on every call against the session's *current*
//! backend, so a VNC reconnect (which builds a new backend and tunnel)
//! re-resolves it by itself.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::{SftpAdvancedOps, SftpFileBrowser};
use termihub_core::connection::graphical_files::{
    default_dir, desktop_dir, expand_remote_dir, is_same_host, resolve_file_side_channel,
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

/// What a graphical session remembers from its settings for file-channel
/// resolution. Captured at connect time — the settings an agent-routed backend
/// dials with no longer carry the agent route.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FileChannelContext {
    policy: FileChannelPolicy,
    configured_dir: Option<String>,
    agent: Option<AgentFileRoute>,
}

impl FileChannelContext {
    /// Read the policy (`fileTransfer`, `viewOnly`) and the default folder
    /// (`fileTransferDir`) from `settings`; `agent` is the session's agent route.
    pub(crate) fn new(settings: &Value, agent: Option<AgentFileRoute>) -> Self {
        let configured_dir = settings
            .get(FILE_TRANSFER_DIR_KEY)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        Self {
            policy: FileChannelPolicy::from_settings(settings),
            configured_dir,
            agent,
        }
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
    }
}

/// Resolve the session's file channel and, for a usable route, its default
/// folder. Never errors: a refused host becomes [`RemoteDesktopFileChannel::Degraded`].
pub(crate) async fn resolve_file_channel(
    ctx: &FileChannelContext,
    backend: BackendSideChannel,
    agents: Option<Arc<dyn AgentFiles>>,
) -> RemoteDesktopFileChannel {
    let agent = ctx
        .agent
        .as_ref()
        .map(|route| agent_channel(agents.as_deref(), route));
    let channel = match resolve_file_side_channel(ctx.policy, agent, backend.channel) {
        Ok(channel) => channel,
        Err(reason) => return RemoteDesktopFileChannel::Unavailable { reason },
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
            let dir = match backend.session {
                Some(session) => ssh_default_dir(session, configured.as_deref()).await,
                None => Err("The SSH tunnel is not connected".to_string()),
            };
            (None, dir)
        }
    };
    match dir {
        Ok(default_dir) => RemoteDesktopFileChannel::Ready {
            channel,
            agent_id,
            default_dir,
        },
        Err(message) => RemoteDesktopFileChannel::Degraded {
            message: format!("File transfer to {} is unavailable: {message}", channel.host),
            channel,
            agent_id,
        },
    }
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
