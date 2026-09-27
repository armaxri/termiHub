//! The [`ConnectionManager`]'s side of per-file credential scopes (#3591):
//! resolving an external file's scope, migrating its pre-#3591 secrets, and
//! the owner ids the credential commands, jump hosts and vault use.
//!
//! See [`credential_scope`](crate::connection::credential_scope) for the key scheme.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{bail, Result};

use super::{read_external_store, ConnectionManager, WrittenTree};
use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::connection::credential_scope::{
    migrate_legacy_keys, owner_id, same_file, LegacyHolders, ScopeNotice,
};
use crate::connection::placement::PlaceMode;
use crate::connection::recovery::RecoveryWarning;
use crate::connection::tree::flatten_tree;
use crate::credential::{CredentialKey, CredentialStoreStatus, CredentialType};

impl ConnectionManager {
    /// Paths of every configured external file, enabled or not.
    fn configured_external_paths(&self) -> Vec<String> {
        self.get_settings()
            .external_connection_files
            .into_iter()
            .map(|f| f.path)
            .collect()
    }

    /// The credential scope (file id) of the external file at `path`, binding
    /// one on first sight. Does not migrate; see [`Self::external_scope`].
    pub(crate) fn file_scope(&self, path: &str) -> String {
        self.file_scopes
            .resolve(path, &self.configured_external_paths())
    }

    /// The credential scope of the external file at `path`, after migrating
    /// its pre-#3591 secrets when the store is unlocked (once per file).
    pub(crate) fn external_scope(&self, path: &str) -> String {
        let scope = self.file_scope(path);
        self.migrate_legacy_secrets(path, &scope);
        scope
    }

    /// The key under which the secret of type `credential_type` of connection
    /// `connection_id` is stored — in the main store when `source_file` is
    /// `None`, else in that external file.
    pub fn connection_credential_key(
        &self,
        connection_id: &str,
        source_file: Option<&str>,
        credential_type: CredentialType,
    ) -> CredentialKey {
        // A main-store key may still be shared with an unmigrated file.
        self.migrate_credential_scopes();
        let scope = source_file.map(|path| self.external_scope(path));
        CredentialKey::new(&owner_id(connection_id, scope.as_deref()), credential_type)
    }

    /// Migrate the pre-#3591 secrets of every configured external file that
    /// has not been migrated yet, then delete the bare keys kept only because
    /// a file could not be read once nothing may need them (see
    /// [`Self::clean_up_kept_bare_keys`]). A no-op while the store is not
    /// unlocked; a failure is logged and retried on the next call.
    pub fn migrate_credential_scopes(&self) {
        if self.credential_store.status() != CredentialStoreStatus::Unlocked {
            return;
        }
        for path in self.configured_external_paths() {
            let done = self
                .file_scopes
                .binding(&path)
                .is_some_and(|id| self.file_scopes.is_migrated(&id));
            if !done && Path::new(&path).exists() {
                self.external_scope(&path);
            }
        }
        self.clean_up_kept_bare_keys();
    }

    /// Delete the bare keys a migration kept only because some configured
    /// file could not be read (#3650), once every configured file is readable
    /// and migrated — so every scoped copy was written durably and no
    /// unmigrated file may still need the bare key. An id the main store or an
    /// agent uses keeps its bare key (it is theirs) and is no longer tracked.
    /// A file removed from the configuration no longer holds anything back.
    pub(crate) fn clean_up_kept_bare_keys(&self) {
        if self.file_scopes.kept_bare_keys().is_empty()
            || self.credential_store.status() != CredentialStoreStatus::Unlocked
        {
            return;
        }
        let _one_at_a_time = self
            .scope_migration
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let kept = self.file_scopes.kept_bare_keys();
        if kept.is_empty() || !self.all_external_files_migrated() {
            return;
        }
        let main = match self.get_all() {
            Ok(main) => main,
            Err(e) => {
                tracing::warn!(error = %e, "Could not read the connection store; will retry");
                return;
            }
        };
        let main_ids: HashSet<String> = main
            .connections
            .into_iter()
            .map(|c| c.id)
            .chain(main.agents.into_iter().map(|a| a.id))
            .collect();

        let mut done = Vec::new();
        for id in kept {
            if main_ids.contains(&id) {
                done.push(id);
                continue;
            }
            let mut removed = true;
            for cred_type in CredentialType::ALL {
                let bare = CredentialKey::new(&id, cred_type);
                if let Err(e) = self.credential_store.remove(&bare) {
                    removed = false;
                    tracing::warn!(
                        key = %bare,
                        error = %e,
                        "Failed to remove a migrated credential's bare key; will retry"
                    );
                }
            }
            if removed {
                done.push(id);
            }
        }
        if !done.is_empty() {
            tracing::info!(
                count = done.len(),
                "Removed saved credentials left under bare connection ids"
            );
        }
        self.file_scopes.forget_kept_bare_keys(&done);
    }

