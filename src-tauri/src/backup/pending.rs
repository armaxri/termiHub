//! Startup half of a backup restore (PROD-068): swap a committed, staged
//! restore into the config directory **before any store is loaded**, rolling
//! every file back if one fails.
//!
//! Crash safety: the originals are copied into a rollback directory and its
//! manifest is written *before* the first store file is replaced. If the app
//! dies mid-swap, the next start finds the rollback manifest, keeps the
//! original snapshot, and simply redoes the (idempotent) swap.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use super::restore::{PendingManifest, MANIFEST_FILE, PENDING_DIR, STAGING_DIR};
use super::sections;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::fs::write_atomic;

/// Snapshot of the originals, taken before the swap.
pub const ROLLBACK_DIR: &str = ".backup-restore-rollback";
const ROLLBACK_MANIFEST: &str = "rollback.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackEntry {
    file: String,
    /// Whether the store file existed before the restore.
    existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackManifest {
    entries: Vec<RollbackEntry>,
}

fn remove_dir(path: &Path) {
    if path.exists() {
        if let Err(e) = std::fs::remove_dir_all(path) {
            warn!(dir = %path.display(), "Could not remove backup-restore directory: {e}");
        }
    }
}

fn failure_warning(details: String) -> RecoveryWarning {
    RecoveryWarning {
        file_name: "backup restore".to_string(),
        message: "Restoring the backup failed. Your previous data was kept unchanged.".to_string(),
        details: Some(details),
    }
}

/// Read and validate the pending manifest: only known store files, each
/// staged and listed once.
fn read_manifest(pending: &Path) -> Result<PendingManifest, String> {
    let text = std::fs::read_to_string(pending.join(MANIFEST_FILE))
        .map_err(|e| format!("could not read the restore manifest: {e}"))?;
    let manifest: PendingManifest = serde_json::from_str(&text)
        .map_err(|e| format!("the restore manifest is malformed: {e}"))?;
    if manifest.format_version != 1 {
        return Err(format!(
            "unsupported restore manifest version {}",
            manifest.format_version
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for file in &manifest.files {
        if sections::spec_for_file(file).is_none() {
            return Err(format!(
                "the restore manifest names an unknown file \"{file}\""
            ));
        }
        if !seen.insert(file.as_str()) {
            return Err(format!("the restore manifest lists \"{file}\" twice"));
        }
        if !pending.join(file).is_file() {
            return Err(format!("the staged file \"{file}\" is missing"));
        }
    }
    Ok(manifest)
}

/// Load the rollback snapshot of an interrupted earlier attempt, or take a new
/// one of the current originals.
fn snapshot(
    config_dir: &Path,
    rollback: &Path,
    manifest: &PendingManifest,
) -> Result<RollbackManifest, String> {
    let manifest_path = rollback.join(ROLLBACK_MANIFEST);
    if let Ok(text) = std::fs::read_to_string(&manifest_path) {
        if let Ok(existing) = serde_json::from_str::<RollbackManifest>(&text) {
            info!("Resuming an interrupted backup restore");
            return Ok(existing);
        }
    }
    // No (complete) snapshot yet: nothing has been swapped, start over.
    remove_dir(rollback);
    std::fs::create_dir_all(rollback)
        .map_err(|e| format!("could not create the rollback directory: {e}"))?;
    let mut entries = Vec::new();
    for file in &manifest.files {
        let target = config_dir.join(file);
        let existed = target.is_file();
        if existed {
            std::fs::copy(&target, rollback.join(file))
                .map_err(|e| format!("could not back up {file} before restoring: {e}"))?;
        }
        entries.push(RollbackEntry {
            file: file.clone(),
            existed,
        });
    }
    let snapshot = RollbackManifest { entries };
    let text = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| format!("could not write the rollback manifest: {e}"))?;
    write_atomic(&manifest_path, &text)
        .map_err(|e| format!("could not write the rollback manifest: {e:#}"))?;
    Ok(snapshot)
}

/// Put every original back. Returns the files that could not be restored.
fn roll_back(config_dir: &Path, rollback: &Path, snapshot: &RollbackManifest) -> Vec<String> {
    let mut failed = Vec::new();
    for entry in &snapshot.entries {
        let target = config_dir.join(&entry.file);
        let outcome = if entry.existed {
            std::fs::read_to_string(rollback.join(&entry.file))
                .map_err(anyhow::Error::from)
                .and_then(|text| write_atomic(&target, &text))
        } else if target.is_file() {
            std::fs::remove_file(&target).map_err(anyhow::Error::from)
        } else {
            Ok(())
        };
        if let Err(e) = outcome {
            error!(file = %entry.file, "Could not roll back a restored file: {e:#}");
            failed.push(entry.file.clone());
        }
    }
    failed
}

/// Apply a committed restore, if one is pending. Must run before any store in
/// `config_dir` is loaded. Returns a warning to surface when the restore
/// failed (and was rolled back).
pub fn apply_pending_restore(config_dir: &Path) -> Option<RecoveryWarning> {
    // An uncommitted staging directory is an abandoned restore attempt.
    remove_dir(&config_dir.join(STAGING_DIR));

    let pending = config_dir.join(PENDING_DIR);
    let rollback = config_dir.join(ROLLBACK_DIR);
    if !pending.is_dir() {
        remove_dir(&rollback);
        return None;
    }

    let manifest = match read_manifest(&pending) {
        Ok(m) => m,
        Err(e) => {
            error!("Discarding an invalid pending backup restore: {e}");
            remove_dir(&pending);
            remove_dir(&rollback);
            return Some(failure_warning(e));
        }
    };

    let snapshot = match snapshot(config_dir, &rollback, &manifest) {
        Ok(s) => s,
        Err(e) => {
            error!("Could not prepare the backup restore: {e}");
            remove_dir(&pending);
            remove_dir(&rollback);
            return Some(failure_warning(e));
        }
    };

    for file in &manifest.files {
        let outcome = std::fs::read_to_string(pending.join(file))
            .map_err(anyhow::Error::from)
            .and_then(|text| write_atomic(&config_dir.join(file), &text));
        if let Err(e) = outcome {
            error!(file = %file, "Restoring a backed-up store failed; rolling back: {e:#}");
            let failed = roll_back(config_dir, &rollback, &snapshot);
            let mut details = format!("Could not write {file}: {e:#}");
            if failed.is_empty() {
                remove_dir(&rollback);
            } else {
                // Keep the snapshot so the originals are not lost.
                details.push_str(&format!(
                    ". Some files could not be rolled back ({}); their originals are kept in {}.",
                    failed.join(", "),
                    rollback.display()
                ));
            }
            remove_dir(&pending);
            return Some(failure_warning(details));
        }
    }

    remove_dir(&pending);
    remove_dir(&rollback);
    info!(files = ?manifest.files, "Backup restore applied");
    None
}
