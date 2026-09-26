//! Shared named credentials (#3557, PROD-065).
//!
//! A **named credential** is a first-class secret — a password or an SSH key
//! passphrase — with a stable id and a display name, which any number of saved
//! connections and remote agents can reference instead of carrying their own
//! per-connection secret. Rotating it in one place changes it for every
//! connection that references it.
//!
//! # Where the data lives
//!
//! - **Metadata** (id, name, kind, timestamps — never the secret) lives in
//!   `named_credentials.json` in the config directory, a [`VersionedStore`]
//!   (schema v1) with the standard recovery / downgrade-safety rules.
//! - **The secret** lives in the active credential store (master password or
//!   OS keychain) under the owner id `named-credential:<id>` and the
//!   credential type of its kind (see [`secret_key`]). Because it is an
//!   ordinary [`CredentialKey`], every existing store-level mechanism — the
//!   master-password file, OS-keychain entries, vault export / import, the
//!   unified backup's credentials section and its OS re-authentication gate —
//!   carries it without a format change.
//! - **References** are a `credentialRef` string in a connection's settings
//!   (see [`SETTINGS_REF_KEY`]) or `credentialRef` on a remote agent's config.
//!
//! # Resolution precedence
//!
//! A connection that references a named credential uses **only** that
//! credential: its per-connection secret (if any is still stored) is never
//! consulted, so a rotated shared secret can never be shadowed by a stale
//! per-connection copy. A connection without a reference keeps the unchanged
//! per-connection behaviour. A reference to a credential that does not exist
//! (deleted, or a config copied from another machine) resolves to nothing —
//! the connect flow then prompts, exactly as for a missing per-connection
//! secret.
//!
//! # Storage modes
//!
//! With credential storage turned off (`none`) a named credential cannot be
//! created or rotated — there is nowhere to keep the secret. Switching between
//! the master-password store and the OS keychain migrates named secrets like
//! any other (the OS keychain cannot enumerate its items, so the switch probes
//! [`NamedCredentialRegistry::secret_keys`] explicitly).
//!
//! # Deleting
//!
//! Deleting a credential that is still referenced is **refused**, and the
//! refusal lists every referencing connection / agent (see
//! [`NamedCredentialError::InUse`]). Silently deleting it would turn every
//! referencing connection into one that fails (or prompts) at connect time —
//! the failure would surface far from its cause, possibly on an unattended
//! reconnect. The user detaches or re-points those connections first.
//!
//! Secrets are never logged; only ids, names and counts are.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use super::types::{CredentialKey, CredentialStoreStatus, CredentialType, StorageMode};
use super::CredentialStore;
use crate::connection::config::{SavedConnection, SavedRemoteAgent};
use crate::connection::recovery::RecoveryWarning;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{
    guard_not_newer, load_store_with_recovery, salvage_list_store, Salvage, VersionedStore,
};

/// Prefix of every named-credential owner id in the credential store.
pub const OWNER_PREFIX: &str = "named-credential:";
/// The metadata file in the config directory.
pub const FILE_NAME: &str = "named_credentials.json";
/// The connection-settings key holding a reference to a named credential.
pub const SETTINGS_REF_KEY: &str = "credentialRef";
/// Upper bound on a credential's display name, in characters.
pub const MAX_NAME_LEN: usize = 100;

/// What a named credential holds.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NamedCredentialKind {
    /// A password (SSH password authentication, remote-agent password).
    Password,
    /// The passphrase protecting an SSH private key.
    KeyPassphrase,
}

impl NamedCredentialKind {
    /// The credential-store type the secret is kept under.
    pub fn credential_type(self) -> CredentialType {
        match self {
            NamedCredentialKind::Password => CredentialType::Password,
            NamedCredentialKind::KeyPassphrase => CredentialType::KeyPassphrase,
        }
    }

