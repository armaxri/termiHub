//! Offset-addressed slices for an agent-hosted session's queued transfer
//! (#3587).
//!
//! [`RemoteFileBrowserProxy`] turns `connection.files.read_range` /
//! `connection.files.write_range` (protocol 0.26.0) into the core
//! [`RangedFileAccess`] / [`RangedTransferTarget`] traits, so the shared
//! [`run_ranged_transfer`](termihub_core::files::transfer::ranged::run_ranged_transfer)
//! executor drives the transfer — progress, pause/resume, retry and cancel —
//! one bounded request per chunk. Offered only by an agent that advertises
//! `fileRanges`; see [`FileBrowser::ranged`].
//!
//! An agent that also advertises `fileTruncate` (protocol 0.41.0, #5736)
//! shortens a crashed upload's remote partial back to its last checkpoint
//! through `connection.files.truncate`, so the relaunched upload resumes there
//! instead of restarting from zero.

use termihub_core::errors::FileError;
use termihub_core::files::paste_guard::PathCanonicalizer;
use termihub_core::files::transfer::ranged::RangedTransferTarget;
use termihub_core::files::{FileBrowser, FileEntry, RangedFileAccess};
use termihub_core::protocol::methods::{
    FilesReadRangeParams, FilesReadRangeResult, FilesTruncateParams, FilesTruncateResult,
    FilesWriteRangeParams, CONNECTION_FILES_READ_RANGE, CONNECTION_FILES_TRUNCATE,
    CONNECTION_FILES_WRITE_RANGE,
};

use super::{base64_decode, RemoteFileBrowserProxy};
use crate::files::transfer::relaunch_agent::AgentSessionIdentity;

/// Read a `connection.files.truncate` reply (#5736) and confirm the file holds
/// exactly `len` bytes afterwards: any other size fails the trim, so the
/// upload restarts from zero instead of appending to a partial it could not
/// verify.
pub(crate) fn confirm_truncated(
    reply: serde_json::Value,
    path: &str,
    len: u64,
) -> Result<(), FileError> {
    let size = serde_json::from_value::<FilesTruncateResult>(reply)
        .map_err(|e| FileError::OperationFailed(format!("unexpected truncate reply: {e}")))?
        .size;
    if size == len {
        Ok(())
    } else {
        Err(FileError::OperationFailed(format!(
            "{path} holds {size} bytes after the trim, expected {len}"
        )))
    }
}

/// The `connection.files.truncate` params for `path` on `connection_id`
/// (`None`: the agent host itself).
pub(crate) fn truncate_params(
    connection_id: Option<String>,
    path: &str,
    len: u64,
) -> FilesTruncateParams {
    FilesTruncateParams {
        connection_id,
        path: path.to_string(),
        length: len,
    }
}

impl RemoteFileBrowserProxy {
    /// Ask the agent whether this session serves ranged slices: a zero-length
    /// read, which the agent answers without touching the backend. A session
    /// whose backend has no ranged access, or one started by an older session
    /// daemon, refuses it.
    pub async fn probe_ranges(&self) -> Result<(), FileError> {
        self.read_range("", 0, 0).await.map(|_| ())
    }

    /// Who serves this session (#4114): the agent, the agent-side session id
    /// and the saved definition it was opened from. Identities only — what a
    /// queued transfer records so a relaunch after a restart re-attaches to
    /// the same remote file system and never to another agent's.
    pub(crate) fn agent_session_identity(&self) -> AgentSessionIdentity {
        AgentSessionIdentity {
            agent_id: self.agent_id.clone(),
            remote_session_id: self.remote_session_id.clone(),
            definition_id: self.definition_id.clone(),
        }
    }
}

#[async_trait::async_trait]
impl RangedFileAccess for RemoteFileBrowserProxy {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        let result = self
            .rpc(
                CONNECTION_FILES_READ_RANGE,
                FilesReadRangeParams {
                    connection_id: Some(self.remote_session_id.clone()),
                    path: path.to_string(),
                    offset,
                    length: len,
                },
            )
            .await?;
        let parsed = serde_json::from_value::<FilesReadRangeResult>(result)
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        base64_decode(&parsed.data)
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        self.rpc(
            CONNECTION_FILES_WRITE_RANGE,
            FilesWriteRangeParams {
                connection_id: Some(self.remote_session_id.clone()),
                path: path.to_string(),
                offset,
                data: base64::engine::general_purpose::STANDARD.encode(data),
                create_new: false,
            },
        )
        .await?;
        Ok(())
    }

    /// The zero-length probe ([`probe_ranges`](Self::probe_ranges)), so a
    /// core executor gating on [`RangedFileAccess::probe`] asks the agent
    /// (#4115).
    async fn probe(&self) -> Result<(), FileError> {
        self.probe_ranges().await
    }
}

#[async_trait::async_trait]
impl RangedTransferTarget for RemoteFileBrowserProxy {
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        FileBrowser::stat(self, path).await
    }

    async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        FileBrowser::delete(self, path).await
    }

    /// `connection.files.truncate` (protocol 0.41.0, #5736): a crashed
    /// upload's partial is cut back to its checkpoint, confirmed by the size
    /// the agent measures afterwards. An agent that does not advertise
    /// `fileTruncate` is never asked — the upload restarts from zero with the
    /// usual row note — and a backend that cannot shorten (FTP), or a session
    /// started by an older agent's daemon, answers `-32013`, read the same.
    async fn truncate(&self, path: &str, len: u64) -> Result<(), FileError> {
        if !self.file_truncate {
            return Err(FileError::NotSupported);
        }
        let params = serde_json::to_value(truncate_params(
            Some(self.remote_session_id.clone()),
            path,
            len,
        ))
        .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        let mgr = self.agent_manager.clone();
        let agent_id = self.agent_id.clone();
        let reply = tokio::task::spawn_blocking(move || {
            mgr.send_file_request(&agent_id, CONNECTION_FILES_TRUNCATE, params)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("spawn_blocking join: {e}")))??;
        confirm_truncated(reply, path, len)
    }

    /// `connection.files.realpath` (#5333): the same-session copy guard sees
    /// through a symlink alias, so the ranged writer never opens its own
    /// source. An older agent's "method not found" leaves the lexical check.
    async fn realpath(&self, path: &str) -> Result<String, FileError> {
        PathCanonicalizer::realpath(self, path).await
    }

    /// The same filesystem the session's file browser reports (#5355), so a
    /// streamed copy between two sessions on one agent host runs the
    /// same-file guard.
    fn filesystem_id(&self) -> Option<termihub_core::files::shared_fs::FilesystemId> {
        FileBrowser::filesystem_id(self)
    }

    /// The same hint the session's file browser reports (#5430).
    fn filesystem_hint(&self) -> Option<termihub_core::files::shared_fs::FilesystemHint> {
        FileBrowser::filesystem_hint(self)
    }
}
