//! Backup restore: parse, decrypt, preview, and stage a restore (PROD-068).
//!
//! Restoring is all-or-nothing across every chosen section:
//!
//! 1. [`prepare`] computes the final content of every chosen store in memory
//!    (validate + migrate the backup data, then merge or replace against the
//!    current store). Any problem aborts before anything is written.
//! 2. [`apply`] writes those files into a **staging** directory, imports the
//!    credentials (one all-or-nothing batch), then **commits** the staging
//!    directory with a single rename. A failure before the commit discards the
//!    staging directory and rolls the credentials back.
//! 3. On the next startup, [`super::pending::apply_pending_restore`] swaps the
//!    committed files into place before any store is loaded, rolling back every
//!    file if one fails.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;
use zeroize::Zeroizing;

pub use super::commit::{apply, PendingManifest, MANIFEST_FILE, PENDING_DIR, STAGING_DIR};
use super::plugins::{self, StagedDir};
use super::sections::{self, CurrentDoc, LegacySecret, NormalizeError, SectionSpec};
use super::{
    BackupContents, BackupCredentialsPreview, BackupFile, BackupHeader, BackupRestorePreview,
    BackupRestoreRequest, BackupSection, BackupSectionPreview, RestoreMode, SectionRestoreOutcome,
    SectionStatus, BACKUP_FORMAT_ID, BACKUP_FORMAT_VERSION, MAX_BACKUP_FILE_BYTES,
    MIN_SUPPORTED_BACKUP_FORMAT_VERSION,
};
use crate::connection::config::ConnectionStore;
use crate::connection::tree::flatten_tree;
use crate::credential::crypto::{
    classify_envelope_version, decrypt_with_password, DecryptError, VersionSupport,
};
use crate::credential::types::CredentialKey;
use crate::credential::vault::{self, OpenedVault, VaultError};
use crate::embedded_servers::config::EmbeddedServerStore;
use crate::embedded_servers::secrets::vault_owners;

fn invalid(message: impl Into<String>) -> VaultError {
    VaultError::InvalidFile {
        message: message.into(),
    }
}

fn other(message: impl Into<String>) -> VaultError {
    VaultError::Other {
        message: message.into(),
    }
}

const NOT_A_BACKUP: &str = "The file is not a termiHub backup.";

fn check_format_version(version: u32) -> Result<(), VaultError> {
    if version > BACKUP_FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion {
            message: format!(
                "This backup was created by a newer version of termiHub (format version \
                 {version}; this build reads up to {BACKUP_FORMAT_VERSION}). Update termiHub to \
                 restore it."
            ),
        });
    }
    if version < MIN_SUPPORTED_BACKUP_FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion {
            message: format!(
                "This backup uses format version {version}, which is no longer supported."
            ),
        });
    }
    Ok(())
}

/// Parse and structurally validate a backup file without decrypting it.
pub fn parse(json: &str) -> Result<BackupFile, VaultError> {
    if json.len() > MAX_BACKUP_FILE_BYTES {
        return Err(invalid("The file is too large to be a termiHub backup."));
    }
    let file: BackupFile = serde_json::from_str(json).map_err(|_| invalid(NOT_A_BACKUP))?;
    if file.format != BACKUP_FORMAT_ID {
        return Err(invalid(NOT_A_BACKUP));
    }
    check_format_version(file.format_version)?;
    match (file.encrypted, &file.envelope, &file.contents) {
        (true, Some(_), None) | (false, None, Some(_)) => Ok(file),
        _ => Err(invalid(
            "The backup file is damaged (inconsistent encryption header).",
        )),
    }
}

/// The cleartext header of a backup.
pub fn header(json: &str) -> Result<BackupHeader, VaultError> {
    let file = parse(json)?;
    let has_credentials = file
        .contents
        .as_ref()
        .is_some_and(|c| c.credentials.is_some());
    Ok(BackupHeader {
        created_at: file.created_at,
        app_version: file.app_version,
        encrypted: file.encrypted,
        needs_passphrase: file.encrypted || has_credentials,
    })
}

/// A decrypted backup held in memory for preview / restore. The credentials
/// are zeroized when this is dropped.
pub struct OpenedBackup {
    pub created_at: String,
    pub app_version: String,
    pub encrypted: bool,
    pub sections: Vec<BackupSection>,
    pub credentials: Option<OpenedVault>,
}

fn wrong_passphrase() -> VaultError {
    VaultError::WrongPassphrase {
        message: "Wrong passphrase, or the backup has been modified or corrupted.".to_string(),
    }
}

