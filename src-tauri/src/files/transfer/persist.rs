//! Persisted transfer-queue records (PROD-0011).
//!
//! The transfer queue ([`super::registry::TransferRegistry`]) is entirely
//! in-memory: a restart loses every in-flight, queued, or paused transfer. This
//! module holds the **metadata-only** on-disk record that makes the queue durable
//! across restarts, mirroring the persisted workflow run-history store
//! (`crate::workflows::history`, PROD-0046) in shape and recovery discipline.
//!
//! # Security — metadata only, never secrets (the point of PROD-0011's care-zone)
//!
//! A persisted record carries only what is needed to *describe and re-locate* a
//! transfer: its id, the owning session id (a **reference** used to re-open the
//! session via the existing reconnect path — never the session's credentials),
//! the source/destination paths, direction, byte offset / resume offset, total
//! and transferred bytes, status, and timestamps. It deliberately holds **no**
//! credential or secret material (no password, no key, no FTP config): a
//! rehydrated transfer re-attaches through the normal session machinery, which
//! re-supplies any secret from the credential store at resume time. The
//! `no_credential_fields_are_serialized` test asserts this invariant.

use serde::{Deserialize, Serialize};

use super::state::TransferStateTag;
use super::TransferDirection;

/// The lifecycle status of a persisted transfer, mirroring the wire
/// [`TransferStateTag`] as a self-describing lowercase string so the on-disk
/// record reads the same as the live queue state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PersistedTransferStatus {
    Queued,
    Active,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl PersistedTransferStatus {
    /// Whether this status is one that should be **rehydrated** on startup: a
    /// transfer that had not settled when the app went away (queued, active, or
    /// paused). Completed/failed/cancelled transfers are terminal and are never
    /// rehydrated.
    pub fn is_incomplete(self) -> bool {
        matches!(
            self,
            PersistedTransferStatus::Queued
                | PersistedTransferStatus::Active
                | PersistedTransferStatus::Paused
        )
    }

    /// Whether this status is a settled outcome (completed/failed/cancelled) —
    /// the records that are pruned rather than kept.
    pub fn is_terminal(self) -> bool {
        !self.is_incomplete()
    }
}

impl From<TransferStateTag> for PersistedTransferStatus {
    fn from(tag: TransferStateTag) -> Self {
        match tag {
            TransferStateTag::Queued => PersistedTransferStatus::Queued,
            TransferStateTag::Active => PersistedTransferStatus::Active,
            TransferStateTag::Paused => PersistedTransferStatus::Paused,
            TransferStateTag::Completed => PersistedTransferStatus::Completed,
            TransferStateTag::Failed => PersistedTransferStatus::Failed,
            TransferStateTag::Cancelled => PersistedTransferStatus::Cancelled,
        }
    }
}

