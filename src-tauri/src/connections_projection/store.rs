//! The authoritative, shared connections-tree state behind the
//! `connections` projection region (#2225, Phase 5 of #2139).
//!
//! Models the saved-connection / folder tree the frontend currently drives in
//! `appStore` (`folders: ConnectionFolder[]` and `connections: SavedConnection[]`):
//! two flat arrays whose nesting is expressed by parent pointers
//! (`ConnectionFolder.parentId`, `SavedConnection.folderId`) and whose ordering is
//! array position. It **wraps the existing Rust authority** — the flat in-memory
//! types the connection manager already speaks
//! ([`crate::connection::config::SavedConnection`] and
//! [`crate::connection::config::ConnectionFolder`], which already carry the exact
//! camelCase wire shape of the frontend types) — rather than re-homing the config.
//!
//! # Shared region — Open Design Decision #4
//!
//! The saved connections/folders are one persisted config shared by every client
//! (like SSH tunnels, [`crate::tunnel::projection`]). The whole inventory — both
//! arrays, including each folder's persisted `isExpanded` flag (which this codebase
//! writes to disk via `persistFolder`) — is a single **shared** `connections`
//! region. The per-client tree *selection* / highlight is presentation: it lives
//! only in the `useTreeSelection` React hook, is never persisted, and stays a
//! frontend concern under partial projection — so it is deliberately not modelled
//! here.
//!
//! # Authoritative — drives the live UI
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative.
//! The live UI subscribes to and renders the `connections` region; the former
//! `appStore` connections reducers were removed.
//!
//! # Single writer (#2831)
//!
//! The store has exactly one mutation, [`ConnectionsStore::replace`], driven by
//! the persist command's fold from the [`ConnectionManager`] disk view. There
//! are no per-transition `connection.*` intents: an optimistic transition lives
//! only in the client's local overlay, so a failed persist can never leave the
//! region ahead of disk.
//!
//! [`ConnectionManager`]: crate::connection::manager::ConnectionManager

use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};

use crate::connection::config::{ConnectionFolder, SavedConnection};

/// The private mutable core: the flat folder + connection arrays, mirroring the
/// `appStore` connections slice one-to-one. One mutex guards it so a fold never
/// interleaves with a snapshot.
#[derive(Default)]
struct Inner {
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
}

/// The connections-tree authority. Owns the flat `folders` and
/// `connections` arrays keyed by their path-derived ids, mirroring the frontend
/// `appStore` slice. The single shared `connections` region projects this state.
#[derive(Default)]
pub struct ConnectionsStore {
    inner: Mutex<Inner>,
}

impl ConnectionsStore {
    /// A store with an empty tree.
    pub fn new() -> Self {
        Self::default()
    }

    /// The render-ready view model for the whole region:
    /// `{ "folders": [ConnectionFolder, …], "connections": [SavedConnection, …] }`.
    ///
    /// The key names and element shapes mirror the `appStore` connections slice
    /// exactly, keeping the render cut a pure parity swap. Pure with
    /// respect to store state (never mutates), so the projector can safely diff
    /// two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        json!({
            "folders": serde_json::to_value(&inner.folders).unwrap_or(Value::Null),
            "connections": serde_json::to_value(&inner.connections).unwrap_or(Value::Null),
        })
    }

    // ── The single write path (#2831) ───────────────────────────────────────

    /// Overwrite the whole connections slice (the two flat folder + connection
    /// arrays) with the manager's persisted view. The **only** mutation this store
    /// has: it is called by `fold_connections_from_manager` inside the `commit`
    /// choke point, so the region is written by the persist command alone and
    /// always equals disk (#2831). Idempotent: replacing with the same content
    /// publishes no diff.
    pub fn replace(&self, folders: Vec<ConnectionFolder>, connections: Vec<SavedConnection>) {
        let mut inner = self.lock();
        inner.folders = folders;
        inner.connections = connections;
    }

    // ── Test / diagnostics helpers ─────────────────────────────────────────

    /// Read one connection entry (test / diagnostics helper).
    #[cfg(test)]
    pub fn connection(&self, id: &str) -> Option<SavedConnection> {
        self.lock().connections.iter().find(|c| c.id == id).cloned()
    }

    /// Read one folder entry (test / diagnostics helper).
    #[cfg(test)]
    pub fn folder(&self, id: &str) -> Option<ConnectionFolder> {
        self.lock().folders.iter().find(|f| f.id == id).cloned()
    }

    /// Count of connections currently in the store (test / diagnostics helper).
    #[cfg(test)]
    pub fn connection_count(&self) -> usize {
        self.lock().connections.len()
    }

    /// Count of folders currently in the store (test / diagnostics helper).
    #[cfg(test)]
    pub fn folder_count(&self) -> usize {
        self.lock().folders.len()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
