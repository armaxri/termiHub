//! "Browse remote files" of a graphical session (#4193, concept
//! `vnc-clipboard-file-transfer` phase 3).
//!
//! Opening registers the session's file side channel (SFTP on the VNC SSH
//! tunnel, or the hosting agent's host-level file service) with the session
//! layer under the graphical session id, so the ordinary File Browser sidebar
//! lists it through `session_list_files` and downloads it through
//! `session_download` (the Transfers queue: progress, pause, cancel, retry).
//! See [`crate::session::graphical_browse`].
//!
//! The registration belongs to the graphical session's own lifecycle (#4384):
//! the manager re-opens it after an automatic reconnect ([`AppSideChannelOpener`])
//! and drops it when the session ends, so no window closes it. Opening is
//! ownership-gated like input and clipboard; a tab moved to another window, or
//! a reloaded window, reads the open source back with
//! [`remote_desktop_file_browser_source`].

use std::sync::Arc;

use tauri::State;
use tracing::debug;

use crate::commands::remote_desktop::{require_files_control, upload_carrier};
use crate::session::graphical_browse::{
    RemoteDesktopFileBrowser, ReopenedSideChannel, SideChannelBrowsers, SideChannelOpener,
};
use crate::session::graphical_file_channel::{AgentFiles, RemoteDesktopFileChannel};
use crate::session::graphical_manager::GraphicalSessionManager;
use crate::session::graphical_upload::{resolve_dest_dir, AgentRequests};
use crate::session::manager::SessionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;
use crate::window::WindowManager;

/// Open the File Browser on a graphical session's side channel (#4193).
///
/// Resolves the route like `remote_desktop_file_channel` and refuses unless it
/// is `ready` — off, view-only (the browser can rename and delete), no route or
/// a degraded carrier never open it. Registers the carrier under `session_id`
/// (replacing an earlier one, so a reconnect's new tunnel is picked up) and
/// answers the route line and the folder to open: `dir` when given (a leading
/// `~` is the account's home; it must be an existing folder), else the
/// session's default folder.
///
/// Ownership-gated (#4384): refused for a window another window has taken the
/// session over from.
#[tauri::command]
pub async fn remote_desktop_open_file_browser(
    session_id: String,
    dir: Option<String>,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
    sessions: State<'_, SessionManager>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<RemoteDesktopFileBrowser, TerminalError> {
    require_files_control(&window_manager, &session_id, window.label())?;
    debug!(session_id, ?dir, "Remote desktop open file browser");
    let rpc: Arc<dyn AgentRpcClient> = agent_manager.inner().clone();
    let agents: Arc<dyn AgentFiles> = Arc::new(rpc.clone());
    let (channel, ssh) = manager
        .file_channel_with_session(&session_id, Some(agents))
        .await?;
    let requests: Arc<dyn AgentRequests> = Arc::new(rpc);
    let saved_connection = manager.saved_connection_of(&session_id).await;
    open_side_channel(
        &sessions.side_channels,
        &session_id,
        channel,
        ssh,
        requests,
        dir,
        saved_connection.as_deref(),
    )
    .await
}

/// The body of [`remote_desktop_open_file_browser`] once the channel is
/// resolved: build the carrier, check the start folder, register it — with
/// the identity its transfers persist when `saved_connection_id` names the
/// saved connection the session was opened from (#4205).
pub(crate) async fn open_side_channel(
    side_channels: &SideChannelBrowsers,
    session_id: &str,
    channel: RemoteDesktopFileChannel,
    ssh: Option<Arc<termihub_core::backends::ssh::handler::SshSession>>,
    agents: Arc<dyn AgentRequests>,
    dir: Option<String>,
    saved_connection_id: Option<&str>,
) -> Result<RemoteDesktopFileBrowser, TerminalError> {
    let (carrier, channel, default_dir) = upload_carrier(channel, ssh, agents).await?;
    let destination = carrier.destination();
    let start_dir = resolve_dest_dir(destination.as_ref(), dir.as_deref(), &default_dir)
        .await
        .map_err(|e| carrier.error(format!("Cannot browse {}: {e}", channel.host)))?;
    // Its downloads and uploads persist under the side channel's identity
    // when the session came from a saved connection, so one cut off by
    // quitting resumes after a restart (#4205).
    let target = crate::files::transfer::relaunch_graphical::side_channel_target(
        saved_connection_id,
        &channel,
        &carrier,
    );
    let opened = RemoteDesktopFileBrowser { channel, start_dir };
    side_channels.register_browse(session_id, carrier, target, opened.clone());
    Ok(opened)
}

/// The File Browser source "Browse remote files" opened for a graphical
/// session, if it is open (#4384) — what a tab moved in from another window,
/// or a reloaded window, renders. `None` once the session ended or before it
/// was opened. Read-only route metadata (the route line and folder), so it is
/// not ownership-gated: an evicted window keeps showing the same source.
#[tauri::command]
pub fn remote_desktop_file_browser_source(
    session_id: String,
    sessions: State<'_, SessionManager>,
) -> Option<RemoteDesktopFileBrowser> {
    sessions.side_channels.source(&session_id)
}

/// Re-opens a graphical session's side channel on its current backend after
/// an automatic reconnect (#4384), the way
/// [`remote_desktop_open_file_browser`] opens it: installed on the
/// [`GraphicalSessionManager`] at boot.
pub(crate) struct AppSideChannelOpener {
    /// The agent RPC client (the agent route, and an agent-hosted carrier).
    pub(crate) agents: Arc<dyn AgentRpcClient>,
}

#[async_trait::async_trait]
impl SideChannelOpener for AppSideChannelOpener {
    async fn reopen(
        &self,
        manager: &GraphicalSessionManager,
        session_id: &str,
    ) -> Result<ReopenedSideChannel, TerminalError> {
        let files: Arc<dyn AgentFiles> = Arc::new(self.agents.clone());
        let (channel, ssh) = manager
            .file_channel_with_session(session_id, Some(files))
            .await?;
        let requests: Arc<dyn AgentRequests> = Arc::new(self.agents.clone());
        let (carrier, channel, _) = upload_carrier(channel, ssh, requests).await?;
        let saved_connection = manager.saved_connection_of(session_id).await;
        let target = crate::files::transfer::relaunch_graphical::side_channel_target(
            saved_connection.as_deref(),
            &channel,
            &carrier,
        );
        Ok(ReopenedSideChannel {
            carrier,
            target,
            channel,
        })
    }
}

#[cfg(test)]
#[path = "remote_desktop_browse_tests.rs"]
mod tests;