fn decrypt_contents(file: &BackupFile, passphrase: &str) -> Result<BackupContents, VaultError> {
    let envelope = file
        .envelope
        .as_ref()
        .ok_or_else(|| invalid(NOT_A_BACKUP))?;
    match classify_envelope_version(envelope.version) {
        VersionSupport::Supported => {}
        VersionSupport::Newer => {
            return Err(VaultError::UnsupportedVersion {
                message: format!(
                    "This backup was encrypted by a newer version of termiHub (envelope version \
                     {}). Update termiHub to restore it.",
                    envelope.version
                ),
            })
        }
        VersionSupport::TooOld => {
            return Err(VaultError::UnsupportedVersion {
                message: format!(
                    "This backup uses envelope version {}, which is no longer supported.",
                    envelope.version
                ),
            })
        }
    }
    let plaintext = Zeroizing::new(decrypt_with_password(passphrase, envelope).map_err(
        |e| match e {
            DecryptError::WrongPassword => wrong_passphrase(),
            DecryptError::Other(inner) => invalid(format!("The backup is damaged: {inner}")),
        },
    )?);
    let contents: BackupContents = serde_json::from_slice(&plaintext)
        .map_err(|_| invalid("The decrypted backup contents are malformed."))?;
    drop(plaintext);
    if contents.format != file.format
        || contents.format_version != file.format_version
        || contents.created_at != file.created_at
    {
        return Err(invalid(
            "The backup header does not match its encrypted contents — the file has been modified.",
        ));
    }
    Ok(contents)
}

/// Parse and open a backup. `passphrase` is required for an encrypted backup
/// and for a backup that carries a credential vault (sealed with the same
/// passphrase). A wrong passphrase or tampered file fails here, before any
/// preview or write.
pub fn open(json: &str, passphrase: Option<&str>) -> Result<OpenedBackup, VaultError> {
    let mut file = parse(json)?;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let contents = if file.encrypted {
        let passphrase = passphrase.ok_or_else(|| VaultError::WrongPassphrase {
            message: "Enter the passphrase this backup was created with.".to_string(),
        })?;
        decrypt_contents(&file, passphrase)?
    } else {
        let contents = file.contents.take().ok_or_else(|| invalid(NOT_A_BACKUP))?;
        if contents.format != file.format || contents.format_version != file.format_version {
            return Err(invalid("The backup file is damaged (header mismatch)."));
        }
        contents
    };

    let mut seen = HashSet::new();
    for section in &contents.sections {
        if !seen.insert(section.id.as_str()) {
            return Err(invalid(format!(
                "The backup lists section \"{}\" more than once.",
                section.id
            )));
        }
    }

    let credentials = match &contents.credentials {
        None => None,
        Some(vault_file) => {
            let passphrase = passphrase.ok_or_else(|| VaultError::WrongPassphrase {
                message: "Enter the passphrase this backup was created with.".to_string(),
            })?;
            Some(
                vault::open_file(vault_file, passphrase).map_err(|e| match e {
                    VaultError::WrongPassphrase { .. } => wrong_passphrase(),
                    other => other,
                })?,
            )
        }
    };

    Ok(OpenedBackup {
        created_at: file.created_at,
        app_version: file.app_version,
        encrypted: file.encrypted,
        sections: contents.sections,
        credentials,
    })
}

/// Map the connection, agent and embedded-server credential owners in the
/// backup's sections to their names, so the credential preview can label
/// credentials whose owner is being restored alongside them.
pub fn backup_owner_names(opened: &OpenedBackup) -> HashMap<String, String> {
    let mut owners = connection_owner_names(opened);
    if let Some(store) = opened
        .sections
        .iter()
        .find(|s| s.id == "embeddedServers")
        .and_then(|section| {
            let doc = sections::spec("embeddedServers")?
                .normalize(section.data.clone())
                .ok()?;
            serde_json::from_value::<EmbeddedServerStore>(doc).ok()
        })
    {
        owners.extend(vault_owners(&store.servers));
    }
    owners
}

