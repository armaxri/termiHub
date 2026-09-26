//! Startup half of a backup restore (PROD-068): swap a committed, staged
//! restore into the config directory **before any store is loaded**, rolling
//! every file back if one fails.
//!
//! Crash safety: the originals are copied into a rollback directory and its
//! manifest is written *before* the first store file is replaced. If the app
//! dies mid-swap, the next start finds the rollback manifest, keeps the
//! original snapshot, and simply redoes the (idempotent) swap.
//!
//! Plugin directories (#3515) are swapped by **renames**, not copies: the
//! rollback manifest records whether each directory existed, then the swap
//! moves the original into the rollback directory and the staged copy into
//! place. Every step is idempotent, so a resumed swap and a rollback can tell
//! the original from the restored copy by where the original now lives.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use super::commit::{MANIFEST_FORMAT_FILES_ONLY, MANIFEST_FORMAT_WITH_PLUGINS};
use super::restore::{PendingManifest, MANIFEST_FILE, PENDING_DIR, STAGING_DIR};
use super::{plugins, sections};
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
    /// Plugin directories (`file` is the directory path).
    #[serde(default)]
    dirs: Vec<RollbackEntry>,
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
    let with_plugins = match manifest.format_version {
        MANIFEST_FORMAT_FILES_ONLY => false,
        MANIFEST_FORMAT_WITH_PLUGINS => true,
        other => return Err(format!("unsupported restore manifest version {other}")),
    };
    if !with_plugins && !manifest.dirs.is_empty() {
        return Err("the restore manifest lists directories it cannot contain".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for file in &manifest.files {
        let known = sections::spec_for_file(file).is_some()
            || (with_plugins && plugins::is_restorable_root_file(file));
        if !known {
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
    for dir in &manifest.dirs {
        if !plugins::is_restorable_plugin_dir(dir) {
            return Err(format!(
                "the restore manifest names an unknown directory \"{dir}\""
            ));
        }
        if !seen.insert(dir.as_str()) {
            return Err(format!("the restore manifest lists \"{dir}\" twice"));
        }
        // A staged directory, when present, must be a real directory.
        if let Ok(meta) = std::fs::symlink_metadata(pending.join(dir)) {
            if !meta.is_dir() {
                return Err(format!("the staged directory \"{dir}\" is not a directory"));
            }
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
            let saved = rollback.join(file);
            if let Some(parent) = saved.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not back up {file} before restoring: {e}"))?;
            }
            std::fs::copy(&target, saved)
                .map_err(|e| format!("could not back up {file} before restoring: {e}"))?;
        }
        entries.push(RollbackEntry {
            file: file.clone(),
            existed,
        });
    }
    // Directories are moved (not copied) during the swap; only record here
    // whether each existed.
    let dirs = manifest
        .dirs
        .iter()
        .map(|dir| RollbackEntry {
            file: dir.clone(),
            existed: config_dir.join(dir).is_dir(),
        })
        .collect();
    let snapshot = RollbackManifest { entries, dirs };
    let text = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| format!("could not write the rollback manifest: {e}"))?;
    write_atomic(&manifest_path, &text)
        .map_err(|e| format!("could not write the rollback manifest: {e:#}"))?;
    Ok(snapshot)
}

/// Swap one plugin directory into place (or remove it when nothing is
/// staged), moving the original into the rollback directory. Idempotent.
fn swap_dir(
    config_dir: &Path,
    pending: &Path,
    rollback: &Path,
    entry: &RollbackEntry,
) -> std::io::Result<()> {
    let target = config_dir.join(&entry.file);
    let saved = rollback.join(&entry.file);
    let staged = pending.join(&entry.file);
    if entry.existed && !saved.exists() && target.exists() {
        if let Some(parent) = saved.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&target, &saved)?;
    }
    if staged.exists() {
        // Anything at the target now is not the original (it was moved away
        // above, or never existed): a leftover of an interrupted attempt.
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&staged, &target)?;
    } else if !entry.existed && target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    Ok(())
}

/// Put one plugin directory back the way it was.
fn roll_back_dir(config_dir: &Path, rollback: &Path, entry: &RollbackEntry) -> std::io::Result<()> {
    let target = config_dir.join(&entry.file);
    let saved = rollback.join(&entry.file);
    if entry.existed {
        // When the original was never moved away it is still in place.
        if saved.exists() {
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            std::fs::rename(&saved, &target)?;
        }
    } else if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    Ok(())
}

/// Put every original back. Returns the files that could not be restored.
fn roll_back(config_dir: &Path, rollback: &Path, snapshot: &RollbackManifest) -> Vec<String> {
    let mut failed = Vec::new();
    for entry in &snapshot.dirs {
        if let Err(e) = roll_back_dir(config_dir, rollback, entry) {
            error!(dir = %entry.file, "Could not roll back a restored plugin directory: {e}");
            failed.push(entry.file.clone());
        }
    }
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

    let dir_outcomes = snapshot.dirs.iter().map(|entry| {
        (
            entry.file.clone(),
            swap_dir(config_dir, &pending, &rollback, entry).map_err(anyhow::Error::from),
        )
    });
    let file_outcomes = manifest.files.iter().map(|file| {
        let target = config_dir.join(file);
        let outcome = std::fs::read_to_string(pending.join(file))
            .map_err(anyhow::Error::from)
            .and_then(|text| {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                write_atomic(&target, &text)
            });
        (file.clone(), outcome)
    });
    // Directories first, so a failing file still rolls every directory back.
    for (file, outcome) in dir_outcomes.chain(file_outcomes) {
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
    info!(files = ?manifest.files, dirs = ?manifest.dirs, "Backup restore applied");
    None
}
