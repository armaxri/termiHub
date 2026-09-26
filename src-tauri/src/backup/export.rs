//! Backup export: read every chosen store, assemble the container, and seal it
//! (PROD-068).

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;
use zeroize::Zeroizing;

use super::sections::{self, keyed_items, CurrentDoc, SectionSpec, Shape, SECTIONS};
use super::{
    BackupContents, BackupExportOptions, BackupFile, BackupSection, BackupSectionInfo,
    BACKUP_FORMAT_ID, BACKUP_FORMAT_VERSION,
};
use crate::credential::crypto::encrypt_with_password;
use crate::credential::vault::{self, VaultError, VaultExportFile};
use crate::credential::CredentialManager;
use crate::utils::migrate::read_version;

fn other(message: impl Into<String>) -> VaultError {
    VaultError::Other {
        message: message.into(),
    }
}

/// Describe every section for the export dialog: whether its store exists on
/// this machine and how many items it holds.
pub fn section_infos(config_dir: &Path) -> Vec<BackupSectionInfo> {
    SECTIONS
        .iter()
        .map(|spec| {
            let (present, item_count) = match sections::read_current(spec, config_dir) {
                CurrentDoc::Missing => (false, 0),
                CurrentDoc::Present(doc) => (
                    true,
                    keyed_items(spec, &doc)
                        .map(|items| u32::try_from(items.len()).unwrap_or(u32::MAX))
                        .unwrap_or(0),
                ),
                CurrentDoc::Unreadable(_) | CurrentDoc::Newer { .. } => (true, 0),
            };
            BackupSectionInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                description: spec.description.to_string(),
                contains_secrets: spec.contains_secrets,
                present,
                item_count,
            }
        })
        .collect()
}

/// Read one store file for a backup. `Ok(None)` when the store does not exist
/// yet (nothing to back up).
///
/// The document is taken verbatim (not re-serialized) so the backup preserves
/// exactly what the store wrote, and stamped with the store's schema version.
fn read_section(
    spec: &SectionSpec,
    config_dir: &Path,
) -> Result<Option<BackupSection>, VaultError> {
    let path = config_dir.join(spec.file_name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => Zeroizing::new(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(other(format!(
                "Could not read {} ({}): {e}",
                spec.label, spec.file_name
            )))
        }
    };
    let data: Value = serde_json::from_str(&raw).map_err(|e| {
        other(format!(
            "{} ({}) is not valid JSON and cannot be backed up: {e}",
            spec.label, spec.file_name
        ))
    })?;
    let mut data = data;
    if read_version(&data).unwrap_or(1) < spec.current_version {
        // The file predates this build's schema (the store has not re-saved it
        // since an upgrade). Back it up already migrated through the store's own
        // forward migration, so a backup made by this build restores on this
        // build as current rather than as "migrated". A file the store cannot
        // read is kept verbatim and reported on restore instead.
        if let Ok(migrated) = spec.normalize(data.clone()) {
            data = migrated;
        }
    }
    if spec.shape == Shape::Connections {
        sections::strip_connection_passwords(&mut data);
    }
    // A file with no version field predates versioning and is schema v1.
    let schema_version = read_version(&data).unwrap_or(1);
    Ok(Some(BackupSection {
        id: spec.id.to_string(),
        schema_version,
        data,
    }))
}

/// Validate the requested section ids and resolve them to specs.
fn resolve_sections(
    options: &BackupExportOptions,
) -> Result<Vec<&'static SectionSpec>, VaultError> {
    let mut seen = HashSet::new();
    let mut specs = Vec::new();
    for id in &options.sections {
        let spec =
            sections::spec(id).ok_or_else(|| other(format!("Unknown backup section \"{id}\".")))?;
        if !seen.insert(spec.id) {
            return Err(other(format!(
                "Backup section \"{id}\" was requested twice."
            )));
        }
        if spec.contains_secrets && !options.encrypt {
            return Err(VaultError::WeakPassphrase {
                message: format!(
                    "{} contains passwords and can only be backed up with encryption turned on.",
                    spec.label
                ),
            });
        }
        specs.push(spec);
    }
    if specs.is_empty() && !options.include_credentials {
        return Err(other("Choose at least one thing to back up."));
    }
    Ok(specs)
}

/// Build the backup file text.
///
/// `passphrase` is required when `options.encrypt` is set or `credentials` is
/// given (the vault in `credentials` must already be sealed with the same
/// passphrase). Returns the JSON text and the ids of the sections written.
pub fn build(
    config_dir: &Path,
    options: &BackupExportOptions,
    passphrase: Option<&str>,
    credentials: Option<VaultExportFile>,
    created_at: String,
    app_version: String,
) -> Result<(String, Vec<String>), VaultError> {
    let specs = resolve_sections(options)?;
    if options.include_credentials != credentials.is_some() {
        return Err(other("The credential vault section is missing."));
    }
    if (options.encrypt || credentials.is_some()) && passphrase.is_none_or(str::is_empty) {
        return Err(VaultError::WeakPassphrase {
            message: "Enter a passphrase to protect the backup.".to_string(),
        });
    }

    let mut written = Vec::new();
    let mut backup_sections = Vec::new();
    for spec in specs {
        if let Some(section) = read_section(spec, config_dir)? {
            written.push(spec.id.to_string());
            backup_sections.push(section);
        }
    }

    let contents = BackupContents {
        format: BACKUP_FORMAT_ID.to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: created_at.clone(),
        sections: backup_sections,
        credentials,
    };

    let file = if options.encrypt {
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&contents)
                .map_err(|e| other(format!("Failed to serialize the backup: {e}")))?,
        );
        drop(contents);
        let passphrase = passphrase.unwrap_or_default();
        let envelope = encrypt_with_password(passphrase, &plaintext)
            .map_err(|e| other(format!("Failed to encrypt the backup: {e}")))?;
        BackupFile {
            format: BACKUP_FORMAT_ID.to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            created_at,
            app_version,
            encrypted: true,
            envelope: Some(envelope),
            contents: None,
        }
    } else {
        BackupFile {
            format: BACKUP_FORMAT_ID.to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            created_at,
            app_version,
            encrypted: false,
            envelope: None,
            contents: Some(contents),
        }
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| other(format!("Failed to serialize the backup: {e}")))?;
    Ok((json, written))
}

/// Collect and seal every saved credential for the backup's credentials
/// section, sealed with the backup `passphrase`.
///
/// Applies the same gate as a standalone vault export (PROD-063): the store
/// must re-authenticate (`master_password` in master-password mode), and the
/// OS keychain is refused until system authentication exists (#3433) — the
/// caller can still back up everything else. Returns the sealed vault and the
/// number of credentials in it.
pub fn seal_credentials(
    manager: &CredentialManager,
    master_password: Option<&str>,
    passphrase: &str,
    owner_ids: &[String],
    created_at: String,
) -> Result<(VaultExportFile, u32), VaultError> {
    vault::authorize_export(manager, master_password)?;
    let entries = vault::collect_entries(manager, owner_ids)?;
    let count = u32::try_from(entries.len()).unwrap_or(u32::MAX);
    Ok((vault::seal(&entries, passphrase, created_at)?, count))
}
