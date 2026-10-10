//! Browsing a graphical session's file side channel (#3770 phase 3, #4193).
//!
//! "Browse remote files" opens the ordinary File Browser sidebar on the
//! carrier phase 1 resolved (#4191) — there is no second browser. To reuse the
//! browser, its `session_*` file commands and the Transfers queue unchanged,
//! the carrier is registered here under the **graphical session id**; the
//! session layer's file facade resolves an id it does not know as a session
//! through this registry:
//!
//! - the **SSH route** registers the SFTP channel on the VNC tunnel's own
//!   authenticated SSH session
//!   ([`SftpFileBrowser`](termihub_core::backends::ssh::SftpFileBrowser)), so listings, downloads
//!   (the queued SFTP executor) and every SFTP extra work as for an SSH tab;
//! - the **agent route** registers the hosting agent's host-level
//!   `connection.files.*` service ([`AgentHostFiles`], every request without a
//!   `connectionId`), which implements [`FileBrowser`] below and drives queued
//!   downloads in ranged slices.
//!
//! A registration belongs to the graphical session's backend lifecycle, not
//! to the window that opened it (#4384): the
//! [`GraphicalSessionManager`](super::graphical_manager::GraphicalSessionManager)
//! re-opens it on the new tunnel / agent link after an automatic reconnect
//! (through a [`SideChannelOpener`]) and drops it when the session ends —
//! disconnected or resting for good. Opening the browser again replaces it.
//! A tab moved to another window, or a reloaded window, reads the open source
//! back with `remote_desktop_file_browser_source`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;

use termihub_core::errors::FileError;
use termihub_core::files::{FileAttributeOps, FileBrowser, FileEntry, RangedFileAccess};
use termihub_core::protocol::methods::{
    FilesCopyParams, FilesCreateSymlinkParams, FilesDeleteParams, FilesListParams, FilesListResult,
    FilesMkdirParams, FilesReadParams, FilesReadResult, FilesRenameParams, FilesSetOwnerParams,
    FilesSetPermissionsParams, FilesWriteParams, CONNECTION_FILES_COPY,
    CONNECTION_FILES_CREATE_SYMLINK, CONNECTION_FILES_DELETE, CONNECTION_FILES_LIST,
    CONNECTION_FILES_MKDIR, CONNECTION_FILES_READ, CONNECTION_FILES_RENAME,
    CONNECTION_FILES_SET_OWNER, CONNECTION_FILES_SET_PERMISSIONS, CONNECTION_FILES_WRITE,
};

use super::graphical_manager::GraphicalSessionManager;
use super::graphical_upload::{AgentHostFiles, UploadCarrier};
use crate::files::transfer::persist::PersistedGraphicalTarget;
use crate::utils::errors::TerminalError;

/// A file browser shared between the registry and the commands using it.
pub(crate) type SharedFileBrowser = Arc<dyn FileBrowser + Send + Sync>;

impl UploadCarrier {
    /// This carrier as a [`FileBrowser`], for the File Browser sidebar and the
    /// `session_*` file commands.
    pub(crate) fn file_browser(&self) -> SharedFileBrowser {
        match self {
            Self::Sftp(browser) => browser.clone(),
            Self::Agent(files) => files.clone(),
        }
    }

    /// The agent host's file service of the agent route.
    pub(crate) fn agent(&self) -> Option<Arc<AgentHostFiles>> {
        match self {
            Self::Agent(files) => Some(files.clone()),
            Self::Sftp(_) => None,
        }
    }
}

/// The side channels open for browsing, keyed by graphical session id.
///
/// Cheap to clone (shared map); owned by the session manager so its file
/// facade can resolve a graphical session id. The lock is held only to look
/// up, insert or remove — never across an `await`.
#[derive(Clone, Default)]
pub struct SideChannelBrowsers {
    map: Arc<StdMutex<HashMap<String, SideChannelEntry>>>,
}

/// One registered side channel: its carrier and, when the graphical session
/// was opened from a saved connection, the identity its transfers persist
/// (#4205).
#[derive(Clone)]
struct SideChannelEntry {
    carrier: UploadCarrier,
    target: Option<PersistedGraphicalTarget>,
    /// What "Browse remote files" opened (route line and folder), so a tab
    /// moved to another window or a reloaded window renders the same source
    /// (#4384). `None` for a registration made without the browser.
    source: Option<RemoteDesktopFileBrowser>,
}

