//! Moving per-connection credentials when saved-connection ids change (#3578).
//!
//! A connection's stored secrets are keyed by its path-based id — scoped by
//! its file for external files (#3591, [`super::credential_scope`]) — so every
//! id change the manager persists (see [`super::id_changes`]), and every move
//! between files, must carry the secrets along. One operation can change several ids at once — a rename that
//! pushes a same-named sibling to `name (1)`, a folder rename, a swap — so the
//! changes are applied as one permutation:
//!
//! 1. read the secret under every old key,
//! 2. write all of them under their new keys in one batch
//!    ([`CredentialStore::set_many`]: a single durable file write for the
//!    master-password store, write-with-rollback for the OS keychain),
//! 3. only then delete old keys that did not just receive a secret.
//!
//! A secret is therefore never deleted before its new copy is written, and no
//! migration overwrites another connection's secret with a stale value.
//!
//! Named credentials (#3557) live under their own id
//! ([`named::OWNER_PREFIX`]) and are never touched.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};

use super::config::{ConnectionFolder, SavedConnection};
use super::credential_scope::owner_id;
use super::id_changes::{reloaded_connection_id, ConnectionIdChange};
use crate::credential::named;
use crate::credential::{CredentialKey, CredentialStore, CredentialType};

/// Apply `changes` — of credential owner ids — to the secrets in `store`.
///
/// - `may_have_credentials(new_id)` says whether the connection now at
///   `new_id` can own secrets. Other connections are
///   skipped, so a locked store is never asked about serial, local and similar
///   connections — and when no change qualifies, the store is not touched.
/// - `still_in_use(id)` says whether a connection that did not move still owns
///   `id` (e.g. an agent sharing a main-store id). Its secret is kept.
///
/// Returns an error — with nothing written or deleted — when a secret cannot
/// be read or the new keys cannot be written. A failure to delete a stale old
/// key after a successful write is only logged: the secret is safe under its
/// new key.
pub(crate) fn migrate_credentials(
    changes: &[ConnectionIdChange],
    may_have_credentials: impl Fn(&str) -> bool,
    still_in_use: impl Fn(&str) -> bool,
    store: &dyn CredentialStore,
) -> Result<()> {
    let is_named = |id: &str| id.starts_with(named::OWNER_PREFIX);
    let relevant: Vec<&ConnectionIdChange> = changes
        .iter()
        .filter(|c| c.old_id != c.new_id)
        .filter(|c| !is_named(&c.old_id) && !is_named(&c.new_id))
        .filter(|c| may_have_credentials(&c.new_id))
        .collect();
    if relevant.is_empty() {
        return Ok(());
    }

    // 1. Read every old secret before anything is written.
    let mut writes: Vec<(CredentialKey, String)> = Vec::new();
    let mut read_old_keys: Vec<CredentialKey> = Vec::new();
    for change in &relevant {
        for cred_type in CredentialType::ALL {
            let old_key = CredentialKey::new(&change.old_id, cred_type.clone());
            let value = store
                .get(&old_key)
                .with_context(|| format!("Failed to read credential {old_key}"))?;
            if let Some(value) = value {
                writes.push((CredentialKey::new(&change.new_id, cred_type), value));
                read_old_keys.push(old_key);
            }
        }
    }

    // 2. Write every new key in one batch.
    if !writes.is_empty() {
        let written = store.set_many(&writes);
        zeroize_values(&mut writes);
        written.context("Failed to write migrated credentials")?;
    }

    // 3. Delete old keys that are no longer a target. An old id that another
    //    moved connection now holds is stale for it, so it goes too.
    let written: HashSet<String> = writes.iter().map(|(k, _)| k.to_string()).collect();
    let moved_into: HashSet<&str> = changes.iter().map(|c| c.new_id.as_str()).collect();
    for old_key in read_old_keys {
        if written.contains(&old_key.to_string()) {
            continue;
        }
        let id = old_key.connection_id.as_str();
        if !moved_into.contains(id) && still_in_use(id) {
            continue;
        }
        if let Err(e) = store.remove(&old_key) {
            tracing::warn!(
                key = %old_key,
                error = %e,
                "Failed to remove a migrated credential's old key (its new copy is written)"
            );
        }
    }
    Ok(())
}

fn zeroize_values(entries: &mut [(CredentialKey, String)]) {
    for (_, value) in entries.iter_mut() {
        zeroize::Zeroize::zeroize(value);
    }
}

/// Carry the secrets of `changes` along, where the changed connections now
/// live in `tree` (one file's connections and folders, already persisted),
/// whose credential scope is `scope` (`None` for the main store, #3591).
///
/// `changes` are id changes within the tree. `arrived` are connections that
/// moved in from another file, as `(owner id in their old file, id in this
/// tree)`: their secrets change scope even when their id does not.
///
/// A connection may own secrets when it has an `authMethod` or saves its
/// password. Every connection in the tree, plus the owner ids in
/// `also_in_use` (held outside the tree, e.g. by the file a connection moved
/// out of), counts as still owning its key.
pub(crate) fn follow_id_changes(
    changes: &[ConnectionIdChange],
    arrived: &[(String, String)],
    scope: Option<&str>,
    tree: (&[SavedConnection], &[ConnectionFolder]),
    also_in_use: &HashSet<String>,
    store: &dyn CredentialStore,
) -> Result<()> {
    if changes.is_empty() && arrived.is_empty() {
        return Ok(());
    }
    let (connections, folders) = tree;
    let owners: HashMap<String, bool> = connections
        .iter()
        .map(|c| {
            let id = reloaded_connection_id(c, folders).unwrap_or_else(|| c.id.clone());
            (owner_id(&id, scope), may_have_credentials(c))
        })
        .collect();
    let owner_changes: Vec<ConnectionIdChange> = changes
        .iter()
        .map(|c| ConnectionIdChange::new(owner_id(&c.old_id, scope), owner_id(&c.new_id, scope)))
        .chain(arrived.iter().map(|(old_owner, new_id)| {
            ConnectionIdChange::new(old_owner.clone(), owner_id(new_id, scope))
        }))
        .collect();
    migrate_credentials(
        &owner_changes,
        |owner| owners.get(owner).copied().unwrap_or(false),
        |owner| owners.contains_key(owner) || also_in_use.contains(owner),
        store,
    )
}

/// Whether a saved connection can own stored secrets.
fn may_have_credentials(connection: &SavedConnection) -> bool {
    let settings = &connection.config.settings;
    settings.get("authMethod").is_some()
        || settings.get("savePassword").and_then(|v| v.as_bool()) == Some(true)
}

#[cfg(test)]
#[path = "credential_migration_tests.rs"]
mod tests;