    /// The kind a connection with `auth_method` needs, or `None` when the
    /// method uses no stored secret (e.g. `"agent"`).
    pub fn for_auth_method(auth_method: &str) -> Option<Self> {
        match auth_method {
            "password" => Some(NamedCredentialKind::Password),
            "key" => Some(NamedCredentialKind::KeyPassphrase),
            _ => None,
        }
    }
}

/// Metadata of one named credential. Contains no secret.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCredential {
    /// Stable id (`nc-<uuid>`); never changes, so references survive renames.
    pub id: String,
    /// Display name, unique (case-insensitively) among named credentials.
    pub name: String,
    pub kind: NamedCredentialKind,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// RFC 3339 time of the last secret rotation, if it was ever rotated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub rotated_at: Option<String>,
}

/// The on-disk `named_credentials.json` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedCredentialStore {
    pub version: String,
    #[serde(default)]
    pub credentials: Vec<NamedCredential>,
    /// Unknown top-level keys, preserved on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for NamedCredentialStore {
    fn default() -> Self {
        Self {
            version: <Self as VersionedStore>::CURRENT_VERSION.to_string(),
            credentials: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl VersionedStore for NamedCredentialStore {
    const STORE_NAME: &'static str = FILE_NAME;
    /// v1 (#3557): the first released schema.
    const CURRENT_VERSION: u32 = 1;

    fn salvage(raw: &str, file_name: &str) -> Salvage<Self> {
        salvage_list_store::<Self, NamedCredential>(raw, file_name, "credentials")
    }
}

/// A connection or agent that references a named credential.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCredentialUsage {
    /// `"connection"` or `"agent"`.
    pub owner_kind: String,
    pub owner_id: String,
    pub owner_name: String,
}

/// A named-credential operation failure, serialized to the frontend as
/// `{ "kind": "<variant>", "message": "…" }` (plus `usages` for `inUse`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Serialize, thiserror::Error, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NamedCredentialError {
    /// Credential storage is off (or not set up) — no secret can be kept.
    #[error("{message}")]
    StoreUnavailable { message: String },
    /// The master-password store is locked.
    #[error("{message}")]
    StoreLocked { message: String },
    /// The name or secret is invalid (empty, too long, duplicate name).
    #[error("{message}")]
    Invalid { message: String },
    /// No named credential has this id.
    #[error("{message}")]
    NotFound { message: String },
    /// Delete refused: connections / agents still reference the credential.
    #[error("{message}")]
    InUse {
        message: String,
        usages: Vec<NamedCredentialUsage>,
    },
    /// Any other failure (store or file write error, …).
    #[error("{message}")]
    Other { message: String },
}

impl NamedCredentialError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self::Other {
            message: message.into(),
        }
    }

    fn not_found(id: &str) -> Self {
        Self::NotFound {
            message: format!("No shared credential with id \"{id}\" exists."),
        }
    }
}

/// The credential-store owner id of a named credential.
pub fn owner_id(id: &str) -> String {
    format!("{OWNER_PREFIX}{id}")
}

/// Whether a credential-store owner id belongs to a named credential.
pub fn is_named_owner(owner: &str) -> bool {
    owner.starts_with(OWNER_PREFIX)
}

/// The credential-store key of a named credential's secret.
pub fn secret_key(id: &str, kind: NamedCredentialKind) -> CredentialKey {
    CredentialKey::new(&owner_id(id), kind.credential_type())
}