/// A side channel re-opened on a graphical session's current backend after
/// an automatic reconnect (#4384).
pub(crate) struct ReopenedSideChannel {
    /// The carrier on the new tunnel / agent link.
    pub(crate) carrier: UploadCarrier,
    /// The identity its transfers persist (#4205), if any.
    pub(crate) target: Option<PersistedGraphicalTarget>,
    /// The route line of the re-opened channel.
    pub(crate) channel: termihub_core::connection::FileSideChannel,
}

/// Re-opens the side channel of a graphical session on its current backend
/// (#4384). The manager calls it when an automatic reconnect lifts a session
/// with an open side channel back to `Active`; production resolves the route
/// like `remote_desktop_open_file_browser`, tests substitute a fake.
#[async_trait::async_trait]
pub(crate) trait SideChannelOpener: Send + Sync {
    /// Resolve and build the side channel of `session_id` on `manager`'s
    /// current backend, or the reason it is not available now.
    async fn reopen(
        &self,
        manager: &GraphicalSessionManager,
        session_id: &str,
    ) -> Result<ReopenedSideChannel, TerminalError>;
}

impl SideChannelBrowsers {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SideChannelEntry>> {
        self.map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Register (or replace) the side channel of graphical session
    /// `session_id`, without a persisted identity or a browse source.
    #[cfg(test)]
    pub(crate) fn register(&self, session_id: &str, carrier: UploadCarrier) {
        self.lock().insert(
            session_id.to_string(),
            SideChannelEntry {
                carrier,
                target: None,
                source: None,
            },
        );
    }

    /// Register (or replace) the side channel "Browse remote files" opened
    /// for `session_id`; with `target`, its queued transfers are persisted
    /// under that identity so they resume after a restart (#4205). Remembers
    /// what it opened (`source`) so every window can render it (#4384).
    pub(crate) fn register_browse(
        &self,
        session_id: &str,
        carrier: UploadCarrier,
        target: Option<PersistedGraphicalTarget>,
        source: RemoteDesktopFileBrowser,
    ) {
        self.lock().insert(
            session_id.to_string(),
            SideChannelEntry {
                carrier,
                target,
                source: Some(source),
            },
        );
    }

    /// Swap in the side channel re-opened after a reconnect (#4384), keeping
    /// the folder the browser opened at. Only replaces a registration that is
    /// still open — one closed while the reconnect resolved stays closed.
    /// Returns whether it replaced one.
    pub(crate) fn replace_if_open(&self, session_id: &str, reopened: ReopenedSideChannel) -> bool {
        let mut map = self.lock();
        let Some(entry) = map.get_mut(session_id) else {
            return false;
        };
        entry.carrier = reopened.carrier;
        entry.target = reopened.target;
        if let Some(source) = entry.source.as_mut() {
            source.channel = reopened.channel;
        }
        true
    }

    /// What "Browse remote files" opened for `session_id`, if it is open
    /// (#4384).
    pub(crate) fn source(&self, session_id: &str) -> Option<RemoteDesktopFileBrowser> {
        self.lock().get(session_id).and_then(|e| e.source.clone())
    }

    /// Whether a side channel is open for `session_id`.
    pub(crate) fn contains(&self, session_id: &str) -> bool {
        self.lock().contains_key(session_id)
    }

    /// Drop the side channel of `session_id`; `true` when one was open.
    pub(crate) fn remove(&self, session_id: &str) -> bool {
        self.lock().remove(session_id).is_some()
    }

    /// The side channel of `session_id`, if one is open.
    pub(crate) fn get(&self, session_id: &str) -> Option<UploadCarrier> {
        self.lock().get(session_id).map(|e| e.carrier.clone())
    }

    /// The identity a transfer over the side channel of `session_id`
    /// persists (#4205): `None` when none is open or its session was not
    /// opened from a saved connection.
    pub(crate) fn target(&self, session_id: &str) -> Option<PersistedGraphicalTarget> {
        self.lock().get(session_id).and_then(|e| e.target.clone())
    }
}

/// The answer of `remote_desktop_open_file_browser`: what the File Browser
/// sidebar needs to show the side channel and label it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopFileBrowser {
    /// The route, file host, account and same-host verdict (the route line).
    #[cfg_attr(test, ts(type = "import(\"./FileSideChannel\").FileSideChannel"))]
    pub channel: termihub_core::connection::FileSideChannel,
    /// The absolute folder the browser opens at: the requested one (a
    /// leading `~` is the account's home) or the session's default folder.
    pub start_dir: String,
}

