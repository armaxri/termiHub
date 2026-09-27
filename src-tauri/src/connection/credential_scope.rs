//! Per-file scoping of per-connection credential keys (#3591).
//!
//! A saved connection's id is its path in its own file's tree (`Folder/Name`),
//! so the main store and every external connection file can each hold a
//! connection `x`. Credential keys used to be the bare id, so those
//! connections shared, overwrote and deleted each other's saved secrets.
//!
//! # Key scheme
//!
//! - **Main store** (and remote agents): the owner id is the connection id,
//!   unchanged — existing users need no migration for the common case.
//! - **External file**: the owner id is
//!   `connection-file:<file-id>:<connection-id>` ([`owner_id`]), where
//!   `<file-id>` is a random UUID identifying the file.
//!
//! # File identity
//!
//! The file id is stored **in the external file** (`"fileId"`), so it travels
//! with the file: renaming or moving it, or re-adding it from another path,
//! keeps its secrets. A path hash would orphan them on every rename, and would
//! differ between machines and mount points; an id in the file also lets a
//! vault export from one machine land on the same file's connections on
//! another. The id is not a secret — a file is shared as it is.
//!
//! Because a file's content is not trusted, this machine also remembers which
//! file (canonical path) it bound each id to ([`FileScopes`], in
//! `connection-file-scopes.json` next to `connections.json`), and the local
//! binding wins:
//!
//! - A path this machine already bound keeps its id, even if the file now
//!   claims another one (a file edited to claim a different file's id cannot
//!   read that file's secrets). A file that lost its id — rewritten by an older
//!   termiHub or another tool — gets it back.
//! - An id another configured, existing file is already bound to is refused:
//!   the newcomer (a copied file, or one claiming a foreign id) gets a fresh id
//!   and starts without secrets.
//! - A file that cannot be written (read-only share) keeps a locally
//!   remembered id; only a rename of such a file loses its secrets.
//!
//! # Migration of pre-#3591 secrets
//!
//! External connections' secrets used to live under the bare id. The first
//! time a file is scoped on this machine (while the store is unlocked), its
//! connections' secrets are **copied** to the scoped keys
//! ([`migrate_legacy_keys`]) — never moved. A bare key stays while the main
//! store (or an agent) uses the same id, or while another external file that
//! uses it has not been migrated yet; otherwise it is deleted, but only after
//! every copy was written durably. When a bare key was shared by more than one
//! connection, every holder keeps the value but it may belong to only one of
//! them — termiHub cannot tell — so a one-time notice lists the affected
//! connections ([`ScopeNotice`]). Migration is recorded per file id, so it
//! runs once, never re-copies over a secret removed later, and works from the
//! known connection ids alone (the OS keychain cannot list its entries).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::config::{ExternalConnectionStore, SavedConnection};
use crate::credential::{CredentialKey, CredentialStore, CredentialType};
use crate::utils::fs::write_atomic;

/// Prefix of the owner id of an external-file connection's secrets.
pub const EXTERNAL_OWNER_PREFIX: &str = "connection-file:";

/// Name of the per-machine binding state, next to `connections.json`.
pub const STATE_FILE_NAME: &str = "connection-file-scopes.json";

const STATE_VERSION: u32 = 1;

/// The credential owner id of connection `connection_id` in the file with
/// credential scope `file_scope` — `None` for the main store.
pub fn owner_id(connection_id: &str, file_scope: Option<&str>) -> String {
    match file_scope {
        None => connection_id.to_string(),
        Some(scope) => format!("{EXTERNAL_OWNER_PREFIX}{scope}:{connection_id}"),
    }
}

/// Whether `id` is a well-formed file id: a UUID in canonical lowercase,
/// hyphenated form. Anything else found in a file is treated as foreign.
pub fn is_valid_file_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

fn new_file_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

/// A one-time notice: connections of `file_path` whose saved secret was
/// copied from a key that another connection with the same id also used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeNotice {
    pub file_path: String,
    pub connection_names: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeState {
    version: u32,
    /// Canonical file path → file id bound on this machine.
    #[serde(default)]
    bindings: BTreeMap<String, String>,
    /// File ids whose pre-#3591 secrets were migrated (or that never had any).
    #[serde(default)]
    migrated: BTreeSet<String>,
    /// Notices not yet shown to the user.
    #[serde(default)]
    notices: Vec<ScopeNotice>,
}

/// This machine's file-id bindings and migration record (see the module docs).
pub struct FileScopes {
    state_path: PathBuf,
    state: Mutex<ScopeState>,
}

