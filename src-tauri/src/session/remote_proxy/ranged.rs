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

use termihub_core::errors::FileError;
use termihub_core::files::transfer::ranged::RangedTransferTarget;
use termihub_core::files::{FileBrowser, FileEntry, RangedFileAccess};
use termihub_core::protocol::methods::{
    FilesReadRangeParams, FilesReadRangeResult, FilesWriteRangeParams, CONNECTION_FILES_READ_RANGE,
    CONNECTION_FILES_WRITE_RANGE,
};

use super::{base64_decode, RemoteFileBrowserProxy};
use crate::files::transfer::relaunch_agent::AgentSessionIdentity;

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
}
