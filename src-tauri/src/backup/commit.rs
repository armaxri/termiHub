//! Committing a prepared restore (PROD-068): stage the chosen store files,
//! import the credentials as one batch, then commit with a single directory
//! rename. Any failure before the commit discards the staging directory and
//! puts the credentials back. The committed files are swapped into place on
//! the next start by [`super::pending::apply_pending_restore`].
//!
//! The credentials are imported right away, but the stores only at the next
//! start, so a committed restore also carries what that start needs to undo
//! the import if the swap fails (#4295): a copy of the credential vault taken
//! just before the import ([`CREDENTIALS_COPY_FILE`]) and a record of the
//! import ([`CREDENTIALS_RECORD_FILE`]).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use zeroize::{Zeroize, Zeroizing};

use super::restore::{prepare, OpenedBackup, PendingSecret, PreparedRestore};
use super::{BackupRestoreRequest, BackupRestoreResult};
use crate::credential::types::CredentialKey;
use crate::credential::vault::{self, VaultError};
use crate::credential::{CredentialStore, CredentialStoreStatus};
use crate::utils::fs::write_atomic;

/// Staging directory for a restore that is being written (not yet committed).
pub const STAGING_DIR: &str = ".backup-restore-staging";
/// Directory of a committed restore, applied on the next startup.
pub const PENDING_DIR: &str = ".backup-restore-pending";
/// Manifest listing the staged store files. Written last during staging.
pub const MANIFEST_FILE: &str = "manifest.json";

/// Copy of the credential vault file, taken just before the import (#4295).
pub const CREDENTIALS_COPY_FILE: &str = "credentials-rollback.enc";
/// Record of a credential import that a committed restore already applied.
/// Present only when the import changed (or may have changed) credentials.
pub const CREDENTIALS_RECORD_FILE: &str = "credentials-imported.json";

/// What a committed restore already did to the credential store, so a failed
/// swap at the next start can revert it (#4295).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialImportRecord {
    /// The vault file, relative to the config dir, that [`CREDENTIALS_COPY_FILE`]
    /// restores. `None` when the store keeps no such file (the OS keychain):
    /// its imported credentials cannot be reverted.
    pub vault_file: Option<String>,
    /// SHA-256 (hex) of the vault file right after the import. The copy is put
    /// back only while the vault is still exactly that, so a credential saved
    /// or a master password changed after the restore is never undone.
    pub imported_sha256: Option<String>,
}

/// SHA-256 of `bytes`, hex-encoded.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Manifest format with only top-level store files.
pub const MANIFEST_FORMAT_FILES_ONLY: u32 = 1;
/// Manifest format that may also name plugin-root files and plugin
/// directories (#3515). An older build refuses it (and discards the restore
/// with a warning) instead of half-applying it.
pub const MANIFEST_FORMAT_WITH_PLUGINS: u32 = 2;

/// The staged-restore manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingManifest {
    pub format_version: u32,
    /// Files relative to the config dir: a known section's `file_name`, or a
    /// restorable plugin-root file (`plugins/plugin-state.json`, …).
    pub files: Vec<String>,
    /// Plugin directories relative to the config dir (`plugins/<id>`): swapped
    /// in from the staged copy, or removed when no staged copy exists.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dirs: Vec<String>,
}

fn other(message: impl Into<String>) -> VaultError {
    VaultError::Other {
        message: message.into(),
    }
}

/// A staged (written, not yet committed) restore.
struct Staged {
    staging: PathBuf,
    pending: PathBuf,
}

impl Staged {
    fn discard(self) {
        if let Err(e) = std::fs::remove_dir_all(&self.staging) {
            warn!("Could not remove the backup-restore staging directory: {e}");
        }
    }

