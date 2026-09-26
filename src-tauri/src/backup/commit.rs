//! Committing a prepared restore (PROD-068): stage the chosen store files,
//! import the credentials as one batch, then commit with a single directory
//! rename. Any failure before the commit discards the staging directory and
//! puts the credentials back. The committed files are swapped into place on
//! the next start by [`super::pending::apply_pending_restore`].

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use zeroize::Zeroizing;

use super::restore::{prepare, OpenedBackup, PreparedRestore};
use super::{BackupRestoreRequest, BackupRestoreResult};
use crate::credential::types::CredentialKey;
use crate::credential::vault::{self, OpenedVault, VaultError};
use crate::credential::CredentialStore;
use crate::utils::fs::write_atomic;

/// Staging directory for a restore that is being written (not yet committed).
pub const STAGING_DIR: &str = ".backup-restore-staging";
/// Directory of a committed restore, applied on the next startup.
pub const PENDING_DIR: &str = ".backup-restore-pending";
/// Manifest listing the staged store files. Written last during staging.
pub const MANIFEST_FILE: &str = "manifest.json";

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
    fn take(vault: &OpenedVault, store: &dyn CredentialStore) -> Result<Self, VaultError> {
        vault
            .entries
            .iter()
            .map(|(key, _)| {
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

/// Apply a restore: stage the chosen stores, import the credentials, then
/// commit. All-or-nothing: on any failure nothing is committed and the
/// credential store is rolled back.
///
/// `store` must be the (already authorized) credential store when
/// `request.credentials` is set.
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

    let mut credentials_result = None;
    let mut snapshot = None;
    if let (Some(strategy), Some(vault)) = (request.credentials, opened.credentials.as_ref()) {
        let outcome = (|| {
            let store = store.ok_or_else(|| VaultError::StoreUnavailable {
                message: "There is no credential store to restore the credentials into."
                    .to_string(),
            })?;
            let snap = CredentialSnapshot::take(vault, store)?;
            let result = vault::apply_import(vault, store, strategy)?;
            Ok::<_, VaultError>((snap, result))
        })();
        match outcome {
            Ok((snap, result)) => {
                snapshot = Some(snap);
                credentials_result = Some(result);
            }
            Err(e) => {
                if let Some(staged) = staged {
                    staged.discard();
                }
                return Err(e);
            }
        }
    }

    let restart_required = staged.is_some();
    if let Some(staged) = staged {
        if let Err(e) = staged.commit() {
            if let (Some(snapshot), Some(store)) = (&snapshot, store) {
                snapshot.restore(store);
            }
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
