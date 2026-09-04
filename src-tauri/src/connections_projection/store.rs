//! The authoritative, shared connections-tree state behind the shadow
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
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not** authoritative. The store exists, accepts
//! `connection.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders the `connections` region, and no frontend code
//! dispatches `connection.*` intents yet. The existing `appStore` connections
//! slice remains authoritative. Later steps cut rendering, then mutation, over to
//! the region, then remove the `appStore` state.

use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};

use crate::connection::config::{ConnectionFolder, SavedConnection};

/// The private mutable core: the flat folder + connection arrays, mirroring the
/// `appStore` connections slice one-to-one. One mutex guards it so intents never
/// interleave — the substrate's single-writer contract also holds within the
/// store.
#[derive(Default)]
struct Inner {
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
}

/// The shadow connections-tree authority. Owns the flat `folders` and
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
    /// exactly, keeping the eventual render cut a pure parity swap. Pure with
    /// respect to store state (never mutates), so the projector can safely diff
    /// two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        json!({
            "folders": serde_json::to_value(&inner.folders).unwrap_or(Value::Null),
            "connections": serde_json::to_value(&inner.connections).unwrap_or(Value::Null),
        })
    }

    // ── Connection transitions ─────────────────────────────────────────────

    /// `connection.add` — append one saved connection (mirrors `addConnection`,
    /// which pushes onto the array; ordering is array position).
    pub fn add_connection(&self, connection: SavedConnection) {
        self.lock().connections.push(connection);
    }

    /// `connection.update` — replace the connection whose id matches the incoming
    /// one (mirrors `updateConnection`'s `map(c => c.id === id ? next : c)`). A
    /// no-op when no entry carries that id.
    pub fn update_connection(&self, connection: SavedConnection) {
        let mut inner = self.lock();
        if let Some(slot) = inner.connections.iter_mut().find(|c| c.id == connection.id) {
            *slot = connection;
        }
    }

    /// `connection.remove` — drop the connection with this id (mirrors
    /// `deleteConnection`'s filter). Idempotent.
    pub fn remove_connection(&self, connection_id: &str) {
        self.lock().connections.retain(|c| c.id != connection_id);
    }

    /// `connection.move` — set one connection's `folderId` (mirrors
    /// `moveConnectionToFolder`; `None` = move to root). A no-op for an unknown id.
    pub fn move_connection(&self, connection_id: &str, folder_id: Option<String>) {
        let mut inner = self.lock();
        if let Some(connection) = inner.connections.iter_mut().find(|c| c.id == connection_id) {
            connection.folder_id = folder_id;
        }
    }

    /// `connection.reorder` — move the connection at `old_index` to `new_index`
    /// (`reorderConnections`), matching the agents store's `reorder`. Ordering is
    /// array position (the on-disk `children` order), so an intra-folder drag maps
    /// to a pure array move of the two siblings within the flat list. Out-of-range
    /// indices are a no-op.
    pub fn reorder(&self, old_index: usize, new_index: usize) {
        let mut inner = self.lock();
        let len = inner.connections.len();
        if old_index >= len || new_index >= len {
            return;
        }
        let moved = inner.connections.remove(old_index);
        inner.connections.insert(new_index, moved);
    }

    // ── Folder transitions ─────────────────────────────────────────────────

    /// `connection.addFolder` — append one folder (mirrors `addFolder`).
    pub fn add_folder(&self, folder: ConnectionFolder) {
        self.lock().folders.push(folder);
    }

    /// `connection.removeFolder` — remove a folder and re-home its children, exactly
    /// as `deleteFolder` does: child folders reparent to the removed folder's own
    /// parent, and child connections move to root (`folderId = null`). Idempotent.
    pub fn remove_folder(&self, folder_id: &str) {
        let mut inner = self.lock();
        let parent_id = inner
            .folders
            .iter()
            .find(|f| f.id == folder_id)
            .and_then(|f| f.parent_id.clone());
        for connection in inner.connections.iter_mut() {
            if connection.folder_id.as_deref() == Some(folder_id) {
                connection.folder_id = None;
            }
        }
        for folder in inner.folders.iter_mut() {
            if folder.parent_id.as_deref() == Some(folder_id) {
                folder.parent_id = parent_id.clone();
            }
        }
        inner.folders.retain(|f| f.id != folder_id);
    }

    /// `connection.toggleFolder` — flip one folder's persisted `isExpanded`
    /// (mirrors `toggleFolder`, which persists via `persistFolder`). A no-op for an
    /// unknown id.
    pub fn toggle_folder(&self, folder_id: &str) {
        let mut inner = self.lock();
        if let Some(folder) = inner.folders.iter_mut().find(|f| f.id == folder_id) {
            folder.is_expanded = !folder.is_expanded;
        }
    }

    // ── Whole-region mirror (render-cut seed) ───────────────────────────────

    /// `connection.replace` — overwrite the whole connections slice (the two flat
    /// folder + connection arrays) with a caller-supplied snapshot. Used by the
    /// frontend render-cut mirror (#2225) to keep the shared `connections` region a
    /// faithful copy of `appStore`'s connections slice while `appStore` remains
    /// authoritative (the mutation cut is a later step) — the analog of the agents
    /// bridge's `agent.replace` seed. Idempotent server-side: replacing with the
    /// same content yields no diff.
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