fn connection_owner_names(opened: &OpenedBackup) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    let Some(section) = opened.sections.iter().find(|s| s.id == "connections") else {
        return owners;
    };
    let Some(spec) = sections::spec("connections") else {
        return owners;
    };
    let Ok(doc) = spec.normalize(section.data.clone()) else {
        return owners;
    };
    let Ok(store) = serde_json::from_value::<ConnectionStore>(doc) else {
        return owners;
    };
    let (connections, _) = flatten_tree(&store.children, None);
    for c in connections {
        owners.insert(c.id, c.name);
    }
    for a in store.agents {
        owners.insert(a.id, a.name);
    }
    owners
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Preview one section against the current store.
fn preview_section(
    section: &BackupSection,
    config_dir: &Path,
    encrypted: bool,
) -> BackupSectionPreview {
    if section.id == plugins::SECTION_ID {
        return plugins::preview(section, config_dir, encrypted);
    }
    let Some(spec) = sections::spec(&section.id) else {
        return BackupSectionPreview {
            id: section.id.clone(),
            label: section.id.clone(),
            status: SectionStatus::Unknown,
            message: Some(
                "This part of the backup is not known to this version of termiHub and is skipped."
                    .to_string(),
            ),
            schema_version: section.schema_version,
            supported_version: 0,
            supports_merge: false,
            item_count: 0,
            current_count: 0,
            new_count: 0,
            conflict_count: 0,
            unchanged_count: 0,
            conflicts_keep_existing: false,
            notes: Vec::new(),
        };
    };
    let mut preview = BackupSectionPreview {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        status: if section.schema_version < spec.current_version {
            SectionStatus::Migrated
        } else {
            SectionStatus::Ok
        },
        message: None,
        schema_version: section.schema_version,
        supported_version: spec.current_version,
        supports_merge: spec.supports_merge(),
        item_count: 0,
        current_count: 0,
        new_count: 0,
        conflict_count: 0,
        unchanged_count: 0,
        conflicts_keep_existing: spec.conflicts_keep_existing(),
        notes: Vec::new(),
    };
    if spec.integrity_sensitive && !encrypted {
        preview.status = SectionStatus::Invalid;
        preview.message = Some(plugins::needs_encrypted_backup_message(spec.label));
        return preview;
    }
    let legacy = LegacySecret::read(spec, &section.data).len();
    if legacy > 0 {
        preview.notes.push(format!(
            "This backup was made by an older termiHub and keeps {legacy} password(s) in plain \
             text. Restoring moves them into your credential store (unlock it first); with \
             credential storage turned off they are not restored."
        ));
    }
    let backup_doc = match spec.normalize_section(section) {
        Ok(doc) => doc,
        Err(e) => {
            preview.status = match e {
                NormalizeError::Newer { .. } => SectionStatus::Newer,
                NormalizeError::Invalid(_) => SectionStatus::Invalid,
            };
            preview.message = Some(e.message(spec.label));
            return preview;
        }
    };
    let current_doc = match sections::read_current(spec, config_dir) {
        CurrentDoc::Present(doc) => doc,
        CurrentDoc::Missing | CurrentDoc::Unreadable(_) => spec.default_doc(),
        CurrentDoc::Newer { found, supported } => {
            preview.status = SectionStatus::Newer;
            preview.message = Some(current_newer_message(spec, found, supported));
            return preview;
        }
    };
    match sections::compare(spec, &backup_doc, &current_doc) {
        Ok(cmp) => {
            preview.item_count = cmp.item_count;
            preview.current_count = cmp.current_count;
            preview.new_count = cmp.new_count;
            preview.conflict_count = cmp.conflict_count;
            preview.unchanged_count = cmp.unchanged_count;
            if spec.shape == sections::Shape::TrustMap {
                let conflicts = sections::trust_conflicts(&backup_doc, &current_doc);
                if !conflicts.is_empty() {
                    preview.notes.push(format!(
                        "{} already trusted here with a different key: {}. Merge keeps your \
                         current keys for them; only Replace adopts the backup's keys.",
                        if conflicts.len() == 1 {
                            "1 host is".to_string()
                        } else {
                            format!("{} hosts are", conflicts.len())
                        },
                        conflicts.join(", ")
                    ));
                }
            }
        }
        Err(detail) => {
            preview.status = SectionStatus::Invalid;
            preview.message = Some(NormalizeError::Invalid(detail).message(spec.label));
        }
    }
    preview
}

fn current_newer_message(spec: &SectionSpec, found: u32, supported: u32) -> String {
    format!(
        "Your current {} were saved by a newer version of termiHub (schema version {found}; this \
         build supports {supported}), so they cannot be restored over.",
        spec.label.to_lowercase()
    )
}

/// Build the restore preview. Writes nothing. `credentials_preview` produces
/// the credentials part from the decrypted vault (it needs the live store).
pub fn plan(
    opened: &OpenedBackup,
    config_dir: &Path,
    credentials_preview: impl FnOnce(&OpenedVault) -> BackupCredentialsPreview,
) -> BackupRestorePreview {
    let sections = opened
        .sections
        .iter()
        .map(|s| preview_section(s, config_dir, opened.encrypted))
        .collect();
    BackupRestorePreview {
        created_at: opened.created_at.clone(),
        app_version: opened.app_version.clone(),
        encrypted: opened.encrypted,
        sections,
        credentials: opened.credentials.as_ref().map(credentials_preview),
    }
}

