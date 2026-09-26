//! Registry operations used by the connection import (#3564): adding a
//! credential carried by an import file, and filling in a missing secret.
//! Split from the main registry so it stays within the file-size budget.

use tracing::{info, warn};

use super::{
    ensure_writable, now, secret_key, NamedCredential, NamedCredentialError, NamedCredentialKind,
    NamedCredentialRegistry, NamedCredentialStore, MAX_NAME_LEN,
};
use crate::credential::types::StorageMode;
use crate::credential::CredentialStore;

/// Suffix appended to an imported credential's name that clashes locally.
const IMPORT_SUFFIX: &str = "imported";

/// The trimmed, length-capped display name of an imported credential.
fn import_base_name(name: &str) -> String {
    let name = name.trim();
    let name = if name.is_empty() {
        "Imported credential"
    } else {
        name
    };
    name.chars().take(MAX_NAME_LEN).collect()
}

/// `base`, or `base (imported)`, `base (imported 2)`, … — the first name no
/// credential in `doc` uses (case-insensitively), within [`MAX_NAME_LEN`].
fn unique_import_name(doc: &NamedCredentialStore, base: &str) -> String {
    let taken = |candidate: &str| {
        let lower = candidate.to_lowercase();
        doc.credentials
            .iter()
            .any(|c| c.name.to_lowercase() == lower)
    };
    if !taken(base) {
        return base.to_string();
    }
    (1..)
        .map(|n| {
            let suffix = if n == 1 {
                format!(" ({IMPORT_SUFFIX})")
            } else {
                format!(" ({IMPORT_SUFFIX} {n})")
            };
            let room = MAX_NAME_LEN.saturating_sub(suffix.chars().count());
            let stem: String = base.chars().take(room).collect();
            format!("{}{suffix}", stem.trim_end())
        })
        .find(|candidate| !taken(candidate))
        .expect("an unbounded suffix sequence always finds a free name")
}

impl NamedCredentialRegistry {
    /// Add a credential carried by a connection import (#3564).
    ///
    /// Keeps `id` when no local credential uses it (so references in the
    /// imported connections stay valid) and otherwise mints a fresh one; a
    /// name that clashes with a local credential gets an `(imported)` suffix.
    /// An existing credential is never touched. `secret` may be absent (an
    /// export without a password carries references only): the credential is
    /// then listed without a secret, connections using it prompt, and the user
    /// sets the secret by rotating it. The secret, when present, is written
    /// before the metadata, exactly like [`create`](Self::create).
    pub fn import_credential(
        &self,
        store: &dyn CredentialStore,
        mode: &StorageMode,
        id: &str,
        name: &str,
        kind: NamedCredentialKind,
        secret: Option<&str>,
    ) -> Result<NamedCredential, NamedCredentialError> {
        ensure_writable(store, mode)?;
        let secret = secret.filter(|s| !s.is_empty());
        let base = import_base_name(name);
        let id = {
            let doc = self.lock();
            let id = id.trim();
            if id.is_empty() || doc.credentials.iter().any(|c| c.id == id) {
                format!("nc-{}", uuid::Uuid::new_v4())
            } else {
                id.to_string()
            }
        };
        let key = secret_key(&id, kind);
        if let Some(secret) = secret {
            store.set(&key, secret).map_err(|e| {
                NamedCredentialError::other(format!("Could not store the secret: {e:#}"))
            })?;
        }
        let result = self.update(|doc| {
            if doc.credentials.iter().any(|c| c.id == id) {
                return Err(NamedCredentialError::other(format!(
                    "A shared credential with id \"{id}\" already exists."
                )));
            }
            let credential = NamedCredential {
                id: id.clone(),
                name: unique_import_name(doc, &base),
                kind,
                created_at: now(),
                rotated_at: None,
            };
            doc.credentials.push(credential.clone());
            Ok(credential)
        });
        match result {
            Ok(credential) => {
                info!(id = %credential.id, kind = ?kind, has_secret = secret.is_some(),
                    "shared credential imported");
                Ok(credential)
            }
            Err(e) => {
                if secret.is_some() {
                    if let Err(rollback) = store.remove(&key) {
                        warn!(key = %key, error = %rollback,
                            "failed to roll back an imported shared credential secret");
                    }
                }
                Err(e)
            }
        }
    }

    /// Store `secret` for an existing credential that has none in the
    /// current store — never replaces a secret that is already there.
    ///
    /// Returns `Ok(true)` when the secret was written.
    pub fn fill_missing_secret(
        &self,
        store: &dyn CredentialStore,
        mode: &StorageMode,
        id: &str,
        secret: &str,
    ) -> Result<bool, NamedCredentialError> {
        ensure_writable(store, mode)?;
        let credential = self
            .get(id)
            .ok_or_else(|| NamedCredentialError::not_found(id))?;
        if secret.is_empty() {
            return Ok(false);
        }
        let key = secret_key(id, credential.kind);
        let existing = store.get(&key).map_err(|e| {
            NamedCredentialError::other(format!("Could not read the secret: {e:#}"))
        })?;
        if existing.is_some() {
            return Ok(false);
        }
        store.set(&key, secret).map_err(|e| {
            NamedCredentialError::other(format!("Could not store the secret: {e:#}"))
        })?;
        info!(id = %id, "missing shared credential secret filled from an import");
        Ok(true)
    }
}