    /// Atomically commit the staged restore (a single directory rename). An
    /// earlier committed-but-unapplied restore is superseded.
    fn commit(self) -> Result<(), VaultError> {
        let outcome = (|| {
            if self.pending.exists() {
                std::fs::remove_dir_all(&self.pending)
                    .map_err(|e| format!("could not replace an earlier pending restore: {e}"))?;
            }
            std::fs::rename(&self.staging, &self.pending).map_err(|e| e.to_string())
        })();
        outcome.map_err(|e| {
            self.discard();
            other(format!("Could not commit the restore: {e}"))
        })
    }
}

/// Write every prepared file plus the manifest (last) into the staging dir.
fn stage(config_dir: &Path, prepared: &PreparedRestore) -> Result<Staged, VaultError> {
    let staging = config_dir.join(STAGING_DIR);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| {
            other(format!(
                "Could not clear the restore staging directory: {e}"
            ))
        })?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| {
        other(format!(
            "Could not create the restore staging directory: {e}"
        ))
    })?;
    let staged = Staged {
        staging: staging.clone(),
        pending: config_dir.join(PENDING_DIR),
    };
    let write_all = || -> Result<(), VaultError> {
        for (file_name, text) in &prepared.files {
            let target = staging.join(file_name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| other(format!("Could not stage {file_name}: {e}")))?;
            }
            write_atomic(&target, text)
                .map_err(|e| other(format!("Could not stage {file_name}: {e:#}")))?;
        }
        for dir in &prepared.dirs {
            let Some(files) = &dir.files else { continue };
            let base = staging.join(&dir.rel);
            std::fs::create_dir_all(&base)
                .map_err(|e| other(format!("Could not stage {}: {e}", dir.rel)))?;
            for (rel, bytes) in files {
                let target = base.join(rel);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| other(format!("Could not stage {}/{rel}: {e}", dir.rel)))?;
                }
                std::fs::write(&target, bytes)
                    .map_err(|e| other(format!("Could not stage {}/{rel}: {e}", dir.rel)))?;
            }
        }
        let nested =
            !prepared.dirs.is_empty() || prepared.files.iter().any(|(f, _)| f.contains('/'));
        let manifest = PendingManifest {
            format_version: if nested {
                MANIFEST_FORMAT_WITH_PLUGINS
            } else {
                MANIFEST_FORMAT_FILES_ONLY
            },
            files: prepared.files.iter().map(|(f, _)| f.clone()).collect(),
            dirs: prepared.dirs.iter().map(|d| d.rel.clone()).collect(),
        };
        let manifest_text = serde_json::to_string_pretty(&manifest)
            .map_err(|e| other(format!("Could not write the restore manifest: {e}")))?;
        write_atomic(&staging.join(MANIFEST_FILE), &manifest_text)
            .map_err(|e| other(format!("Could not write the restore manifest: {e:#}")))
    };
    match write_all() {
        Ok(()) => Ok(staged),
        Err(e) => {
            staged.discard();
            Err(e)
        }
    }
}

/// The credential values a vault import is about to change, so a failed
/// commit can put them back. Values are zeroized on drop.
struct CredentialSnapshot(Vec<(CredentialKey, Option<Zeroizing<String>>)>);