/// A single persisted, **metadata-only** transfer-queue record (PROD-0011).
///
/// Every field is camelCase on disk (matching the rest of the JSON stores). It
/// carries only references and progress metadata — never credentials or secrets
/// (see the module docs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTransfer {
    /// Stable transfer id (the backend `transferId`).
    pub transfer_id: String,
    /// Owning session id — a **reference** used to re-open the session via the
    /// existing reconnect path on resume. NOT a credential.
    pub session_id: String,
    /// Upload or download.
    pub direction: TransferDirection,
    /// Display file name.
    pub file_name: String,
    /// Remote path (the source for a download, the destination for an upload).
    pub remote_path: String,
    /// Local path (the destination for a download, the source for an upload).
    /// Absent for a remote-to-remote copy, which has no local endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// Lifecycle status at the time of the last persist.
    pub status: PersistedTransferStatus,
    /// Bytes transferred so far (a coarse checkpoint, not per-byte).
    pub transferred: u64,
    /// Total size in bytes, or `0` when indeterminate.
    pub total: u64,
    /// The byte offset a resume should restart from. Kept alongside
    /// `transferred` so a rehydrated transfer knows where to continue; the live
    /// resume path (PROD-0012) still byte-verifies the destination before using
    /// it.
    pub resume_offset: u64,
    /// Epoch-millis wall clock when the record was first created.
    pub created_at_ms: u64,
    /// Epoch-millis wall clock of the last update.
    pub updated_at_ms: u64,
    /// The container a Docker session transfer streams from/into (#3585) —
    /// absent for every other backend and for records written before it
    /// existed. A non-secret identity reference, used to re-attach after a
    /// restart (the owning session id does not survive one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker: Option<PersistedDockerTarget>,
    /// The cancel group a queued file of a local folder copy belongs to (#3613):
    /// every file of one folder copy shares it, so cancelling one file cancels
    /// the folder's rest — also after a relaunch. Absent for every other
    /// transfer and for records written before it existed. An opaque id, not a
    /// secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// The session folder paste (#3630) this file was copied for — the id of
    /// its manifest in [`PersistedTransferStore::folder_pastes`] (#3643). A
    /// record still linked to a recorded manifest at the next launch belongs
    /// to that paste's interrupted-paste notice, whose Retry re-copies the
    /// file, so it is dropped instead of rehydrating as its own paused row.
    /// Absent for every other transfer and for records written before it
    /// existed. An opaque id, not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_paste_id: Option<String>,
    /// Modification time of the source when the checkpointed bytes were read
    /// (#3572), in the executor backend's own unit (SFTP: seconds; local disk:
    /// nanoseconds; Docker: whatever its probe reports). Written together with
    /// `resume_offset`, so a relaunch can tell a source rewritten to the same
    /// size while the app was closed and restart from zero. Absent when the
    /// backend reports no mtime and for records written before it existed; a
    /// relaunch then falls back to the size-only check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_mtime: Option<u64>,
    /// The source endpoint of a remote-to-remote copy (#3206) — the session
    /// reference and path it reads from. `session_id` / `remote_path` describe
    /// the destination. Absent for every other transfer and for records
    /// written before it existed; such a remote-to-remote record cannot be
    /// relaunched after a restart. References and paths only, never secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_source: Option<PersistedRemoteSource>,
    /// The id of the saved connection the owning session was opened for
    /// (#3876) — absent for a session opened from an unsaved configuration and
    /// for records written before it existed. When the session is gone after a
    /// restart, a relaunch looks the connection up by this id and re-sources
    /// its password or key passphrase from the credential store under the
    /// connection's existing store key. The id only — never a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_connection_id: Option<String>,
    /// The agent-hosted session a ranged transfer runs over (#4114) — or, for
    /// a remote-to-remote copy, the session its destination is written to
    /// (#4115). Absent for every other backend and for records written before
    /// it existed.
    /// Identities only, never a secret: the owning desktop session id does
    /// not survive a restart, so a relaunch finds the reconnected session by
    /// these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<PersistedAgentTarget>,
}

/// The persisted identity of an agent-hosted transfer's session (#4114).
///
/// A relaunch re-attaches only to a live session on the **same agent** that is
/// either the same agent-side session (it survived on the agent) or one opened
/// from the same saved agent definition — the same remote file system. Ids
/// only; the session's credentials stay with the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentTarget {
    /// The agent the session runs on.
    pub agent_id: String,
    /// The agent-side session id the transfer streamed through.
    pub remote_session_id: String,
    /// The saved agent connection definition the session was opened from;
    /// absent for an ad-hoc agent session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<String>,
}

/// Where a remote-to-remote copy reads from (#3206): a session **reference**
/// (re-attached through the normal session path, which supplies credentials at
/// resume time) and the source path. Not a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRemoteSource {
    /// The source session id.
    pub session_id: String,
    /// The source file's path on that session.
    pub path: String,
    /// The saved connection the source session was opened for (#3876), so a
    /// relaunch can re-source the source end's secret when its session is
    /// gone. The id only — never a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_connection_id: Option<String>,
    /// The full id of the source container when the source is a Docker
    /// session (#3586), so a relaunch re-attaches to that exact container
    /// (see [`PersistedDockerTarget`]). Absent for an SFTP source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    /// The agent-hosted session the source is read from when it is a ranged
    /// end (#4115), so a relaunch finds that session again (see
    /// [`PersistedAgentTarget`]). Absent for an SFTP or Docker source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<PersistedAgentTarget>,
}

/// The persisted identity of a Docker transfer's container (#3585).
///
/// Only the **full container id** is kept — never a name: a container
/// recreated under the same name has a new id and a different filesystem, so
/// a relaunch that re-attaches by id can never resume into it. Not a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDockerTarget {
    /// Full container id the transfer streamed through.
    pub container_id: String,
}

