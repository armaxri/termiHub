//! Validating, previewing and preparing a plugins-section restore (#3515).
//! See the parent module for what is restored and the trust rules.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use base64::Engine;
use serde_json::{Map, Value};
use termihub_core::plugin::{
    is_valid_plugin_id, key_id_from_public_key, parse_manifest, MANIFEST_FILE_NAME,
};
use zeroize::Zeroizing;

use super::{
    dir_digest, files_digest, installed_ids, is_safe_relative_path, mib,
    needs_encrypted_backup_message, other, plugins_map, publishers_list, read_root_json,
    PluginPackage, PluginsDoc, ValidatedPackage, ValidatedPlugins, BASE64, LABEL,
    MAX_PLUGINS_BACKUP_TOTAL_BYTES, MAX_PLUGIN_BACKUP_BYTES, MAX_PLUGIN_FILES, PLUGINS_DIR,
    PUBLISHERS_FILE, SCHEMA_VERSION, SECTION_ID, SETTINGS_FILE, STATE_FILE,
};
use crate::backup::sections::{Comparison, NormalizeError};
use crate::backup::{BackupSection, BackupSectionPreview, RestoreMode, SectionStatus};
use crate::credential::vault::{ConflictStrategy, VaultError};
use crate::utils::migrate::read_version;

/// Validate a pinned-publisher entry: an object whose `keyId` is the digest
/// of its 32-byte `publicKey`.
fn validate_publisher(entry: &Value) -> Result<(), String> {
    let key_id = entry
        .get("keyId")
        .and_then(Value::as_str)
        .ok_or("a trusted publisher has no keyId")?;
    let public_key = entry
        .get("publicKey")
        .and_then(Value::as_str)
        .ok_or("a trusted publisher has no publicKey")?;
    let bytes = BASE64
        .decode(public_key)
        .map_err(|_| format!("publisher {key_id} has a malformed public key"))?;
    if bytes.len() != 32 || key_id_from_public_key(&bytes) != key_id {
        return Err(format!("publisher {key_id} does not match its public key"));
    }
    if entry.get("label").and_then(Value::as_str).is_none() {
        return Err(format!("publisher {key_id} has no label"));
    }
    Ok(())
}

/// Validate and decode one plugin package.
fn validate_package(pkg: &PluginPackage, total: &mut u64) -> Result<ValidatedPackage, String> {
    let id = &pkg.id;
    if !is_valid_plugin_id(id) {
        return Err(format!("\"{id}\" is not a valid plugin id"));
    }
    if pkg.files.len() > MAX_PLUGIN_FILES {
        return Err(format!("plugin {id} has too many files"));
    }
    let mut seen = BTreeSet::new();
    let mut files = Vec::with_capacity(pkg.files.len());
    let mut size = 0u64;
    for f in &pkg.files {
        if !is_safe_relative_path(&f.path) {
            return Err(format!(
                "plugin {id} has an unsafe file path \"{}\"",
                f.path
            ));
        }
        if !seen.insert(f.path.as_str()) {
            return Err(format!("plugin {id} lists \"{}\" twice", f.path));
        }
        let bytes = BASE64
            .decode(&f.data)
            .map_err(|_| format!("plugin {id} file \"{}\" is damaged", f.path))?;
        size = size.saturating_add(bytes.len() as u64);
        files.push((f.path.clone(), bytes));
    }
    if size > MAX_PLUGIN_BACKUP_BYTES {
        return Err(format!(
            "plugin {id} is larger than {}",
            mib(MAX_PLUGIN_BACKUP_BYTES)
        ));
    }
    *total = total.saturating_add(size);
    if *total > MAX_PLUGINS_BACKUP_TOTAL_BYTES {
        return Err(format!(
            "the plugins are larger than {}",
            mib(MAX_PLUGINS_BACKUP_TOTAL_BYTES)
        ));
    }
    let manifest_bytes = files
        .iter()
        .find(|(p, _)| p == MANIFEST_FILE_NAME)
        .map(|(_, b)| b)
        .ok_or_else(|| format!("plugin {id} has no {MANIFEST_FILE_NAME}"))?;
    let manifest_text = std::str::from_utf8(manifest_bytes)
        .map_err(|_| format!("the manifest of plugin {id} is not text"))?;
    let manifest = parse_manifest(manifest_text)
        .map_err(|e| format!("the manifest of plugin {id} is invalid: {e}"))?;
    if &manifest.id != id {
        return Err(format!(
            "the manifest of plugin {id} names a different plugin ({})",
            manifest.id
        ));
    }
    let digest = files_digest(files.iter().map(|(p, b)| (p.as_str(), b.as_slice())));
    Ok(ValidatedPackage {
        id: id.clone(),
        version: manifest.version,
        native: manifest.extensions.terminal_backend.is_some(),
        files,
        digest,
    })
}