impl CredentialSnapshot {
    fn take<'a>(
        keys: impl IntoIterator<Item = &'a CredentialKey>,
        store: &dyn CredentialStore,
    ) -> Result<Self, VaultError> {
        keys.into_iter()
            .map(|key| {
                store
                    .get(key)
                    .map(|v| (key.clone(), v.map(Zeroizing::new)))
                    .map_err(|e| other(format!("Could not read the current credential store: {e}")))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(CredentialSnapshot)
    }

    /// Best-effort: put back every value the import may have changed.
    fn restore(&self, store: &dyn CredentialStore) {
        for (key, previous) in &self.0 {
            let outcome = match previous {
                Some(value) => store.set(key, value),
                None => store.remove(key),
            };
            if let Err(e) = outcome {
                warn!(credential = %key, "Could not roll back a restored credential: {e}");
            }
        }
    }
}

/// Move the legacy plaintext passwords of the restored items into the
/// credential store (#3514) — they are never written to a restored file.
///
/// Keys the credentials section already restores are left to it. With an
/// unlocked store they are written as one batch (a snapshot of the values they
/// replace is pushed to `snapshots` first); a locked store refuses the restore
/// with an "unlock first" error; with credential storage off they cannot be
/// kept and are dropped (the restore preview says so).
fn import_legacy_secrets(
    secrets: &[PendingSecret],
    covered: &[&CredentialKey],
    store: Option<&dyn CredentialStore>,
    snapshots: &mut Vec<CredentialSnapshot>,
) -> Result<(), VaultError> {
    let secrets: Vec<&PendingSecret> = secrets
        .iter()
        .filter(|s| !covered.contains(&&s.key))
        .collect();
    if secrets.is_empty() {
        return Ok(());
    }
    let store = match store {
        Some(store) if store.status() == CredentialStoreStatus::Unlocked => store,
        Some(store) if store.status() == CredentialStoreStatus::Locked => {
            return Err(VaultError::StoreLocked {
                message: "This backup keeps embedded server passwords in the old plain-text \
                          format. Unlock the credential store so they can be moved into it, then \
                          restore again."
                    .to_string(),
            })
        }
        _ => {
            warn!(
                count = secrets.len(),
                "Credential storage is off; plaintext passwords from the backup are not restored"
            );
            return Ok(());
        }
    };
    let mut entries: Vec<(CredentialKey, String)> = Vec::new();
    for secret in secrets {
        if !secret.overwrite {
            let existing = store
                .get(&secret.key)
                .map_err(|e| other(format!("Could not read the current credential store: {e}")))?
                .map(Zeroizing::new);
            if existing.is_some_and(|v| !v.is_empty()) {
                continue;
            }
        }
        entries.push((secret.key.clone(), secret.value.as_str().to_owned()));
    }
    if entries.is_empty() {
        return Ok(());
    }
    let snapshot = CredentialSnapshot::take(entries.iter().map(|(key, _)| key), store);
    let result = snapshot.and_then(|snapshot| {
        snapshots.push(snapshot);
        store.set_many(&entries).map_err(|e| {
            other(format!(
                "Could not move the backup's plaintext passwords into the credential store: {e}"
            ))
        })
    });
    for (_, value) in entries.iter_mut() {
        value.zeroize();
    }
    if result.is_ok() {
        info!(
            count = entries.len(),
            "Moved plaintext passwords from the backup into the credential store"
        );
    }
    result
}

/// The store's vault file name when it is a plain file directly in
/// `config_dir` (the master-password vault), so the next start can find it.
fn vault_file_name(store: &dyn CredentialStore, config_dir: &Path) -> Option<String> {
    let path = store.vault_file()?;
    if path.parent()? != config_dir {
        return None;
    }
    path.file_name()?.to_str().map(str::to_owned)
}

/// Copy the credential vault into the staging dir before the import changes
/// it. Returns the vault's file name, or `None` when the store keeps no vault
/// file there (nothing to copy).
fn copy_vault(
    store: &dyn CredentialStore,
    config_dir: &Path,
    staging: &Path,
) -> Result<Option<String>, VaultError> {
    let Some(name) = vault_file_name(store, config_dir) else {
        return Ok(None);
    };
    let vault = config_dir.join(&name);
    if !vault.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&vault).map_err(|e| {
        other(format!(
            "Could not back up the credential store before restoring: {e}"
        ))
    })?;
    write_atomic(&staging.join(CREDENTIALS_COPY_FILE), &text).map_err(|e| {
        other(format!(
            "Could not back up the credential store before restoring: {e:#}"
        ))
    })?;
    Ok(Some(name))
}