impl PersistedTransfer {
    /// A copy of this record forced to [`PersistedTransferStatus::Paused`], for
    /// rehydration: an incomplete transfer always comes back paused so the user
    /// explicitly resumes it (never auto-resume — PROD-0011 decision).
    pub fn as_paused(&self) -> Self {
        Self {
            status: PersistedTransferStatus::Paused,
            ..self.clone()
        }
    }
}

/// Whether a folder paste copies or moves its folder (#3630).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "lowercase")]
pub enum FolderPasteOperation {
    Copy,
    Cut,
}

/// One side of a folder paste (#3630): the local disk (no `session_id`) or a
/// session's file system. Metadata only — never credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct FolderPasteEndpoint {
    /// The session the folder lives on, absent for the local disk. A session
    /// id does not survive a restart; it only identifies the endpoint while
    /// the app runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub session_id: Option<String>,
    /// The saved connection the session was opened from, when known — the
    /// reference a Retry after a restart uses to find the reconnected session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub connection_id: Option<String>,
    /// A display name for the endpoint (its tab title), for the notice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub label: Option<String>,
    /// The folder's path on this endpoint.
    pub path: String,
}

/// A folder paste driven file by file from the frontend (#3630), recorded
/// before its first file starts and removed once its last file landed. A
/// record that is still present at the next launch therefore marks a folder
/// that may be only partly copied, so the user can be told and offered a
/// Retry that continues the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[cfg_attr(test, ts(rename = "InterruptedFolderPaste"))]
#[serde(rename_all = "camelCase")]
pub struct PersistedFolderPaste {
    /// Opaque manifest id.
    pub id: String,
    /// Copy or move.
    pub operation: FolderPasteOperation,
    /// Where the folder is copied from.
    pub source: FolderPasteEndpoint,
    /// The folder path it is copied to.
    pub destination: FolderPasteEndpoint,
    /// Epoch-millis wall clock when the paste started.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number"))]
    pub started_at_ms: u64,
}

impl PersistedFolderPaste {
    /// Whether `other` pastes the same folder to the same place (labels
    /// ignored), so a newer paste replaces an older, unfinished record.
    pub fn same_target(&self, other: &Self) -> bool {
        let same = |a: &FolderPasteEndpoint, b: &FolderPasteEndpoint| {
            a.path == b.path && a.session_id == b.session_id && a.connection_id == b.connection_id
        };
        same(&self.source, &other.source) && same(&self.destination, &other.destination)
    }
}

/// The most unfinished folder-paste records retained on disk (oldest dropped).
pub const MAX_PERSISTED_FOLDER_PASTES: usize = 20;

/// The most-recent transfer records retained on disk. A count-based cap kept
/// deliberately simple and metadata-only; bounds the file if abandoned
/// (never-resumed) rehydrated transfers accumulate across restarts.
pub const MAX_PERSISTED_TRANSFERS: usize = 100;