    /// Whether every configured external file exists, can be read and was
    /// migrated, so none of them may still need a bare key.
    fn all_external_files_migrated(&self) -> bool {
        self.configured_external_paths().iter().all(|path| {
            Path::new(path).exists()
                && read_external_store(path).is_ok()
                && self
                    .file_scopes
                    .binding(path)
                    .is_some_and(|id| self.file_scopes.is_migrated(&id))
        })
    }

    /// Take the one-time notices about secrets copied from a key several
    /// connections shared, as warnings for the recovery dialog.
    pub fn take_credential_scope_notices(&self) -> Vec<RecoveryWarning> {
        self.file_scopes
            .take_notices()
            .into_iter()
            .map(notice_warning)
            .collect()
    }

    /// Credential owner id → display name for every saved connection (main
    /// store and enabled external files) and agent, for the vault export and
    /// its import preview.
    pub fn credential_owner_names(&self) -> Result<HashMap<String, String>> {
        let view = self.load_unified_view()?;
        let scopes = self.credential_scopes_of(&view.connections);
        let mut owners = HashMap::new();
        for conn in view.connections {
            match conn.source_file.as_deref() {
                None => {
                    owners.insert(conn.id, conn.name);
                }
                Some(path) => {
                    if let Some(scope) = scopes.get(path) {
                        let label = format!("{} ({})", conn.name, file_label(path));
                        owners.insert(owner_id(&conn.id, Some(scope)), label);
                    }
                }
            }
        }
        for agent in view.agents {
            owners.insert(agent.id, agent.name);
        }
        Ok(owners)
    }

    /// External file path → credential scope, for the files `connections`
    /// were loaded from (bound when they were loaded).
    pub(crate) fn credential_scopes_of(
        &self,
        connections: &[SavedConnection],
    ) -> HashMap<String, String> {
        let mut scopes = HashMap::new();
        for path in connections.iter().filter_map(|c| c.source_file.as_deref()) {
            if !scopes.contains_key(path) {
                if let Some(scope) = self.file_scopes.binding(path) {
                    scopes.insert(path.to_string(), scope);
                }
            }
        }
        scopes
    }

    /// Place `connection` into the external file at `path` (see
    /// [`super::place_in_external_file`]). A file this creates holds no
    /// pre-#3591 secrets, so its scope is recorded as migrated.
    pub(super) fn place_in_external_file(
        &self,
        path: &str,
        scope: &str,
        connection: SavedConnection,
        mode: PlaceMode,
        folder_source: &[ConnectionFolder],
    ) -> Result<WrittenTree> {
        let is_new = !Path::new(path).exists();
        let written = super::place_in_external_file(path, scope, connection, mode, folder_source)?;
        if is_new {
            self.file_scopes.complete_migration(scope, None, &[]);
        }
        Ok(written)
    }

    /// Write an external connection file (the `save_external_file` command),
    /// keeping its file id so its connections keep their secrets.
    pub fn save_external_file(
        &self,
        path: &str,
        name: &str,
        folders: Vec<ConnectionFolder>,
        connections: Vec<SavedConnection>,
    ) -> Result<()> {
        let is_new = !Path::new(path).exists();
        let scope = self.external_scope(path);
        super::write_new_external_file(
            path,
            name,
            Some(&scope),
            folders,
            connections,
            &*self.credential_store,
        )?;
        if is_new {
            self.file_scopes.complete_migration(&scope, None, &[]);
        }
        Ok(())
    }