// ── The agent host as a FileBrowser ─────────────────────────────────

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, FileError> {
    serde_json::from_value(value).map_err(|e| FileError::OperationFailed(e.to_string()))
}

fn path_params(path: &str) -> (Option<String>, String) {
    (None, path.to_string())
}

/// The agent host's own file system, browsed through the agent's host-level
/// `connection.files.*` service: every request carries **no**
/// `connectionId`.
#[async_trait::async_trait]
impl FileBrowser for AgentHostFiles {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let (connection_id, path) = path_params(path);
        let value = self
            .call(
                CONNECTION_FILES_LIST,
                FilesListParams {
                    connection_id,
                    path,
                },
            )
            .await?;
        parse::<FilesListResult>(value).map(|r| r.entries)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        use base64::Engine;
        let (connection_id, path) = path_params(path);
        let value = self
            .call(
                CONNECTION_FILES_READ,
                FilesReadParams {
                    connection_id,
                    path,
                },
            )
            .await?;
        let parsed = parse::<FilesReadResult>(value)?;
        base64::engine::general_purpose::STANDARD
            .decode(parsed.data)
            .map_err(|e| FileError::OperationFailed(format!("Base64 decode failed: {e}")))
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        let (connection_id, path) = path_params(path);
        self.call(
            CONNECTION_FILES_WRITE,
            FilesWriteParams {
                connection_id,
                path,
                data: base64::engine::general_purpose::STANDARD.encode(data),
            },
        )
        .await
        .map(|_| ())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        // `is_directory` is advisory: the agent detects the entry kind itself.
        let (connection_id, path) = path_params(path);
        self.call(
            CONNECTION_FILES_DELETE,
            FilesDeleteParams {
                connection_id,
                path,
                is_directory: false,
            },
        )
        .await
        .map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.call(
            CONNECTION_FILES_RENAME,
            FilesRenameParams {
                connection_id: None,
                old_path: from.to_string(),
                new_path: to.to_string(),
            },
        )
        .await
        .map(|_| ())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        self.stat_entry(path).await
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let (connection_id, path) = path_params(path);
        self.call(
            CONNECTION_FILES_MKDIR,
            FilesMkdirParams {
                connection_id,
                path,
            },
        )
        .await
        .map(|_| ())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), FileError> {
        let (connection_id, path) = path_params(path);
        self.call(
            CONNECTION_FILES_SET_PERMISSIONS,
            FilesSetPermissionsParams {
                connection_id,
                path,
                mode,
            },
        )
        .await
        .map(|_| ())
    }

    async fn set_owner(
        &self,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> Result<(), FileError> {
        let (connection_id, path) = path_params(path);
        self.call(
            CONNECTION_FILES_SET_OWNER,
            FilesSetOwnerParams {
                connection_id,
                path,
                uid,
                gid,
            },
        )
        .await
        .map(|_| ())
    }

    async fn create_symlink(&self, target: &str, link_path: &str) -> Result<(), FileError> {
        self.call(
            CONNECTION_FILES_CREATE_SYMLINK,
            FilesCreateSymlinkParams {
                connection_id: None,
                target: target.to_string(),
                link_path: link_path.to_string(),
            },
        )
        .await
        .map(|_| ())
    }

    async fn copy(&self, src: &str, dest: &str) -> Result<(), FileError> {
        self.call(
            CONNECTION_FILES_COPY,
            FilesCopyParams {
                connection_id: None,
                src: src.to_string(),
                dest: dest.to_string(),
            },
        )
        .await
        .map(|_| ())
    }

    /// Lets the session layer recover the concrete service, so a queued
    /// transfer gets an owned handle for the ranged executor.
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }

    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        Some(self)
    }

    /// The agent forwards chmod / chown / symlink to its host's filesystem,
    /// exactly as for an agent-hosted local session (#4353): what the agent
    /// reports its host performs (#4601), else all three for an older agent.
    fn attribute_ops(&self) -> FileAttributeOps {
        crate::session::remote_proxy::hosted_attribute_ops(
            "local",
            false,
            self.host_file_attribute_ops(),
        )
    }
}

#[cfg(test)]
#[path = "graphical_browse_tests.rs"]
mod tests;