/// A plaintext password from an older store schema (see [`LegacySecret`])
/// that a restore moves into the credential store instead of the file.
pub struct PendingSecret {
    pub key: CredentialKey,
    pub value: Zeroizing<String>,
    /// Replace a value the credential store already holds. `false` for a
    /// backup password merged with "keep current" — the store's password for
    /// that item stays.
    pub overwrite: bool,
}

/// The computed content of every chosen store, ready to be staged.
pub struct PreparedRestore {
    /// `(path relative to the config dir, file content)`; content zeroized on
    /// drop.
    pub files: Vec<(String, Zeroizing<String>)>,
    /// Legacy plaintext passwords of the restored items, to be moved into the
    /// credential store (never written to a file).
    pub secrets: Vec<PendingSecret>,
    /// Plugin directories to write or remove.
    pub dirs: Vec<StagedDir>,
    pub outcomes: Vec<SectionRestoreOutcome>,
}

/// The final content of one chosen section.
struct PreparedSection {
    text: Zeroizing<String>,
    resulting_count: u32,
    secrets: Vec<PendingSecret>,
}

/// The legacy plaintext passwords that belong to the items the restored
/// document actually keeps.
///
/// Each password — from the backup or still in the current file — follows its
/// item: it is kept only when the final document's item is the one it came
/// with (an item a merge kept as-is keeps its current password, one it took
/// from the backup gets the backup's). The current file's passwords are
/// migrated alongside, because the restored file is written without any.
fn pending_secrets(
    spec: &SectionSpec,
    final_doc: &Value,
    sources: [(&Value, Vec<LegacySecret>, bool); 2],
) -> Vec<PendingSecret> {
    let items = |doc: &Value| -> HashMap<String, Value> {
        sections::keyed_items(spec, doc)
            .map(|items| items.into_iter().collect())
            .unwrap_or_default()
    };
    let final_items = items(final_doc);
    let mut by_key: Vec<PendingSecret> = Vec::new();
    for (doc, secrets, overwrite) in sources {
        let source_items = items(doc);
        for secret in secrets {
            let kept = matches!(
                (final_items.get(&secret.item_id), source_items.get(&secret.item_id)),
                (Some(a), Some(b)) if a == b
            );
            if !kept {
                continue;
            }
            // A later source (the backup) wins over an earlier one (the current
            // file) only when it may overwrite.
            match by_key.iter_mut().find(|p| p.key == secret.key) {
                Some(existing) if overwrite => {
                    existing.value = secret.value;
                    existing.overwrite = true;
                }
                Some(_) => {}
                None => by_key.push(PendingSecret {
                    key: secret.key,
                    value: secret.value,
                    overwrite,
                }),
            }
        }
    }
    by_key
}

