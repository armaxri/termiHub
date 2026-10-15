//! Dropping stored jump-host hop secrets whose hop no longer exists (#4792).
//!
//! An inline hop's password is kept in its connection's field-secrets entry
//! under the hop's identity (`user@host:port`, #4289). A save only merges new
//! secrets over the stored ones, so removing a hop, or editing its host,
//! username or port, would leave the secret under the old identity for good:
//! nothing reads it again. After every successful save the connection's entry
//! is pruned against the hop chain **as saved**; top-level field secrets are
//! never touched, and a hop that is still present — reordered or duplicated —
//! keeps its secret.
//!
//! **Locked store (deferral).** A save never prompts for the store. When it is
//! locked at save time the prune cannot read the entry, so the save succeeds
//! without it and a sweep is scheduled: the next time the store is unlocked
//! (`migrate_credential_scopes`, which every unlock runs) every connection
//! with a field-secrets entry is pruned against its saved settings. The sweep
//! also runs once per app run on the first unlocked call, so a deferral lost
//! to a restart (or orphans left by builds before #4792) is still cleaned up.
//!
//! **Shared legacy keys.** A main-store connection's entry lives under its
//! bare id, which a not-yet-migrated external file (#3591) may still read for
//! a same-id connection of its own. The main store is therefore pruned only
//! once every configured external file is migrated; until then the prune is
//! deferred to the sweep. An external file's entry is scoped to that file, so
//! the file alone decides.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::Ordering;

use super::{read_external_store, ConnectionManager};
use crate::connection::config::SavedConnection;
use crate::connection::credential_scope::owner_id;
use crate::connection::secret_fields::prune_orphan_hop_secrets;
use crate::connection::tree::flatten_tree;
use crate::credential::{CredentialStoreStatus, CredentialType};

impl ConnectionManager {
    /// Whether the field-secrets entry of a connection in the file with
    /// credential scope `scope` (`None` = main store) belongs to that file
    /// alone, so its saved hops decide which hop secrets it keeps. See the
    /// module docs on shared legacy keys.
    pub(crate) fn may_prune_hop_secrets(&self, scope: Option<&str>) -> bool {
        scope.is_some() || self.all_external_files_migrated()
    }

    /// Drop the hop secrets of `connection` — as just persisted in the file
    /// with credential scope `scope` — whose hop it no longer has. Never fails
    /// the save: a locked store, a shared legacy key or a store error defers
    /// the prune to the next sweep (see the module docs).
    pub(crate) fn prune_hop_secrets_after_save(
        &self,
        connection: &SavedConnection,
        scope: Option<&str>,
    ) {
        match self.credential_store.status() {
            CredentialStoreStatus::Unlocked => {}
            // Nothing can be stored without a store, so nothing is orphaned.
            CredentialStoreStatus::Unavailable => return,
            CredentialStoreStatus::Locked => {
                tracing::info!(
                    connection_id = %connection.id,
                    "Credential store is locked; unused hop secrets are dropped on the next unlock"
                );
                self.schedule_hop_secret_sweep();
                return;
            }
        }
        if !self.may_prune_hop_secrets(scope) {
            self.schedule_hop_secret_sweep();
            return;
        }
        let owner = owner_id(&connection.id, scope);
        if let Err(e) = self.prune_owner(&owner, connection) {
            tracing::warn!(
                connection_id = %connection.id,
                error = %e,
                "Could not drop unused hop secrets; will retry on the next unlock"
            );
            self.schedule_hop_secret_sweep();
        }
    }

    /// Make the next unlocked `migrate_credential_scopes` sweep every entry.
    pub(crate) fn schedule_hop_secret_sweep(&self) {
        self.hop_secrets_swept.store(false, Ordering::SeqCst);
    }

    /// Prune the field-secrets entry of `owner` against `connection`'s settings.
    fn prune_owner(&self, owner: &str, connection: &SavedConnection) -> anyhow::Result<()> {
        let removed = prune_orphan_hop_secrets(
            &*self.credential_store,
            owner,
            &connection.config.settings,
        )?;
        if !removed.is_empty() {
            tracing::info!(
                connection_id = %connection.id,
                count = removed.len(),
                "Dropped saved secrets of jump-host hops the connection no longer has"
            );
        }
        Ok(())
    }

    /// Prune every stored field-secrets entry against the saved connection it
    /// belongs to — once per run, and again after a save had to defer its
    /// prune. Only entries the store lists are read. An entry whose owner is
    /// no known connection (an unreadable file, a deleted connection) is left
    /// alone. A no-op while the store is not unlocked.
    pub(crate) fn sweep_orphan_hop_secrets(&self) {
        if self.hop_secrets_swept.load(Ordering::SeqCst)
            || self.credential_store.status() != CredentialStoreStatus::Unlocked
        {
            return;
        }
        let _one_at_a_time = self.hop_prune.lock().unwrap_or_else(|e| e.into_inner());
        if self.hop_secrets_swept.swap(true, Ordering::SeqCst) {
            return;
        }
        let owners: HashSet<String> = match self.credential_store.list_keys() {
            Ok(keys) => keys
                .into_iter()
                .filter(|k| k.credential_type == CredentialType::FieldSecrets)
                .map(|k| k.connection_id)
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, "Could not list saved secrets to drop unused hop secrets");
                self.schedule_hop_secret_sweep();
                return;
            }
        };
        if owners.is_empty() {
            return;
        }
        for (owner, connection) in self.hop_secret_owners() {
            if !owners.contains(&owner) {
                continue;
            }
            if let Err(e) = self.prune_owner(&owner, &connection) {
                tracing::warn!(
                    connection_id = %connection.id,
                    error = %e,
                    "Could not drop unused hop secrets; will retry on the next run"
                );
            }
        }
    }

    /// Owner id → saved connection for every connection whose entry may be
    /// pruned now: the main store's once every external file is migrated, and
    /// each configured, readable external file's under its bound scope.
    fn hop_secret_owners(&self) -> HashMap<String, SavedConnection> {
        let mut owners = HashMap::new();
        if self.may_prune_hop_secrets(None) {
            match self.get_all() {
                Ok(main) => owners.extend(main.connections.into_iter().map(|c| (c.id.clone(), c))),
                Err(e) => tracing::warn!(error = %e, "Could not read the connection store"),
            }
        }
        for path in self.configured_external_paths() {
            let Some(scope) = self.file_scopes.binding(&path) else {
                continue;
            };
            if !Path::new(&path).exists() {
                continue;
            }
            let Ok(store) = read_external_store(&path) else {
                continue;
            };
            for conn in flatten_tree(&store.children, None).0 {
                owners.insert(owner_id(&conn.id, Some(&scope)), conn);
            }
        }
        owners
    }
}

#[cfg(test)]
#[path = "manager_hop_secrets_tests.rs"]
mod tests;