/// Record the applied credential import in the staging dir (written before
/// the commit, so it is committed together with the stores).
fn record_import(
    config_dir: &Path,
    staging: &Path,
    vault_copy: Option<String>,
) -> Result<(), VaultError> {
    let imported_sha256 = match &vault_copy {
        Some(name) => Some(sha256_hex(&std::fs::read(config_dir.join(name)).map_err(
            |e| {
                other(format!(
                    "Could not read the credential store after the import: {e}"
                ))
            },
        )?)),
        None => None,
    };
    let record = CredentialImportRecord {
        vault_file: vault_copy,
        imported_sha256,
    };
    let text = serde_json::to_string_pretty(&record)
        .map_err(|e| other(format!("Could not record the credential import: {e}")))?;
    write_atomic(&staging.join(CREDENTIALS_RECORD_FILE), &text)
        .map_err(|e| other(format!("Could not record the credential import: {e:#}")))
}

/// Apply a restore: stage the chosen stores, import the credentials, then
/// commit. All-or-nothing: on any failure nothing is committed and the
/// credential store is rolled back.
///
/// `store` must be the (already authorized) credential store when
/// `request.credentials` is set. It is also where legacy plaintext passwords
/// in a restored section go (see [`import_legacy_secrets`]); without it they
/// are dropped.
pub fn apply(
    opened: &OpenedBackup,
    config_dir: &Path,
    request: &BackupRestoreRequest,
    store: Option<&dyn CredentialStore>,
) -> Result<BackupRestoreResult, VaultError> {
    let prepared = prepare(opened, config_dir, request)?;
    let staged = if prepared.files.is_empty() && prepared.dirs.is_empty() {
        None
    } else {
        Some(stage(config_dir, &prepared)?)
    };

    let mut snapshots: Vec<CredentialSnapshot> = Vec::new();
    let roll_back = |snapshots: &[CredentialSnapshot]| {
        if let Some(store) = store {
            for snapshot in snapshots.iter().rev() {
                snapshot.restore(store);
            }
        }
    };
    let outcome = (|| {
        // A restart-applied restore keeps a copy of the vault from before the
        // import, so a swap that fails at the next start can revert it.
        let vault_copy = match (store, &staged) {
            (Some(store), Some(staged)) => copy_vault(store, config_dir, &staged.staging)?,
            _ => None,
        };
        let mut credentials_result = None;
        let mut covered: Vec<&CredentialKey> = Vec::new();
        if let (Some(strategy), Some(vault)) = (request.credentials, opened.credentials.as_ref()) {
            let store = store.ok_or_else(|| VaultError::StoreUnavailable {
                message: "There is no credential store to restore the credentials into."
                    .to_string(),
            })?;
            snapshots.push(CredentialSnapshot::take(
                vault.entries.iter().map(|(key, _)| key),
                store,
            )?);
            credentials_result = Some(vault::apply_import(vault, store, strategy)?);
            covered.extend(vault.entries.iter().map(|(key, _)| key));
        }
        import_legacy_secrets(&prepared.secrets, &covered, store, &mut snapshots)?;
        if let (Some(staged), false) = (&staged, snapshots.is_empty()) {
            record_import(config_dir, &staged.staging, vault_copy)?;
        }
        Ok::<_, VaultError>(credentials_result)
    })();
    let credentials_result = match outcome {
        Ok(result) => result,
        Err(e) => {
            roll_back(&snapshots);
            if let Some(staged) = staged {
                staged.discard();
            }
            return Err(e);
        }
    };

    let restart_required = staged.is_some();
    if let Some(staged) = staged {
        if let Err(e) = staged.commit() {
            roll_back(&snapshots);
            return Err(e);
        }
    }

    info!(
        sections = prepared.outcomes.len(),
        credentials = credentials_result.is_some(),
        restart_required,
        "backup restore committed"
    );
    Ok(BackupRestoreResult {
        sections: prepared.outcomes,
        credentials: credentials_result,
        restart_required,
    })
}
