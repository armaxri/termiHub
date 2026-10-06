//! "Browse remote files" of a graphical session (#4193, concept
//! `vnc-clipboard-file-transfer` phase 3).
//!
//! Opening registers the session's file side channel (SFTP on the VNC SSH
//! tunnel, or the hosting agent's host-level file service) with the session
//! layer under the graphical session id, so the ordinary File Browser sidebar
//! lists it through `session_list_files` and downloads it through
//! `session_download` (the Transfers queue: progress, pause, cancel, retry).
//! See [`crate::session::graphical_browse`].

use std::sync::Arc;

use tauri::State;
use tracing::debug;

use crate::commands::remote_desktop::upload_carrier;
use crate::session::graphical_browse::{RemoteDesktopFileBrowser, SideChannelBrowsers};
use crate::session::graphical_file_channel::{AgentFiles, RemoteDesktopFileChannel};
use crate::session::graphical_manager::GraphicalSessionManager;
use crate::session::graphical_upload::{resolve_dest_dir, AgentRequests};
use crate::session::manager::SessionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Open the File Browser on a graphical session's side channel (#4193).
///
/// Resolves the route like `remote_desktop_file_channel` and refuses unless it
/// is `ready` — off, view-only (the browser can rename and delete), no route or
/// a degraded carrier never open it. Registers the carrier under `session_id`
/// (replacing an earlier one, so a reconnect's new tunnel is picked up) and
/// answers the route line and the folder to open: `dir` when given (a leading
/// `~` is the account's home; it must be an existing folder), else the
/// session's default folder.
#[tauri::command]
pub async fn remote_desktop_open_file_browser(
    session_id: String,
    dir: Option<String>,
    manager: State<'_, GraphicalSessionManager>,
    sessions: State<'_, SessionManager>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<RemoteDesktopFileBrowser, TerminalError> {
    debug!(session_id, ?dir, "Remote desktop open file browser");
    let rpc: Arc<dyn AgentRpcClient> = agent_manager.inner().clone();
    let agents: Arc<dyn AgentFiles> = Arc::new(rpc.clone());
    let (channel, ssh) = manager
        .file_channel_with_session(&session_id, Some(agents))
        .await?;
    let requests: Arc<dyn AgentRequests> = Arc::new(rpc);
    open_side_channel(
        &sessions.side_channels,
        &session_id,
        channel,
        ssh,
        requests,
        dir,
    )
    .await
}

/// The body of [`remote_desktop_open_file_browser`] once the channel is
/// resolved: build the carrier, check the start folder, register it.
pub(crate) async fn open_side_channel(
    side_channels: &SideChannelBrowsers,
    session_id: &str,
    channel: RemoteDesktopFileChannel,
    ssh: Option<Arc<termihub_core::backends::ssh::handler::SshSession>>,
    agents: Arc<dyn AgentRequests>,
    dir: Option<String>,
) -> Result<RemoteDesktopFileBrowser, TerminalError> {
    let (carrier, channel, default_dir) = upload_carrier(channel, ssh, agents).await?;
    let destination = carrier.destination();
    let start_dir = resolve_dest_dir(destination.as_ref(), dir.as_deref(), &default_dir)
        .await
        .map_err(|e| carrier.error(format!("Cannot browse {}: {e}", channel.host)))?;
    side_channels.register(session_id, carrier);
    Ok(RemoteDesktopFileBrowser { channel, start_dir })
}

/// Close the File Browser source of a graphical session (#4193): later file
/// commands for its id fail as for an unknown session. Closing the session
/// does this too; an id with nothing open is a no-op.
#[tauri::command]
pub fn remote_desktop_close_file_browser(session_id: String, sessions: State<'_, SessionManager>) {
    if sessions.side_channels.remove(&session_id) {
        debug!(session_id, "Remote desktop file browser closed");
    }
}

#[cfg(test)]
#[path = "remote_desktop_browse_tests.rs"]
mod tests;
