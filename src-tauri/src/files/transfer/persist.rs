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
        }
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

    /// SECURITY (the point of PROD-0011): a persisted record must never contain
    /// credential/secret material — only references and metadata.
    #[test]
    fn no_credential_fields_are_serialized() {
        let entry = sample("t1", PersistedTransferStatus::Paused);
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