/// Top-level schema for the `transfers.json` file (PROD-0011).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTransferStore {
    /// Schema version, read on load and gated by the migration layer.
    pub version: String,
    /// All persisted transfers, oldest-first (append/upsert order).
    pub transfers: Vec<PersistedTransfer>,
    /// Unfinished cross-session folder pastes (#3630). Absent in files written
    /// before it existed.
    #[serde(
        default,
        rename = "folderPastes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub folder_pastes: Vec<PersistedFolderPaste>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for PersistedTransferStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            transfers: Vec::new(),
            folder_pastes: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl PersistedTransferStore {
    /// Insert or replace a record by transfer id (upsert), then drop the oldest
    /// records beyond [`MAX_PERSISTED_TRANSFERS`].
    pub fn upsert(&mut self, entry: PersistedTransfer) {
        if let Some(existing) = self
            .transfers
            .iter_mut()
            .find(|t| t.transfer_id == entry.transfer_id)
        {
            *existing = entry;
        } else {
            self.transfers.push(entry);
        }
        self.cap();
    }

    /// Remove a record by transfer id. Returns whether one was removed.
    pub fn remove(&mut self, transfer_id: &str) -> bool {
        let before = self.transfers.len();
        self.transfers.retain(|t| t.transfer_id != transfer_id);
        self.transfers.len() != before
    }

    /// Find a record by transfer id.
    pub fn get(&self, transfer_id: &str) -> Option<&PersistedTransfer> {
        self.transfers.iter().find(|t| t.transfer_id == transfer_id)
    }

    /// The incomplete transfers (queued/active/paused), each mapped to a paused
    /// copy — the startup rehydration list (never auto-resume).
    pub fn incomplete_as_paused(&self) -> Vec<PersistedTransfer> {
        self.transfers
            .iter()
            .filter(|t| t.status.is_incomplete())
            .map(PersistedTransfer::as_paused)
            .collect()
    }

    /// Drop every transfer whose local endpoint lies under `root` (a path
    /// prefix, compared by component). Returns how many were dropped.
    pub fn remove_local_paths_under(&mut self, root: &std::path::Path) -> usize {
        let before = self.transfers.len();
        self.transfers.retain(|t| {
            !t.local_path
                .as_deref()
                .is_some_and(|p| std::path::Path::new(p).starts_with(root))
        });
        before - self.transfers.len()
    }

    /// Record an unfinished folder paste (#3630), replacing any older record of
    /// the same folder and target, and keeping at most
    /// [`MAX_PERSISTED_FOLDER_PASTES`] (oldest dropped).
    pub fn add_folder_paste(&mut self, paste: PersistedFolderPaste) {
        self.folder_pastes.retain(|p| !p.same_target(&paste));
        self.folder_pastes.push(paste);
        if self.folder_pastes.len() > MAX_PERSISTED_FOLDER_PASTES {
            let overflow = self.folder_pastes.len() - MAX_PERSISTED_FOLDER_PASTES;
            self.folder_pastes.drain(0..overflow);
        }
    }

    /// Remove a folder-paste record by id. Returns whether one was removed.
    pub fn remove_folder_paste(&mut self, id: &str) -> bool {
        let before = self.folder_pastes.len();
        self.folder_pastes.retain(|p| p.id != id);
        self.folder_pastes.len() != before
    }

    /// Drop every transfer record linked to a still-recorded folder paste
    /// (#3643): the paste's notice owns that file, and its Retry re-copies it.
    /// Records without a link, or linked to a paste that is no longer
    /// recorded, are kept. Returns how many were dropped.
    pub fn remove_folder_paste_transfers(&mut self) -> usize {
        let before = self.transfers.len();
        let pastes = &self.folder_pastes;
        self.transfers.retain(|t| {
            !t.folder_paste_id
                .as_deref()
                .is_some_and(|id| pastes.iter().any(|p| p.id == id))
        });
        before - self.transfers.len()
    }

    /// Drop the oldest records until at most [`MAX_PERSISTED_TRANSFERS`] remain.
    fn cap(&mut self) {
        if self.transfers.len() > MAX_PERSISTED_TRANSFERS {
            let overflow = self.transfers.len() - MAX_PERSISTED_TRANSFERS;
            self.transfers.drain(0..overflow);
        }
    }
}