impl FileScopes {
    /// Load the state from `state_path`. A missing file starts empty; an
    /// unreadable one is set aside as `<name>.bak` and starts empty (the ids
    /// stored in the files themselves restore the bindings).
    pub fn load(state_path: PathBuf) -> Self {
        let state = match std::fs::read_to_string(&state_path) {
            Ok(data) => match serde_json::from_str::<ScopeState>(&data) {
                Ok(state) if state.version <= STATE_VERSION => state,
                Ok(state) => {
                    tracing::warn!(
                        version = state.version,
                        "Connection file scope state is from a newer termiHub; ignoring it"
                    );
                    ScopeState::default()
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Connection file scope state is corrupt; starting over");
                    let _ = std::fs::rename(&state_path, state_path.with_extension("json.bak"));
                    ScopeState::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ScopeState::default(),
            Err(e) => {
                tracing::warn!(error = %e, "Failed to read connection file scope state");
                ScopeState::default()
            }
        };
        Self {
            state_path,
            state: Mutex::new(state),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ScopeState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, state: &mut ScopeState) {
        state.version = STATE_VERSION;
        let written = serde_json::to_string_pretty(&*state)
            .context("Failed to serialize connection file scope state")
            .and_then(|data| write_atomic(&self.state_path, &data));
        if let Err(e) = written {
            tracing::warn!(error = %e, "Failed to persist connection file scope state");
        }
    }

    /// The file id this machine bound to `path`, without binding anything.
    pub fn binding(&self, path: &str) -> Option<String> {
        self.lock().bindings.get(&canonical_key(path)).cloned()
    }

    /// The credential scope (file id) of the external file at `path`, binding
    /// one when the file has none on this machine yet. `configured` are the
    /// paths of every configured external file (enabled or not), used to tell
    /// a renamed file from a copy.
    ///
    /// Never fails: when the id cannot be stamped into the file it is still
    /// bound locally.
    pub fn resolve(&self, path: &str, configured: &[String]) -> String {
        let key = canonical_key(path);
        let on_disk = read_file_id(path);
        let exists = Path::new(path).exists();
        let mut state = self.lock();

        if let Some(bound) = state.bindings.get(&key).cloned() {
            if exists && on_disk.as_deref().is_none() {
                stamp_file_id(path, &bound);
            }
            return bound;
        }

        let configured: HashSet<String> = configured.iter().map(|p| canonical_key(p)).collect();
        let taken = |id: &str| {
            state.bindings.iter().any(|(p, bound)| {
                bound == id && *p != key && configured.contains(p) && Path::new(p).exists()
            })
        };
        let id = match on_disk {
            Some(id) if is_valid_file_id(&id) && !taken(&id) => {
                // A new path for a known id is a rename or move: follow it.
                state.bindings.retain(|_, bound| *bound != id);
                id
            }
            Some(foreign) => {
                // A copy of another configured file, or an id that is not
                // ours to use: start fresh, with nothing to inherit.
                let id = new_file_id();
                tracing::info!(
                    file = path,
                    claimed = %foreign,
                    "External connection file claims a file id already in use; assigning a new one"
                );
                state.migrated.insert(id.clone());
                stamp_file_id(path, &id);
                id
            }
            None => {
                // A missing file (not created yet, or on an unmounted share)
                // stays unmigrated: whoever creates it records that it is new.
                let id = new_file_id();
                if exists {
                    stamp_file_id(path, &id);
                }
                id
            }
        };
        state.bindings.insert(key, id.clone());
        self.save(&mut state);
        id
    }

    /// Whether `file_id`'s pre-#3591 secrets were already migrated.
    pub fn is_migrated(&self, file_id: &str) -> bool {
        self.lock().migrated.contains(file_id)
    }

    /// Record that `file_id` was migrated, with its notice (if any).
    pub fn complete_migration(&self, file_id: &str, notice: Option<ScopeNotice>) {
        let mut state = self.lock();
        state.migrated.insert(file_id.to_string());
        if let Some(notice) = notice {
            state.notices.push(notice);
        }
        self.save(&mut state);
    }

    /// Take the notices not yet shown; they are removed from the state.
    pub fn take_notices(&self) -> Vec<ScopeNotice> {
        let mut state = self.lock();
        if state.notices.is_empty() {
            return Vec::new();
        }
        let notices = std::mem::take(&mut state.notices);
        self.save(&mut state);
        notices
    }
}

/// Whether `a` and `b` name the same file.
pub(crate) fn same_file(a: &str, b: &str) -> bool {
    canonical_key(a) == canonical_key(b)
}

/// `path` canonicalized, so two spellings of one file share a binding. A path
/// that does not exist yet is canonicalized through its parent directory.
fn canonical_key(path: &str) -> String {
    let p = Path::new(path);
    if let Ok(canonical) = std::fs::canonicalize(p) {
        return canonical.to_string_lossy().into_owned();
    }
    if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if let Ok(canonical) = std::fs::canonicalize(parent) {
            return canonical.join(name).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// The id stored in the external file at `path`, if it can be read.
fn read_file_id(path: &str) -> Option<String> {
    let data = std::fs::read_to_string(path).ok()?;
    if data.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<ExternalConnectionStore>(&data)
        .ok()?
        .file_id
}

/// Write `id` into the external file at `path` (best-effort). A file that
/// cannot be parsed is never rewritten.
fn stamp_file_id(path: &str, id: &str) {
    let stamped = std::fs::read_to_string(path)
        .context("Failed to read the file")
        .and_then(|data| {
            let mut store: ExternalConnectionStore =
                serde_json::from_str(&data).context("Failed to parse the file")?;
            store.file_id = Some(id.to_string());
            let data = serde_json::to_string_pretty(&store).context("Failed to serialize")?;
            write_atomic(Path::new(path), &data)
        });
    if let Err(e) = stamped {
        tracing::warn!(
            file = path,
            error = %e,
            "Could not store the file id in an external connection file; it is remembered locally"
        );
    }
}

/// Who else uses a connection id in the pre-#3591 (bare) key namespace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LegacyHolders {
    /// Another connection (main store, agent, or another file) has this id,
    /// so the bare secret may not be this connection's.
    pub shared: bool,
    /// The bare key must stay: the main store or an agent owns it, or another
    /// file that uses the id has not been migrated (or could not be read).
    pub keep_bare_key: bool,
}

/// Copy the pre-#3591 secrets of `connections` (one external file's) from the
/// bare keys to the keys scoped by `file_scope` (see the module docs).
///
/// A scoped key that already holds a secret is kept. All reads happen first,
/// then every copy is written in one batch ([`CredentialStore::set_many`]);
/// only then are bare keys nobody else needs deleted. Returns the names of the
/// connections whose copied secret was shared with another connection.
///
/// Errors — with nothing written or deleted — when a secret cannot be read or
/// the copies cannot be written. A failed delete of a bare key is only logged.
pub(crate) fn migrate_legacy_keys(
    file_scope: &str,
    connections: &[SavedConnection],
    holders: impl Fn(&str) -> LegacyHolders,
    store: &dyn CredentialStore,
) -> Result<Vec<String>> {
    let mut writes: Vec<(CredentialKey, String)> = Vec::new();
    let mut copied: Vec<&SavedConnection> = Vec::new();
    for conn in connections {
        let owner = owner_id(&conn.id, Some(file_scope));
        let mut any = false;
        for cred_type in CredentialType::ALL {
            let scoped = CredentialKey::new(&owner, cred_type.clone());
            let existing = store
                .get(&scoped)
                .with_context(|| format!("Failed to read credential {scoped}"))?;
            if existing.is_some() {
                continue;
            }
            let bare = CredentialKey::new(&conn.id, cred_type);
            let value = store
                .get(&bare)
                .with_context(|| format!("Failed to read credential {bare}"))?;
            if let Some(value) = value {
                writes.push((scoped, value));
                any = true;
            }
        }
        if any {
            copied.push(conn);
        }
    }
    if writes.is_empty() {
        return Ok(Vec::new());
    }

    let written = store.set_many(&writes);
    for (_, value) in writes.iter_mut() {
        zeroize::Zeroize::zeroize(value);
    }
    written.context("Failed to write the file-scoped copies of saved credentials")?;

    let mut shared = Vec::new();
    let mut done: HashSet<&str> = HashSet::new();
    for conn in copied {
        if !done.insert(conn.id.as_str()) {
            continue;
        }
        let who = holders(&conn.id);
        if who.shared {
            shared.push(conn.name.clone());
        }
        if who.keep_bare_key {
            continue;
        }
        for cred_type in CredentialType::ALL {
            let bare = CredentialKey::new(&conn.id, cred_type);
            if let Err(e) = store.remove(&bare) {
                tracing::warn!(
                    key = %bare,
                    error = %e,
                    "Failed to remove a migrated credential's bare key (its scoped copy is written)"
                );
            }
        }
    }
    Ok(shared)
}

#[cfg(test)]
#[path = "credential_scope_tests.rs"]
mod tests;