/// Validate and decode a plugins section. The section's own schema version is
/// checked by the caller; this refuses a newer in-document version too.
pub fn normalize(section: &BackupSection) -> Result<ValidatedPlugins, NormalizeError> {
    if section.schema_version > SCHEMA_VERSION {
        return Err(NormalizeError::Newer {
            found: section.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    if let Some(found) = read_version(&section.data) {
        if found > SCHEMA_VERSION {
            return Err(NormalizeError::Newer {
                found,
                supported: SCHEMA_VERSION,
            });
        }
    }
    let doc: PluginsDoc = serde_json::from_value(section.data.clone())
        .map_err(|e| NormalizeError::Invalid(e.to_string()))?;
    let mut ids = BTreeSet::new();
    let mut total = 0u64;
    let mut packages = Vec::with_capacity(doc.packages.len());
    for pkg in &doc.packages {
        if !ids.insert(pkg.id.clone()) {
            return Err(NormalizeError::Invalid(format!(
                "plugin {} is listed twice",
                pkg.id
            )));
        }
        packages.push(validate_package(pkg, &mut total).map_err(NormalizeError::Invalid)?);
    }
    // Records for plugins the backup does not carry are dropped.
    let mut state = Map::new();
    for (id, record) in doc.state {
        if !ids.contains(&id) {
            continue;
        }
        if record.get("enabled").and_then(Value::as_bool).is_none() {
            return Err(NormalizeError::Invalid(format!(
                "the state of plugin {id} is malformed"
            )));
        }
        state.insert(id, record);
    }
    let mut settings = Map::new();
    for (id, value) in doc.settings {
        if !ids.contains(&id) {
            continue;
        }
        if !value.is_object() {
            return Err(NormalizeError::Invalid(format!(
                "the settings of plugin {id} are malformed"
            )));
        }
        settings.insert(id, value);
    }
    for publisher in &doc.publishers {
        validate_publisher(publisher).map_err(NormalizeError::Invalid)?;
    }
    Ok(ValidatedPlugins {
        packages,
        state,
        settings,
        publishers: doc.publishers,
    })
}

/// The plugins currently installed here, for comparison.
struct Current {
    /// id → content digest (`None` when unreadable).
    digests: BTreeMap<String, Option<String>>,
    state: Map<String, Value>,
    settings: Map<String, Value>,
    publishers: Vec<Value>,
}

fn read_current(root: &Path) -> Result<Current, String> {
    let digests = installed_ids(root)
        .into_iter()
        .map(|id| {
            let digest = dir_digest(&root.join(&id)).ok();
            (id, digest)
        })
        .collect();
    Ok(Current {
        digests,
        state: plugins_map(read_root_json(root, STATE_FILE)?),
        settings: plugins_map(read_root_json(root, SETTINGS_FILE)?),
        publishers: publishers_list(read_root_json(root, PUBLISHERS_FILE)?),
    })
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn compare(backup: &ValidatedPlugins, current: &Current) -> Comparison {
    let mut cmp = Comparison {
        item_count: count(backup.packages.len()),
        current_count: count(current.digests.len()),
        ..Comparison::default()
    };
    for pkg in &backup.packages {
        match current.digests.get(&pkg.id) {
            None => cmp.new_count += 1,
            Some(Some(digest))
                if *digest == pkg.digest
                    && current.settings.get(&pkg.id) == backup.settings.get(&pkg.id) =>
            {
                cmp.unchanged_count += 1
            }
            Some(_) => cmp.conflict_count += 1,
        }
    }
    cmp
}

fn restore_notes(backup: &ValidatedPlugins) -> Vec<String> {
    let mut notes = Vec::new();
    let native: Vec<&str> = backup
        .packages
        .iter()
        .filter(|p| p.native)
        .map(|p| p.id.as_str())
        .collect();
    if !native.is_empty() {
        notes.push(format!(
            "Native plugins come back turned off ({}). Turn each on again and confirm that \
             you trust it on this computer.",
            native.join(", ")
        ));
    }
    if !backup.publishers.is_empty() {
        notes.push(format!(
            "{} trusted publisher key{} will be restored.",
            backup.publishers.len(),
            if backup.publishers.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    notes
}

/// A preview row for a section that cannot be restored.
fn refused(
    section: &BackupSection,
    status: SectionStatus,
    message: String,
) -> BackupSectionPreview {
    BackupSectionPreview {
        id: SECTION_ID.to_string(),
        label: LABEL.to_string(),
        status,
        message: Some(message),
        schema_version: section.schema_version,
        supported_version: SCHEMA_VERSION,
        supports_merge: true,
        item_count: 0,
        current_count: 0,
        new_count: 0,
        conflict_count: 0,
        unchanged_count: 0,
        conflicts_keep_existing: false,
        notes: Vec::new(),
    }
}

/// Preview the plugins section against what is installed here.
pub fn preview(
    section: &BackupSection,
    config_dir: &Path,
    encrypted: bool,
) -> BackupSectionPreview {
    if !encrypted {
        return refused(
            section,
            SectionStatus::Invalid,
            needs_encrypted_backup_message(LABEL),
        );
    }
    let backup = match normalize(section) {
        Ok(b) => b,
        Err(e) => {
            let status = match e {
                NormalizeError::Newer { .. } => SectionStatus::Newer,
                NormalizeError::Invalid(_) => SectionStatus::Invalid,
            };
            return refused(section, status, e.message(LABEL));
        }
    };
    let current = match read_current(&config_dir.join(PLUGINS_DIR)) {
        Ok(c) => c,
        Err(detail) => {
            return refused(
                section,
                SectionStatus::Invalid,
                format!("Your current plugin data cannot be read ({detail})."),
            )
        }
    };
    let cmp = compare(&backup, &current);
    BackupSectionPreview {
        id: SECTION_ID.to_string(),
        label: LABEL.to_string(),
        status: SectionStatus::Ok,
        message: None,
        schema_version: section.schema_version,
        supported_version: SCHEMA_VERSION,
        supports_merge: true,
        item_count: cmp.item_count,
        current_count: cmp.current_count,
        new_count: cmp.new_count,
        conflict_count: cmp.conflict_count,
        unchanged_count: cmp.unchanged_count,
        conflicts_keep_existing: false,
        notes: restore_notes(&backup),
    }
}

/// A plugin directory change a restore stages: the directory's final files,
/// or `None` to remove it.
pub struct StagedDir {
    /// Relative to the config dir: `plugins/<id>`.
    pub rel: String,
    pub files: Option<Vec<(String, Vec<u8>)>>,
}

/// The staged result of restoring the plugins section.
pub struct PreparedPlugins {
    /// `(path relative to the config dir, content)` for the plugin-root files.
    pub files: Vec<(String, Zeroizing<String>)>,
    pub dirs: Vec<StagedDir>,
    /// Plugins installed after the restore.
    pub resulting_count: u32,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn root_file(file: &str, doc: &Value) -> Result<(String, Zeroizing<String>), VaultError> {
    let text = serde_json::to_string_pretty(doc)
        .map_err(|e| other(format!("Failed to serialize {file}: {e}")))?;
    Ok((format!("{PLUGINS_DIR}/{file}"), Zeroizing::new(text)))
}

/// Compute the plugins restore: which plugin directories to write or remove
/// and the final state, settings and publisher files. Nothing is written.
pub fn prepare(
    section: &BackupSection,
    config_dir: &Path,
    encrypted: bool,
    mode: RestoreMode,
    strategy: ConflictStrategy,
) -> Result<PreparedPlugins, VaultError> {
    if !encrypted {
        return Err(other(needs_encrypted_backup_message(LABEL)));
    }
    let backup = normalize(section).map_err(|e| match e {
        NormalizeError::Newer { .. } => VaultError::UnsupportedVersion {
            message: e.message(LABEL),
        },
        NormalizeError::Invalid(_) => VaultError::InvalidFile {
            message: e.message(LABEL),
        },
    })?;
    let root = config_dir.join(PLUGINS_DIR);
    let current = read_current(&root).map_err(|detail| {
        other(format!(
            "Your current plugin data cannot be read ({detail}), so the backup cannot be \
             restored over it."
        ))
    })?;

    let backup_ids: BTreeSet<String> = backup.packages.iter().map(|p| p.id.clone()).collect();
    let (mut state, mut settings, mut publishers) = match mode {
        RestoreMode::Replace => (Map::new(), Map::new(), Vec::new()),
        RestoreMode::Merge => (
            current.state.clone(),
            current.settings.clone(),
            current.publishers.clone(),
        ),
    };
    let mut dirs = Vec::new();

    // Replace removes every installed plugin the backup does not carry.
    if mode == RestoreMode::Replace {
        for id in current.digests.keys() {
            if !backup_ids.contains(id) {
                dirs.push(StagedDir {
                    rel: format!("{PLUGINS_DIR}/{id}"),
                    files: None,
                });
            }
        }
    }

    for pkg in backup.packages {
        let installed = current.digests.contains_key(&pkg.id);
        let take =
            mode == RestoreMode::Replace || !installed || strategy == ConflictStrategy::Overwrite;
        if !take {
            continue;
        }
        // The state record (with its signer record) is restored as-is, except
        // that a native plugin always comes back turned off: it must be turned
        // on and trusted again on this machine.
        let mut record =
            backup.state.get(&pkg.id).cloned().unwrap_or_else(
                || serde_json::json!({ "enabled": true, "installedAt": now_millis() }),
            );
        if pkg.native {
            if let Some(obj) = record.as_object_mut() {
                obj.insert("enabled".to_string(), Value::Bool(false));
            }
        }
        state.insert(pkg.id.clone(), record);
        match backup.settings.get(&pkg.id) {
            Some(value) => {
                settings.insert(pkg.id.clone(), value.clone());
            }
            None => {
                settings.remove(&pkg.id);
            }
        }
        tracing::debug!(plugin = %pkg.id, version = %pkg.version, "restoring plugin");
        dirs.push(StagedDir {
            rel: format!("{PLUGINS_DIR}/{}", pkg.id),
            files: Some(pkg.files),
        });
    }

    // Pinned publishers: a key already pinned here is kept as it is.
    for publisher in backup.publishers {
        let key_id = publisher.get("keyId").and_then(Value::as_str);
        let known = publishers
            .iter()
            .any(|p| p.get("keyId").and_then(Value::as_str) == key_id);
        if !known {
            publishers.push(publisher);
        }
    }

    let remaining: BTreeSet<&str> = current
        .digests
        .keys()
        .map(String::as_str)
        .filter(|id| mode == RestoreMode::Merge || backup_ids.contains(*id))
        .chain(backup_ids.iter().map(String::as_str))
        .collect();
    let files = vec![
        root_file(STATE_FILE, &serde_json::json!({ "plugins": state }))?,
        root_file(SETTINGS_FILE, &serde_json::json!({ "plugins": settings }))?,
        root_file(
            PUBLISHERS_FILE,
            &serde_json::json!({ "publishers": publishers }),
        )?,
    ];
    Ok(PreparedPlugins {
        files,
        dirs,
        resulting_count: count(remaining.len()),
    })
}