    fn migrate_legacy_secrets(&self, path: &str, scope: &str) {
        if self.file_scopes.is_migrated(scope)
            || !Path::new(path).exists()
            || self.credential_store.status() != CredentialStoreStatus::Unlocked
        {
            return;
        }
        let _one_at_a_time = self
            .scope_migration
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.file_scopes.is_migrated(scope) {
            return;
        }
        match self.try_migrate_legacy_secrets(path, scope) {
            Ok((notice, kept_bare)) => {
                tracing::info!(
                    file = path,
                    "Scoped the saved credentials of an external connection file"
                );
                self.file_scopes
                    .complete_migration(scope, notice, &kept_bare);
            }
            Err(e) => tracing::warn!(
                file = path,
                error = %e,
                "Could not scope the saved credentials of an external connection file yet; will retry"
            ),
        }
    }

    /// Migrate one file; returns its notice and the ids whose bare key was
    /// kept while some other configured file could not be read.
    fn try_migrate_legacy_secrets(
        &self,
        path: &str,
        scope: &str,
    ) -> Result<(Option<ScopeNotice>, Vec<String>)> {
        if !Path::new(path).exists() {
            bail!("the file does not exist");
        }
        let (connections, _) = flatten_tree(&read_external_store(path)?.children, None);
        let main = self.get_all()?;
        let main_ids: HashSet<String> = main
            .connections
            .into_iter()
            .map(|c| c.id)
            .chain(main.agents.into_iter().map(|a| a.id))
            .collect();

        // Every other configured file's ids, and whether it was migrated. A
        // file whose ids cannot be read might use any id.
        let mut others: Vec<(HashSet<String>, bool)> = Vec::new();
        let mut unreadable = false;
        for other in self.configured_external_paths() {
            if same_file(&other, path) {
                continue;
            }
            let store = match Path::new(&other).exists() {
                true => read_external_store(&other).ok(),
                false => None,
            };
            let Some(store) = store else {
                unreadable = true;
                continue;
            };
            let ids = flatten_tree(&store.children, None)
                .0
                .into_iter()
                .map(|c| c.id)
                .collect();
            let migrated = self
                .file_scopes
                .binding(&other)
                .is_some_and(|id| self.file_scopes.is_migrated(&id));
            others.push((ids, migrated));
        }

        let holders = |id: &str| {
            let in_main = main_ids.contains(id);
            let elsewhere = others.iter().filter(|(ids, _)| ids.contains(id));
            let in_other = elsewhere.clone().next().is_some();
            let pending = elsewhere.clone().any(|(_, migrated)| !migrated);
            LegacyHolders {
                shared: in_main || in_other,
                keep_bare_key: in_main || pending || unreadable,
            }
        };
        let result = migrate_legacy_keys(scope, &connections, holders, &*self.credential_store)?;
        let notice = (!result.shared.is_empty()).then(|| ScopeNotice {
            file_path: path.to_string(),
            connection_names: result.shared,
        });
        // Only an unreadable file can leave a bare key behind for good: the
        // main store's and agents' keys are theirs, and a pending file's
        // migration decides about the key itself.
        let kept_bare = if unreadable {
            result.kept_bare
        } else {
            Vec::new()
        };
        Ok((notice, kept_bare))
    }
}

/// The file name of `path`, for labels.
fn file_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn notice_warning(notice: ScopeNotice) -> RecoveryWarning {
    RecoveryWarning {
        file_name: file_label(&notice.file_path),
        message: format!(
            "Saved passwords are now kept separately per connection file. These connections \
             shared a saved password with a same-named connection in another file, so each \
             kept a copy — if one no longer works, enter it again: {}.",
            notice.connection_names.join(", ")
        ),
        details: Some(format!(
            "termiHub used to store one saved password per connection name, whatever file the \
             connection is in (#3591). File: {}",
            notice.file_path
        )),
    }
}