/// Compute the final content of one chosen section.
fn prepare_section(
    spec: &'static SectionSpec,
    section: &BackupSection,
    choice: (RestoreMode, vault::ConflictStrategy),
    config_dir: &Path,
    encrypted: bool,
) -> Result<PreparedSection, VaultError> {
    let (mode, strategy) = choice;
    if spec.integrity_sensitive && !encrypted {
        return Err(other(plugins::needs_encrypted_backup_message(spec.label)));
    }
    // A trust store's merge conflicts always keep the current keys.
    let strategy = if spec.conflicts_keep_existing() {
        vault::ConflictStrategy::Skip
    } else {
        strategy
    };
    let backup_doc = spec.normalize_section(section).map_err(|e| match e {
        NormalizeError::Newer { .. } => VaultError::UnsupportedVersion {
            message: e.message(spec.label),
        },
        NormalizeError::Invalid(_) => invalid(e.message(spec.label)),
    })?;
    let backup_secrets = LegacySecret::read(spec, &section.data);
    let current_secrets = sections::read_current_legacy_secrets(spec, config_dir);
    let current = sections::read_current(spec, config_dir);
    if let CurrentDoc::Newer { found, supported } = current {
        return Err(VaultError::UnsupportedVersion {
            message: current_newer_message(spec, found, supported),
        });
    }

    let current_doc_for_secrets = match &current {
        CurrentDoc::Present(doc) => doc.clone(),
        _ => Value::Null,
    };
    let final_doc = match mode {
        RestoreMode::Replace => {
            let mut doc = backup_doc.clone();
            if spec.shape == sections::Shape::Settings {
                let current_doc = match &current {
                    CurrentDoc::Present(doc) => Some(doc),
                    _ => None,
                };
                sections::preserve_local_settings(&mut doc, current_doc);
            }
            doc
        }
        RestoreMode::Merge => {
            if !spec.supports_merge() {
                return Err(other(format!(
                    "{} can only be replaced, not merged.",
                    spec.label
                )));
            }
            let current_doc = match current {
                CurrentDoc::Present(doc) => doc,
                CurrentDoc::Missing => spec.default_doc(),
                CurrentDoc::Unreadable(detail) => {
                    return Err(other(format!(
                        "Your current {} cannot be read ({detail}), so the backup cannot be \
                         merged into them. Choose Replace instead.",
                        spec.label.to_lowercase()
                    )))
                }
                CurrentDoc::Newer { found, supported } => {
                    return Err(VaultError::UnsupportedVersion {
                        message: current_newer_message(spec, found, supported),
                    })
                }
            };
            sections::merge(spec, current_doc, &backup_doc, strategy)
                .map_err(|e| other(format!("Could not merge {}: {e}", spec.label)))?
        }
    };

    // The result must itself be a store this build loads.
    let final_doc = spec.normalize(final_doc).map_err(|e| {
        other(format!(
            "The restored {} would be invalid: {e:?}",
            spec.label
        ))
    })?;
    let resulting = sections::keyed_items(spec, &final_doc)
        .map(|items| count(items.len()))
        .map_err(|e| other(format!("The restored {} would be invalid: {e}", spec.label)))?;
    let text = serde_json::to_string_pretty(&final_doc)
        .map_err(|e| other(format!("Failed to serialize {}: {e}", spec.label)))?;
    // The current file's passwords never overwrite a stored one ahead of the
    // backup's; the backup's overwrite unless a merge keeps current items.
    let backup_overwrites =
        mode == RestoreMode::Replace || strategy == vault::ConflictStrategy::Overwrite;
    let secrets = pending_secrets(
        spec,
        &final_doc,
        [
            (&current_doc_for_secrets, current_secrets, true),
            (&backup_doc, backup_secrets, backup_overwrites),
        ],
    );
    Ok(PreparedSection {
        text: Zeroizing::new(text),
        resulting_count: resulting,
        secrets,
    })
}

/// Compute every chosen store's final content. Nothing is written.
pub fn prepare(
    opened: &OpenedBackup,
    config_dir: &Path,
    request: &BackupRestoreRequest,
) -> Result<PreparedRestore, VaultError> {
    let mut seen = HashSet::new();
    let mut prepared = PreparedRestore {
        files: Vec::new(),
        secrets: Vec::new(),
        dirs: Vec::new(),
        outcomes: Vec::new(),
    };
    for choice in &request.sections {
        if !seen.insert(choice.id.as_str()) {
            return Err(other(format!(
                "Section \"{}\" was chosen more than once.",
                choice.id
            )));
        }
        if choice.id == plugins::SECTION_ID {
            let section = opened
                .sections
                .iter()
                .find(|s| s.id == choice.id)
                .ok_or_else(|| other(format!("The backup does not contain {}.", plugins::LABEL)))?;
            let staged = plugins::prepare(
                section,
                config_dir,
                opened.encrypted,
                choice.mode,
                choice.conflicts,
            )?;
            prepared.files.extend(staged.files);
            prepared.dirs.extend(staged.dirs);
            prepared.outcomes.push(SectionRestoreOutcome {
                id: plugins::SECTION_ID.to_string(),
                label: plugins::LABEL.to_string(),
                mode: choice.mode,
                resulting_count: staged.resulting_count,
            });
            continue;
        }
        let spec = sections::spec(&choice.id).ok_or_else(|| {
            other(format!(
                "\"{}\" cannot be restored by this version of termiHub.",
                choice.id
            ))
        })?;
        let section = opened
            .sections
            .iter()
            .find(|s| s.id == choice.id)
            .ok_or_else(|| other(format!("The backup does not contain {}.", spec.label)))?;
        let PreparedSection {
            text,
            resulting_count,
            secrets,
        } = prepare_section(
            spec,
            section,
            (choice.mode, choice.conflicts),
            config_dir,
            opened.encrypted,
        )?;
        prepared.files.push((spec.file_name.to_string(), text));
        prepared.secrets.extend(secrets);
        prepared.outcomes.push(SectionRestoreOutcome {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            mode: choice.mode,
            resulting_count,
        });
    }
    if request.credentials.is_some() && opened.credentials.is_none() {
        return Err(other("The backup does not contain credentials."));
    }
    if prepared.files.is_empty() && prepared.dirs.is_empty() && request.credentials.is_none() {
        return Err(other("Choose at least one thing to restore."));
    }
    Ok(prepared)
}