impl crate::utils::migrate::VersionedStore for PersistedTransferStore {
    const STORE_NAME: &'static str = "transfers.json";
    const CURRENT_VERSION: u32 = 1;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt transfer
    /// records instead of resetting the whole persisted queue.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, PersistedTransfer>(
            raw,
            file_name,
            "transfers",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, status: PersistedTransferStatus) -> PersistedTransfer {
        PersistedTransfer {
            transfer_id: id.to_string(),
            session_id: "sess-a".to_string(),
            direction: TransferDirection::Download,
            file_name: "data.csv".to_string(),
            remote_path: "/remote/data.csv".to_string(),
            local_path: Some("/home/user/data.csv".to_string()),
            status,
            transferred: 512,
            total: 2048,
            resume_offset: 512,
            created_at_ms: 1_000,
            updated_at_ms: 2_000,
            docker: None,
            group_id: None,
            folder_paste_id: None,
            source_mtime: None,
            remote_source: None,
            saved_connection_id: None,
            agent: None,
        }
    }

    /// The saved-connection reference (#3876) round-trips, and a record written
    /// before it existed still loads (with no reference).
    #[test]
    fn saved_connection_round_trips_and_old_records_still_load() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.saved_connection_id = Some("Work/files".to_string());
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"savedConnectionId\":\"Work/files\""));
        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);

        let legacy = serde_json::to_string(&sample("t2", PersistedTransferStatus::Paused)).unwrap();
        assert!(
            !legacy.contains("savedConnectionId"),
            "absent field is not written"
        );
        let parsed: PersistedTransfer = serde_json::from_str(&legacy).unwrap();
        assert_eq!(parsed.saved_connection_id, None);
    }

    /// The agent session identity (#4114) round-trips as ids only, and a
    /// record written before it existed still loads (with none).
    #[test]
    fn agent_target_round_trips_and_old_records_still_load() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.agent = Some(PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "remote-1".to_string(),
            definition_id: Some("def-a".to_string()),
        });
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(
            "\"agent\":{\"agentId\":\"agent-1\",\"remoteSessionId\":\"remote-1\",\"definitionId\":\"def-a\"}"
        ));
        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);

        let legacy = serde_json::to_string(&sample("t2", PersistedTransferStatus::Paused)).unwrap();
        assert!(!legacy.contains("\"agent\""), "absent field is not written");
        let parsed: PersistedTransfer = serde_json::from_str(&legacy).unwrap();
        assert_eq!(parsed.agent, None);
    }

    #[test]
    fn store_default_is_empty_v1() {
        let store = PersistedTransferStore::default();
        assert_eq!(store.version, "1");
        assert!(store.transfers.is_empty());
    }

    #[test]
    fn record_round_trips_with_camel_case_keys() {
        let entry = sample("t1", PersistedTransferStatus::Active);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"transferId\":\"t1\""));
        assert!(json.contains("\"sessionId\":\"sess-a\""));
        assert!(json.contains("\"direction\":\"download\""));
        assert!(json.contains("\"fileName\":\"data.csv\""));
        assert!(json.contains("\"remotePath\":\"/remote/data.csv\""));
        assert!(json.contains("\"localPath\":\"/home/user/data.csv\""));
        assert!(json.contains("\"status\":\"active\""));
        assert!(json.contains("\"resumeOffset\":512"));

        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);
    }

    /// The source mtime (#3572) round-trips, and a legacy record written
    /// before the field existed still loads (without it) and re-serializes
    /// without the key, so the on-disk format is unchanged for it.
    #[test]
    fn source_mtime_round_trips_and_legacy_records_still_load() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.source_mtime = Some(1_700_000_000_123_456_789);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"sourceMtime\":1700000000123456789"));
        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);

        let legacy = concat!(
            r#"{"transferId":"x","sessionId":"s","direction":"download","fileName":"f","#,
            r#""remotePath":"/f","localPath":"/l","status":"paused","transferred":10,"#,
            r#""total":20,"resumeOffset":10,"createdAtMs":1,"updatedAtMs":2}"#
        );
        let rec: PersistedTransfer = serde_json::from_str(legacy).unwrap();
        assert_eq!(rec.source_mtime, None);
        assert_eq!(serde_json::to_string(&rec).unwrap(), legacy);
    }

    /// A remote-to-remote copy round-trips its source endpoint (#3206) as a
    /// session reference plus a path — nothing else.
    #[test]
    fn remote_source_round_trips_as_a_reference_and_path_only() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.local_path = None;
        entry.remote_source = Some(PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: None,
            container_id: None,
            agent: None,
        });
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r#""remoteSource":{"sessionId":"sess-src","path":"/src/data.csv"}"#));
        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);
    }

    /// `transfers.json` files written before #3206 — an FTP download (which
    /// persisted like any session transfer) and a remote-to-remote copy that
    /// kept only its destination — still load, and re-serialize byte-for-byte.
    #[test]
    fn legacy_ftp_and_remote_copy_records_load_unchanged() {
        let legacy = concat!(
            r#"{"version":"1","transfers":["#,
            r#"{"transferId":"ftp-1","sessionId":"ftp-sess","direction":"download","#,
            r#""fileName":"f.bin","remotePath":"/pub/f.bin","localPath":"/home/u/f.bin","#,
            r#""status":"paused","transferred":4096,"total":8192,"resumeOffset":4096,"#,
            r#""createdAtMs":1,"updatedAtMs":2,"sourceMtime":1704110400},"#,
            r#"{"transferId":"r2r-1","sessionId":"dst-sess","direction":"upload","#,
            r#""fileName":"g.bin","remotePath":"/dst/g.bin","status":"paused","#,
            r#""transferred":10,"total":20,"resumeOffset":10,"createdAtMs":3,"updatedAtMs":4}"#,
            r#"]}"#
        );
        let parsed: PersistedTransferStore = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.transfers.len(), 2);
        assert_eq!(parsed.transfers[0].source_mtime, Some(1_704_110_400));
        assert_eq!(parsed.transfers[1].local_path, None);
        assert_eq!(parsed.transfers[1].remote_source, None, "legacy: no source");
        assert_eq!(serde_json::to_string(&parsed).unwrap(), legacy);
    }

    /// A Docker record round-trips its container identity (#3585), and a
    /// record written before the field existed still loads (as non-Docker).
    #[test]
    fn docker_target_round_trips_and_old_records_still_load() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.docker = Some(PersistedDockerTarget {
            container_id: "c0ffee".repeat(10),
        });
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(&format!(
            "\"docker\":{{\"containerId\":\"{}\"}}",
            "c0ffee".repeat(10)
        )));
        let parsed: PersistedTransfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, entry);

        let legacy = serde_json::to_string(&sample("t2", PersistedTransferStatus::Paused)).unwrap();
        assert!(!legacy.contains("docker"), "absent field is not written");
        let parsed: PersistedTransfer = serde_json::from_str(&legacy).unwrap();
        assert_eq!(parsed.docker, None);
    }

    /// SECURITY (the point of PROD-0011): a persisted record must never contain
    /// credential/secret material — only references and metadata.
    #[test]
    fn no_credential_fields_are_serialized() {
        let mut entry = sample("t1", PersistedTransferStatus::Paused);
        entry.docker = Some(PersistedDockerTarget {
            container_id: "0123456789abcdef".repeat(4),
        });
        entry.remote_source = Some(PersistedRemoteSource {
            session_id: "sess-src".to_string(),
            path: "/src/data.csv".to_string(),
            saved_connection_id: Some("Work/source".to_string()),
            container_id: None,
            agent: None,
        });
        // The saved-connection reference (#3876) is an id, never its secret.
        entry.saved_connection_id = Some("Work/files".to_string());
        let value = serde_json::to_value(&entry).unwrap();
        let obj = value.as_object().unwrap();
        for forbidden in [
            "password",
            "passphrase",
            "secret",
            "credential",
            "credentials",
            "privateKey",
            "private_key",
            "key",
            "token",
            "config",
            "auth",
        ] {
            assert!(
                !obj.contains_key(forbidden),
                "persisted transfer must not serialize a `{forbidden}` field"
            );
        }
        // The Docker identity is a bare container id — no host/runtime config.
        let docker = obj["docker"].as_object().unwrap();
        assert_eq!(
            docker.keys().collect::<Vec<_>>(),
            ["containerId"],
            "the Docker reference carries only the container id"
        );
        // The remote-to-remote source is a session reference and a path.
        let mut source_keys: Vec<_> = obj["remoteSource"].as_object().unwrap().keys().collect();
        source_keys.sort();
        assert_eq!(
            source_keys,
            ["path", "savedConnectionId", "sessionId"],
            "the remote source carries only session/connection references and a path"
        );
        // The saved connection is a bare id string — no settings, no secret.
        assert_eq!(obj["savedConnectionId"], "Work/files");
        // Whole-JSON belt-and-braces: none of the secret-ish substrings appear.
        let json = serde_json::to_string(&entry).unwrap().to_lowercase();
        for needle in ["password", "passphrase", "secret", "privatekey"] {
            assert!(
                !json.contains(needle),
                "serialized record leaked a `{needle}`"
            );
        }
    }

    #[test]
    fn upsert_replaces_by_id_and_caps_oldest_first() {
        let mut store = PersistedTransferStore::default();
        for i in 0..(MAX_PERSISTED_TRANSFERS + 5) {
            store.upsert(sample(&format!("t{i}"), PersistedTransferStatus::Queued));
        }
        assert_eq!(store.transfers.len(), MAX_PERSISTED_TRANSFERS);
        // The oldest five were evicted; the newest survives.
        assert!(store.get("t0").is_none());
        assert!(store.get("t4").is_none());
        assert!(store.get("t5").is_some());
        assert!(store
            .get(&format!("t{}", MAX_PERSISTED_TRANSFERS + 4))
            .is_some());

        // Upsert of an existing id replaces in place (no growth, no reorder).
        let len = store.transfers.len();
        let mut replaced = sample("t5", PersistedTransferStatus::Paused);
        replaced.transferred = 999;
        store.upsert(replaced);
        assert_eq!(store.transfers.len(), len);
        assert_eq!(store.get("t5").unwrap().transferred, 999);
        assert_eq!(
            store.get("t5").unwrap().status,
            PersistedTransferStatus::Paused
        );
    }

    #[test]
    fn remove_drops_the_record() {
        let mut store = PersistedTransferStore::default();
        store.upsert(sample("t1", PersistedTransferStatus::Active));
        assert!(store.remove("t1"));
        assert!(!store.remove("t1"));
        assert!(store.get("t1").is_none());
    }

    #[test]
    fn incomplete_as_paused_filters_terminals_and_forces_paused() {
        let mut store = PersistedTransferStore::default();
        store.upsert(sample("q", PersistedTransferStatus::Queued));
        store.upsert(sample("a", PersistedTransferStatus::Active));
        store.upsert(sample("p", PersistedTransferStatus::Paused));
        store.upsert(sample("done", PersistedTransferStatus::Completed));
        store.upsert(sample("fail", PersistedTransferStatus::Failed));
        store.upsert(sample("cancel", PersistedTransferStatus::Cancelled));

        let rehydrated = store.incomplete_as_paused();
        assert_eq!(rehydrated.len(), 3, "only queued/active/paused rehydrate");
        assert!(
            rehydrated
                .iter()
                .all(|t| t.status == PersistedTransferStatus::Paused),
            "every rehydrated transfer comes back paused"
        );
        // The resume offset is preserved through rehydration.
        assert!(rehydrated.iter().all(|t| t.resume_offset == 512));
        let ids: Vec<&str> = rehydrated.iter().map(|t| t.transfer_id.as_str()).collect();
        assert!(ids.contains(&"q") && ids.contains(&"a") && ids.contains(&"p"));
    }

    #[test]
    fn status_incomplete_and_terminal_partition() {
        for s in [
            PersistedTransferStatus::Queued,
            PersistedTransferStatus::Active,
            PersistedTransferStatus::Paused,
        ] {
            assert!(s.is_incomplete() && !s.is_terminal());
        }
        for s in [
            PersistedTransferStatus::Completed,
            PersistedTransferStatus::Failed,
            PersistedTransferStatus::Cancelled,
        ] {
            assert!(s.is_terminal() && !s.is_incomplete());
        }
    }

    fn paste(id: &str, src: &str, dest: &str) -> PersistedFolderPaste {
        PersistedFolderPaste {
            id: id.to_string(),
            operation: FolderPasteOperation::Copy,
            source: FolderPasteEndpoint {
                session_id: None,
                connection_id: None,
                label: None,
                path: src.to_string(),
            },
            destination: FolderPasteEndpoint {
                session_id: Some("sess-b".to_string()),
                connection_id: Some("conn-b".to_string()),
                label: Some("web-1".to_string()),
                path: dest.to_string(),
            },
            started_at_ms: 1,
        }
    }

    /// Records under the drag-out staging root are dropped (#3629); others, and
    /// a sibling that merely shares a name prefix, are kept.
    #[test]
    fn remove_local_paths_under_drops_only_records_inside_the_root() {
        let root = std::path::Path::new("/cache/drag-out");
        let mut store = PersistedTransferStore::default();
        let mut staged = sample("staged", PersistedTransferStatus::Active);
        staged.local_path = Some("/cache/drag-out/123-abc/file.bin".to_string());
        let mut sibling = sample("sibling", PersistedTransferStatus::Active);
        sibling.local_path = Some("/cache/drag-out-other/file.bin".to_string());
        let mut remote_copy = sample("r2r", PersistedTransferStatus::Active);
        remote_copy.local_path = None;
        for t in [
            staged,
            sibling,
            remote_copy,
            sample("plain", PersistedTransferStatus::Paused),
        ] {
            store.upsert(t);
        }

        assert_eq!(store.remove_local_paths_under(root), 1);
        let ids: Vec<&str> = store
            .transfers
            .iter()
            .map(|t| t.transfer_id.as_str())
            .collect();
        assert_eq!(ids, ["sibling", "r2r", "plain"]);
    }

    #[test]
    fn folder_pastes_round_trip_dedupe_and_cap() {
        let mut store = PersistedTransferStore::default();
        store.add_folder_paste(paste("p1", "/src/a", "/dst/a"));
        store.add_folder_paste(paste("p2", "/src/b", "/dst/b"));
        // The same folder pasted again replaces the older, unfinished record.
        store.add_folder_paste(paste("p3", "/src/a", "/dst/a"));
        let ids: Vec<&str> = store.folder_pastes.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["p2", "p3"]);

        let json = serde_json::to_string(&store).unwrap();
        assert!(json.contains("\"folderPastes\""));
        assert!(json.contains("\"operation\":\"copy\""));
        let parsed: PersistedTransferStore = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.folder_pastes, store.folder_pastes);

        assert!(store.remove_folder_paste("p2"));
        assert!(!store.remove_folder_paste("p2"));

        for i in 0..(MAX_PERSISTED_FOLDER_PASTES + 3) {
            store.add_folder_paste(paste(&format!("x{i}"), &format!("/s/{i}"), "/d"));
        }
        assert_eq!(store.folder_pastes.len(), MAX_PERSISTED_FOLDER_PASTES);
        assert_eq!(store.folder_pastes[0].id, "x3", "the oldest are dropped");
    }

    /// A store written before folder pastes existed still loads, and an empty
    /// list is not written (so older files stay byte-compatible).
    #[test]
    fn folder_paste_link_round_trips_and_drops_only_recorded_pastes() {
        let mut store = PersistedTransferStore::default();
        store.add_folder_paste(paste("p1", "/src/a", "/dst/a"));
        let linked = |id: &str, paste_id: Option<&str>| PersistedTransfer {
            folder_paste_id: paste_id.map(str::to_string),
            ..sample(id, PersistedTransferStatus::Paused)
        };
        store.upsert(linked("in-p1", Some("p1")));
        store.upsert(linked("in-gone", Some("gone")));
        store.upsert(linked("plain", None));

        let json = serde_json::to_string(&store).unwrap();
        assert!(json.contains("\"folderPasteId\":\"p1\""));
        let parsed: PersistedTransferStore = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.transfers, store.transfers);

        assert_eq!(store.remove_folder_paste_transfers(), 1);
        let ids: Vec<&str> = store
            .transfers
            .iter()
            .map(|t| t.transfer_id.as_str())
            .collect();
        assert_eq!(ids, ["in-gone", "plain"]);
        assert_eq!(store.remove_folder_paste_transfers(), 0);

        // A record written before the link existed loads without it.
        let old = r#"{"transferId":"x","sessionId":"s","direction":"upload","fileName":"f",
            "remotePath":"/f","status":"paused","transferred":0,"total":0,"resumeOffset":0,
            "createdAtMs":0,"updatedAtMs":0}"#;
        let rec: PersistedTransfer = serde_json::from_str(old).unwrap();
        assert_eq!(rec.folder_paste_id, None);
        assert!(!serde_json::to_string(&rec)
            .unwrap()
            .contains("folderPasteId"));
    }

    /// A `folderPastes` manifest written by an earlier build re-serializes
    /// byte-identically, unknown keys included (#3088: generating the
    /// `InterruptedFolderPaste` / `FolderPasteEndpoint` TS types must not change
    /// the persisted format).
    #[test]
    fn legacy_folder_paste_manifest_round_trips_byte_identical() {
        let legacy = concat!(
            r#"{"version":"1","transfers":[],"folderPastes":[{"id":"p1","operation":"cut","#,
            r#""source":{"sessionId":"s1","connectionId":"c1","label":"host","path":"/src"},"#,
            r#""destination":{"path":"/dst"},"startedAtMs":1700000000000}],"#,
            r#""futureKey":{"kept":true}}"#
        );
        let parsed: PersistedTransferStore = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.folder_pastes[0].operation, FolderPasteOperation::Cut);
        assert_eq!(parsed.folder_pastes[0].destination.session_id, None);
        assert_eq!(serde_json::to_string(&parsed).unwrap(), legacy);
    }

    #[test]
    fn store_without_folder_pastes_loads_and_empty_list_is_omitted() {
        let parsed: PersistedTransferStore =
            serde_json::from_str(r#"{"version":"1","transfers":[]}"#).unwrap();
        assert!(parsed.folder_pastes.is_empty());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(!json.contains("folderPastes"));
    }

    #[test]
    fn status_maps_from_wire_tag() {
        assert_eq!(
            PersistedTransferStatus::from(TransferStateTag::Paused),
            PersistedTransferStatus::Paused
        );
        assert_eq!(
            PersistedTransferStatus::from(TransferStateTag::Completed),
            PersistedTransferStatus::Completed
        );
    }
}