/// The named-credential reference in a connection's settings, if any.
///
/// Only a non-empty string counts; anything else is "no reference", so a
/// malformed value can never turn into a lookup.
pub fn settings_ref(settings: &Value) -> Option<&str> {
    settings
        .get(SETTINGS_REF_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The named-credential reference of a remote agent, if any.
pub fn agent_ref(agent: &SavedRemoteAgent) -> Option<&str> {
    agent
        .config
        .credential_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Every connection / agent referencing credential `id`, sorted by name.
pub fn find_usages(
    id: &str,
    connections: &[SavedConnection],
    agents: &[SavedRemoteAgent],
) -> Vec<NamedCredentialUsage> {
    let mut usages: Vec<NamedCredentialUsage> =
        connections
            .iter()
            .filter(|c| settings_ref(&c.config.settings) == Some(id))
            .map(|c| NamedCredentialUsage {
                owner_kind: "connection".to_string(),
                owner_id: c.id.clone(),
                owner_name: c.name.clone(),
            })
            .chain(agents.iter().filter(|a| agent_ref(a) == Some(id)).map(|a| {
                NamedCredentialUsage {
                    owner_kind: "agent".to_string(),
                    owner_id: a.id.clone(),
                    owner_name: a.name.clone(),
                }
            }))
            .collect();
    usages.sort_by(|a, b| {
        a.owner_name
            .to_lowercase()
            .cmp(&b.owner_name.to_lowercase())
            .then_with(|| a.owner_id.cmp(&b.owner_id))
    });
    usages
}

/// Refuse writes when the store cannot keep a secret right now.
fn ensure_writable(
    store: &dyn CredentialStore,
    mode: &StorageMode,
) -> Result<(), NamedCredentialError> {
    if *mode == StorageMode::None {
        return Err(NamedCredentialError::StoreUnavailable {
            message: "Credential storage is turned off. Choose Master Password or OS Keychain \
                      in Settings → Security to use shared credentials."
                .to_string(),
        });
    }
    match store.status() {
        CredentialStoreStatus::Unlocked => Ok(()),
        CredentialStoreStatus::Locked => Err(NamedCredentialError::StoreLocked {
            message: "Unlock the credential store first.".to_string(),
        }),
        CredentialStoreStatus::Unavailable => Err(NamedCredentialError::StoreUnavailable {
            message: "Set up a master password first.".to_string(),
        }),
    }
}

fn validate_secret(secret: &str) -> Result<(), NamedCredentialError> {
    if secret.is_empty() {
        return Err(NamedCredentialError::invalid(
            "The secret must not be empty.",
        ));
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// In-memory view of `named_credentials.json`, persisted on every change.
pub struct NamedCredentialRegistry {
    /// `None` for an in-memory registry (tests, or no config directory).
    path: Option<PathBuf>,
    state: Mutex<NamedCredentialStore>,
}

impl NamedCredentialRegistry {
    /// Load the registry from `config_dir`, with the standard recovery rules
    /// (a newer file is left untouched and reported; a corrupt one is backed
    /// up and reset; individually corrupt entries are dropped).
    pub fn load(config_dir: &Path) -> (Self, Vec<RecoveryWarning>) {
        let path = config_dir.join(FILE_NAME);
        let (data, warnings) =
            match load_store_with_recovery::<NamedCredentialStore>(&path, FILE_NAME) {
                Ok(result) => (result.data, result.warnings),
                Err(e) => {
                    warn!(error = %e, "failed to load {FILE_NAME}; starting empty");
                    (
                        NamedCredentialStore::default(),
                        vec![RecoveryWarning {
                            file_name: FILE_NAME.to_string(),
                            message: "Could not load shared credentials.".to_string(),
                            details: Some(e.to_string()),
                        }],
                    )
                }
            };
        (
            Self {
                path: Some(path),
                state: Mutex::new(data),
            },
            warnings,
        )
    }

    /// An empty registry that is never persisted.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            state: Mutex::new(NamedCredentialStore::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, NamedCredentialStore> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Persist `doc` (refusing to overwrite a newer file, PER-004).
    fn persist(&self, doc: &NamedCredentialStore) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        guard_not_newer(
            path,
            NamedCredentialStore::STORE_NAME,
            NamedCredentialStore::CURRENT_VERSION,
        )?;
        let mut value = serde_json::to_value(doc).context("Failed to serialize credentials")?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "version".to_string(),
                Value::String(NamedCredentialStore::CURRENT_VERSION.to_string()),
            );
        }
        let data = serde_json::to_string_pretty(&value).context("Failed to serialize")?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("Failed to create config directory")?;
        }
        write_atomic(path, &data).with_context(|| format!("Failed to write {FILE_NAME}"))
    }

    /// Apply `change` to a copy of the document and persist it; the in-memory
    /// state only changes once the write succeeded.
    fn update<R>(
        &self,
        change: impl FnOnce(&mut NamedCredentialStore) -> Result<R, NamedCredentialError>,
    ) -> Result<R, NamedCredentialError> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        let result = change(&mut next)?;
        self.persist(&next).map_err(|e| {
            NamedCredentialError::other(format!("Could not save shared credentials: {e:#}"))
        })?;
        *guard = next;
        Ok(result)
    }

    /// Every named credential, sorted by name.
    pub fn list(&self) -> Vec<NamedCredential> {
        let mut list = self.lock().credentials.clone();
        list.sort_by_key(|c| c.name.to_lowercase());
        list
    }

    /// The credential with `id`, if any.
    pub fn get(&self, id: &str) -> Option<NamedCredential> {
        self.lock().credentials.iter().find(|c| c.id == id).cloned()
    }

    /// The credential-store key of every named credential's secret — used to
    /// probe stores that cannot enumerate their contents (OS keychain).
    pub fn secret_keys(&self) -> Vec<CredentialKey> {
        self.lock()
            .credentials
            .iter()
            .map(|c| secret_key(&c.id, c.kind))
            .collect()
    }

    /// Owner id → display label, for vault / backup previews.
    pub fn owner_labels(&self) -> Vec<(String, String)> {
        self.lock()
            .credentials
            .iter()
            .map(|c| (owner_id(&c.id), format!("{} (shared credential)", c.name)))
            .collect()
    }

    fn check_name(
        doc: &NamedCredentialStore,
        name: &str,
        except_id: Option<&str>,
    ) -> Result<String, NamedCredentialError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(NamedCredentialError::invalid("Enter a name."));
        }
        if name.chars().count() > MAX_NAME_LEN {
            return Err(NamedCredentialError::invalid(format!(
                "The name must be at most {MAX_NAME_LEN} characters."
            )));
        }
        let lower = name.to_lowercase();
        if doc
            .credentials
            .iter()
            .any(|c| Some(c.id.as_str()) != except_id && c.name.to_lowercase() == lower)
        {
            return Err(NamedCredentialError::invalid(format!(
                "A shared credential named \"{name}\" already exists."
            )));
        }
        Ok(name.to_string())
    }

    /// Create a named credential holding `secret`.
    ///
    /// The secret is written to the store **before** the metadata, so an
    /// interruption can leave at worst an invisible, unreferenced secret —
    /// never a listed credential without one. A failed metadata write removes
    /// the secret again.
    pub fn create(
        &self,
        store: &dyn CredentialStore,
        mode: &StorageMode,
        name: &str,
        kind: NamedCredentialKind,
        secret: &str,
    ) -> Result<NamedCredential, NamedCredentialError> {
        ensure_writable(store, mode)?;
        validate_secret(secret)?;
        let name = Self::check_name(&self.lock(), name, None)?;
        let credential = NamedCredential {
            id: format!("nc-{}", uuid::Uuid::new_v4()),
            name,
            kind,
            created_at: now(),
            rotated_at: None,
        };
        let key = secret_key(&credential.id, kind);
        store.set(&key, secret).map_err(|e| {
            NamedCredentialError::other(format!("Could not store the secret: {e:#}"))
        })?;

        let created = credential.clone();
        let result = self.update(move |doc| {
            // Re-check under the lock: a concurrent create may have taken the name.
            Self::check_name(doc, &created.name, None)?;
            doc.credentials.push(created);
            Ok(())
        });
        if let Err(e) = result {
            if let Err(rollback) = store.remove(&key) {
                warn!(key = %key, error = %rollback, "failed to roll back a shared credential secret");
            }
            return Err(e);
        }
        info!(id = %credential.id, kind = ?kind, "shared credential created");
        Ok(credential)
    }

    /// Rename a credential. References use the id, so nothing else changes.
    pub fn rename(&self, id: &str, name: &str) -> Result<NamedCredential, NamedCredentialError> {
        self.update(|doc| {
            let name = Self::check_name(doc, name, Some(id))?;
            let entry = doc
                .credentials
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| NamedCredentialError::not_found(id))?;
            entry.name = name;
            Ok(entry.clone())
        })
    }

    /// Replace a credential's secret. Every referencing connection uses the
    /// new value from its next connect.
    pub fn rotate(
        &self,
        store: &dyn CredentialStore,
        mode: &StorageMode,
        id: &str,
        secret: &str,
    ) -> Result<NamedCredential, NamedCredentialError> {
        ensure_writable(store, mode)?;
        validate_secret(secret)?;
        let credential = self
            .get(id)
            .ok_or_else(|| NamedCredentialError::not_found(id))?;
        store
            .set(&secret_key(id, credential.kind), secret)
            .map_err(|e| {
                NamedCredentialError::other(format!("Could not store the new secret: {e:#}"))
            })?;
        info!(id = %id, "shared credential rotated");
        // The timestamp is informational: the rotation itself already happened.
        match self.update(|doc| {
            let entry = doc
                .credentials
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| NamedCredentialError::not_found(id))?;
            entry.rotated_at = Some(now());
            Ok(entry.clone())
        }) {
            Ok(updated) => Ok(updated),
            Err(e) => {
                warn!(id = %id, error = %e, "shared credential rotated but its timestamp was not saved");
                Ok(credential)
            }
        }
    }

    /// Delete a credential that nothing references.
    ///
    /// `usages` are the connections / agents that reference it right now; a
    /// non-empty list refuses the delete ([`NamedCredentialError::InUse`]).
    /// The store must be writable (unless storage is off) so the secret is
    /// removed with the metadata rather than left behind.
    pub fn delete(
        &self,
        store: &dyn CredentialStore,
        mode: &StorageMode,
        id: &str,
        usages: Vec<NamedCredentialUsage>,
    ) -> Result<(), NamedCredentialError> {
        let credential = self
            .get(id)
            .ok_or_else(|| NamedCredentialError::not_found(id))?;
        if !usages.is_empty() {
            let count = usages.len();
            return Err(NamedCredentialError::InUse {
                message: format!(
                    "\"{}\" is used by {count} connection{}. Choose a different credential for \
                     {} first.",
                    credential.name,
                    if count == 1 { "" } else { "s" },
                    if count == 1 { "it" } else { "them" },
                ),
                usages,
            });
        }
        if *mode != StorageMode::None {
            ensure_writable(store, mode)?;
        }
        self.update(|doc| {
            doc.credentials.retain(|c| c.id != id);
            Ok(())
        })?;
        if let Err(e) = store.remove(&secret_key(id, credential.kind)) {
            warn!(id = %id, error = %e, "shared credential deleted but its secret could not be removed");
        }
        info!(id = %id, "shared credential deleted");
        Ok(())
    }

    /// Resolve the secret of credential `id` for a connection that needs a
    /// `credential_type` secret.
    ///
    /// `Ok(None)` when the credential does not exist, holds a different kind
    /// of secret, or has no secret in the current store. Store errors (e.g. a
    /// locked master-password store) are returned.
    pub fn resolve(
        &self,
        store: &dyn CredentialStore,
        id: &str,
        credential_type: &CredentialType,
    ) -> Result<Option<String>> {
        let Some(credential) = self.get(id) else {
            warn!(id = %id, "reference to an unknown shared credential");
            return Ok(None);
        };
        if credential.kind.credential_type() != *credential_type {
            warn!(
                id = %id,
                needed = %credential_type,
                "shared credential holds a different kind of secret"
            );
            return Ok(None);
        }
        store.get(&secret_key(id, credential.kind))
    }
}

#[cfg(test)]
mod tests;
