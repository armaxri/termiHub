//! Moving plaintext schema secrets out of connection files (#4289).
//!
//! Before #4289 only the `password` setting was kept out of `connections.json`
//! and external connection files: every other secret a connection type's
//! schema declares — the VNC SSH-gateway `sshPassword`, a plugin's password
//! field, an inline jump-host hop's password — was written in plaintext. This
//! moves such secrets into each connection's field-secrets credential entry
//! ([`secret_fields`]) when a file is loaded, then the caller rewrites the file
//! without them.
//!
//! The move never loses a secret:
//!
//! 1. it runs only while the credential store is unlocked — a locked store (or
//!    no store) leaves the file and the in-memory connections untouched, and
//!    the move completes on a later load once the store is unlocked;
//! 2. every secret is written in **one** [`CredentialStore::set_many`] batch
//!    (all or nothing) before anything is stripped — a failed write strips
//!    nothing;
//! 3. only then are the secrets stripped from the connections, for the caller
//!    to persist. A failed rewrite leaves the plaintext on disk with its copy
//!    already in the store.

use anyhow::{Context, Result};
use termihub_core::connection::secrets;
use zeroize::Zeroize;

use super::config::SavedConnection;
use super::credential_scope::owner_id;
use super::secret_fields;
use crate::credential::{CredentialKey, CredentialStore, CredentialStoreStatus};

/// Move the plaintext field secrets of `connections` — stored in the file
/// whose credential scope is `file_scope` (`None` for the main store) — into
/// the credential store, stripping them from `connections`.
///
/// Returns `Ok(true)` when `connections` changed and the file must be
/// rewritten, `Ok(false)` when there was nothing to move or the store is not
/// unlocked (nothing changed), and an error — with nothing written and nothing
/// stripped — when the secrets could not be read or written.
pub(crate) fn migrate_plaintext_field_secrets(
    connections: &mut [SavedConnection],
    file_scope: Option<&str>,
    store: &dyn CredentialStore,
) -> Result<bool> {
    let candidates: Vec<usize> = connections
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            secret_fields::has_plaintext_field_secrets(&c.config.type_id, &c.config.settings)
        })
        .map(|(i, _)| i)
        .collect();
    if candidates.is_empty() {
        return Ok(false);
    }
    if store.status() != CredentialStoreStatus::Unlocked {
        tracing::info!(
            count = candidates.len(),
            "Plaintext connection secrets wait for an unlocked credential store to be moved"
        );
        return Ok(false);
    }

    // Strip copies first, so a failure below leaves `connections` untouched.
    let mut stripped: Vec<(usize, serde_json::Value)> = Vec::with_capacity(candidates.len());
    let mut writes: Vec<(CredentialKey, String)> = Vec::new();
    let collected = collect_writes(
        connections,
        &candidates,
        file_scope,
        store,
        &mut stripped,
        &mut writes,
    );
    let written = collected.and_then(|()| {
        if writes.is_empty() {
            Ok(())
        } else {
            store
                .set_many(&writes)
                .context("Failed to move plaintext connection secrets into the credential store")
        }
    });
    for (_, value) in writes.iter_mut() {
        value.zeroize();
    }
    written?;

    let moved = writes.len();
    for (index, settings) in stripped {
        connections[index].config.settings = settings;
    }
    tracing::info!(
        connections = moved,
        "Moved plaintext connection secrets into the credential store"
    );
    Ok(true)
}

/// For each candidate connection: strip a copy of its settings into `stripped`
/// and queue its merged field-secrets entry in `writes`.
fn collect_writes(
    connections: &[SavedConnection],
    candidates: &[usize],
    file_scope: Option<&str>,
    store: &dyn CredentialStore,
    stripped: &mut Vec<(usize, serde_json::Value)>,
    writes: &mut Vec<(CredentialKey, String)>,
) -> Result<()> {
    for &index in candidates {
        let connection = &connections[index];
        let keys = secret_fields::field_secret_keys(&secret_fields::secret_keys_for(
            &connection.config.type_id,
        ));
        let mut settings = connection.config.settings.clone();
        let taken = secrets::take_secrets(&keys, &mut settings);
        if !taken.is_empty() {
            let owner = owner_id(&connection.id, file_scope);
            writes.push(secret_fields::merged_entry(store, &owner, taken)?);
        }
        stripped.push((index, settings));
    }
    Ok(())
}

#[cfg(test)]
#[path = "secret_migration_tests.rs"]
mod tests;
