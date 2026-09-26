//! The **plugins** backup section (#3515): installed plugin packages, their
//! `plugin-state.json` records and settings, and the pinned publisher keys.
//!
//! # What is (and is not) backed up
//!
//! - **Packages** — every file of each installed plugin directory
//!   (`plugins/<id>/…`, the extracted package including its `signature.json`),
//!   base64-encoded. Plugins larger than [`MAX_PLUGIN_BACKUP_BYTES`], or that
//!   would push the section past [`MAX_PLUGINS_BACKUP_TOTAL_BYTES`], are
//!   **skipped with a warning** so a backup stays bounded (reinstall them from
//!   their package after restoring).
//! - **State** — each plugin's `plugin-state.json` record, verbatim: enabled
//!   flag, install time, package digest, and the **signer record** (#3505) the
//!   signer-change gate compares against on the next update.
//! - **Settings** — each plugin's `plugin-settings.json` entry.
//! - **Pinned publishers** — the user-pinned keys of `trust-store.json`. Each
//!   restored key must still hash to its `keyId`.
//! - **Not** the native-plugin trust file (`native-plugin-trust.json`): neither
//!   the global "native plugins on" switch nor the per-plugin, library-hash
//!   bound acknowledgments ever leave or enter a machine through a backup.
//!
//! # Trust on restore
//!
//! Restoring puts plugin **code** on disk, so it never bypasses the plugin
//! trust gates:
//!
//! - The section is only exported encrypted and only restored from an
//!   encrypted (therefore authenticated) backup.
//! - A restored **native** plugin (one with a terminal backend library) always
//!   comes back **turned off**, and because acknowledgments are not restored it
//!   only loads after the user turns it on and acknowledges trust on this
//!   machine — the native trust gate is keyed by the exact library hash, so an
//!   acknowledgment this machine made for other bytes never covers it.
//! - Every restored plugin's `manifest.json` must parse and validate, and name
//!   the directory it is restored into; file paths must stay inside it.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Component, Path};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use termihub_core::plugin::{is_valid_plugin_id, MANIFEST_FILE_NAME, NATIVE_TRUST_FILE_NAME};

use super::{BackupSection, BackupSectionInfo};
use crate::credential::vault::VaultError;

mod restore;

pub use restore::{prepare, preview, StagedDir};

/// Section id of the plugins section.
pub const SECTION_ID: &str = "plugins";
/// Display name of the plugins section.
pub const LABEL: &str = "Plugins";
/// Schema version of the plugins section written by this build.
pub const SCHEMA_VERSION: u32 = 1;
/// The plugins directory inside the config directory.
pub const PLUGINS_DIR: &str = "plugins";
/// Per-plugin state file (enabled flag, install time, digest, signer record).
pub const STATE_FILE: &str = "plugin-state.json";
/// Per-plugin settings file.
pub const SETTINGS_FILE: &str = "plugin-settings.json";
/// Pinned publisher keys.
pub const PUBLISHERS_FILE: &str = "trust-store.json";
/// The plugin-root files a restore may write (relative to the config dir).
pub const RESTORABLE_ROOT_FILES: &[&str] = &[STATE_FILE, SETTINGS_FILE, PUBLISHERS_FILE];

/// Largest plugin (sum of its files) included in a backup. Larger plugins are
/// skipped with a warning.
pub const MAX_PLUGIN_BACKUP_BYTES: u64 = 16 * 1024 * 1024;
/// Largest total size of all plugin files in one backup. Chosen so that, after
/// base64 in the section and again in the encryption envelope (×16/9), the
/// plugins fit comfortably under [`super::MAX_BACKUP_FILE_BYTES`].
pub const MAX_PLUGINS_BACKUP_TOTAL_BYTES: u64 = 24 * 1024 * 1024;
/// Most files one backed-up plugin may have.
pub const MAX_PLUGIN_FILES: usize = 4096;

const MIB: f64 = 1024.0 * 1024.0;

/// The section's data document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginsDoc {
    /// Schema version (`"1"`).
    pub version: String,
    /// `plugin-state.json` records keyed by plugin id, verbatim.
    #[serde(default)]
    pub state: Map<String, Value>,
    /// `plugin-settings.json` entries keyed by plugin id.
    #[serde(default)]
    pub settings: Map<String, Value>,
    /// User-pinned publisher keys from `trust-store.json`, verbatim.
    #[serde(default)]
    pub publishers: Vec<Value>,
    /// The installed plugin packages.
    #[serde(default)]
    pub packages: Vec<PluginPackage>,
}

/// One installed plugin's files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    pub id: String,
    pub files: Vec<PluginFile>,
}

/// One file of a plugin: its `/`-separated path inside `plugins/<id>/` and its
/// base64 content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub path: String,
    pub data: String,
}

/// A validated, decoded plugin from a backup.
pub struct ValidatedPackage {
    pub id: String,
    pub version: String,
    /// Whether the plugin has a native (in-process) backend library.
    pub native: bool,
    /// Decoded files (relative path, bytes).
    pub files: Vec<(String, Vec<u8>)>,
    /// Content digest, comparable with [`dir_digest`].
    pub digest: String,
}

/// A validated plugins section.
pub struct ValidatedPlugins {
    pub packages: Vec<ValidatedPackage>,
    pub state: Map<String, Value>,
    pub settings: Map<String, Value>,
    pub publishers: Vec<Value>,
}

fn other(message: impl Into<String>) -> VaultError {
    VaultError::Other {
        message: message.into(),
    }
}

fn mib(bytes: u64) -> String {
    // Precision loss is irrelevant for a one-decimal size in a message.
    #[allow(clippy::cast_precision_loss)]
    let value = bytes as f64 / MIB;
    format!("{value:.1} MB")
}

/// Whether `path` is a safe relative file path inside a plugin directory.
fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || path.contains('\\') || path.contains('\0') {
        return false;
    }
    let p = Path::new(path);
    p.components().all(|c| matches!(c, Component::Normal(_)))
        && path.split('/').all(|seg| !seg.is_empty())
}

/// Digest of a plugin's files, independent of where they live: sha256 over
/// the sorted `(path, length, bytes)` triples.
fn files_digest<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> String {
    let mut sorted: Vec<(&str, &[u8])> = files.into_iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut hasher = Sha256::new();
    for (path, bytes) in sorted {
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// One regular file found in a plugin directory.
struct FoundFile {
    rel: String,
    path: std::path::PathBuf,
    size: u64,
}

/// List a plugin directory's regular files and their total size (symlinks and
/// other special files are not followed). Only metadata is read. Stops once
/// more than [`MAX_PLUGIN_FILES`] files were found.
fn list_files(dir: &Path) -> std::io::Result<(Vec<FoundFile>, u64)> {
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((current, prefix)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&current)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.is_dir() {
                stack.push((entry.path(), rel));
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
                out.push(FoundFile {
                    rel,
                    path: entry.path(),
                    size: meta.len(),
                });
                if out.len() > MAX_PLUGIN_FILES {
                    return Ok((out, total));
                }
            }
        }
    }
    Ok((out, total))
}

/// Digest of an installed plugin directory (see [`files_digest`]).
pub fn dir_digest(dir: &Path) -> std::io::Result<String> {
    let (files, _) = list_files(dir)?;
    let mut loaded = Vec::with_capacity(files.len());
    for f in files {
        let mut bytes = Vec::new();
        std::fs::File::open(&f.path)?.read_to_end(&mut bytes)?;
        loaded.push((f.rel, bytes));
    }
    Ok(files_digest(
        loaded.iter().map(|(p, b)| (p.as_str(), b.as_slice())),
    ))
}

/// The installed plugin ids under `root` (directories named by a valid plugin
/// id that hold a `manifest.json`), sorted.
fn installed_ids(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|id| is_valid_plugin_id(id))
        .filter(|id| root.join(id).join(MANIFEST_FILE_NAME).is_file())
        .collect();
    ids.sort();
    ids
}

/// Read a plugin-root JSON document's field (`plugins` map or `publishers`
/// list). `Ok(None)` when the file does not exist.
fn read_root_json(root: &Path, file: &str) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(root.join(file)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{file} is not valid JSON: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {file}: {e}")),
    }
}

fn plugins_map(doc: Option<Value>) -> Map<String, Value> {
    doc.and_then(|d| d.get("plugins").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn publishers_list(doc: Option<Value>) -> Vec<Value> {
    doc.and_then(|d| d.get("publishers").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// The plugins section's entry in the export dialog.
pub fn section_info(config_dir: &Path) -> BackupSectionInfo {
    let root = config_dir.join(PLUGINS_DIR);
    let ids = installed_ids(&root);
    let has_publishers = read_root_json(&root, PUBLISHERS_FILE)
        .ok()
        .flatten()
        .is_some_and(|d| !publishers_list(Some(d)).is_empty());
    BackupSectionInfo {
        id: SECTION_ID.to_string(),
        label: LABEL.to_string(),
        description: "Installed plugins with their settings and trusted publishers. Native \
                      plugins come back turned off and must be trusted again."
            .to_string(),
        contains_secrets: false,
        requires_encryption: true,
        present: !ids.is_empty() || has_publishers,
        item_count: u32::try_from(ids.len()).unwrap_or(u32::MAX),
    }
}

/// Read the installed plugins for a backup. `Ok(None)` when there is nothing
/// to back up. Plugins over the size caps are skipped and named in the
/// returned warnings.
pub fn export_section(config_dir: &Path) -> Result<Option<(BackupSection, Vec<String>)>, String> {
    let root = config_dir.join(PLUGINS_DIR);
    if !root.is_dir() {
        return Ok(None);
    }
    let mut warnings = Vec::new();
    let mut packages = Vec::new();
    let mut total = 0u64;
    for id in installed_ids(&root) {
        let dir = root.join(&id);
        let (files, size) =
            list_files(&dir).map_err(|e| format!("could not read plugin {id}: {e}"))?;
        let reason = if size > MAX_PLUGIN_BACKUP_BYTES || files.len() > MAX_PLUGIN_FILES {
            Some(format!(
                "it is larger than the {} a backup holds per plugin",
                mib(MAX_PLUGIN_BACKUP_BYTES)
            ))
        } else if total.saturating_add(size) > MAX_PLUGINS_BACKUP_TOTAL_BYTES {
            Some(format!(
                "the backup already holds the maximum of {} of plugins",
                mib(MAX_PLUGINS_BACKUP_TOTAL_BYTES)
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            warnings.push(format!(
                "Plugin \"{id}\" was not included because {reason}. Reinstall it from its \
                 package after restoring."
            ));
            continue;
        }
        let mut encoded = Vec::with_capacity(files.len());
        for f in &files {
            let mut bytes = Vec::with_capacity(usize::try_from(f.size).unwrap_or(0));
            std::fs::File::open(&f.path)
                .and_then(|mut file| file.read_to_end(&mut bytes))
                .map_err(|e| format!("could not read plugin {id} file {}: {e}", f.rel))?;
            encoded.push(PluginFile {
                path: f.rel.clone(),
                data: BASE64.encode(&bytes),
            });
        }
        total = total.saturating_add(size);
        packages.push(PluginPackage { id, files: encoded });
    }

    let included: BTreeSet<&str> = packages.iter().map(|p| p.id.as_str()).collect();
    let keep = |map: Map<String, Value>| -> Map<String, Value> {
        map.into_iter()
            .filter(|(id, _)| included.contains(id.as_str()))
            .collect()
    };
    let state = keep(plugins_map(read_root_json(&root, STATE_FILE)?));
    let settings = keep(plugins_map(read_root_json(&root, SETTINGS_FILE)?));
    let publishers = publishers_list(read_root_json(&root, PUBLISHERS_FILE)?);
    if packages.is_empty() && publishers.is_empty() && warnings.is_empty() {
        return Ok(None);
    }
    let doc = PluginsDoc {
        version: SCHEMA_VERSION.to_string(),
        state,
        settings,
        publishers,
        packages,
    };
    let data = serde_json::to_value(&doc).map_err(|e| e.to_string())?;
    Ok(Some((
        BackupSection {
            id: SECTION_ID.to_string(),
            schema_version: SCHEMA_VERSION,
            data,
        },
        warnings,
    )))
}

/// Message for an integrity-sensitive section in an unencrypted backup.
pub fn needs_encrypted_backup_message(label: &str) -> String {
    format!(
        "{label} can only be restored from an encrypted backup — an unencrypted file could have \
         been edited to add entries you never trusted."
    )
}

/// Whether `rel` (relative to the config dir) is a plugin-root file a restore
/// may write. The native-plugin trust file is deliberately not one of them.
pub fn is_restorable_root_file(rel: &str) -> bool {
    rel.strip_prefix(PLUGINS_DIR)
        .and_then(|r| r.strip_prefix('/'))
        .is_some_and(|name| RESTORABLE_ROOT_FILES.contains(&name) && name != NATIVE_TRUST_FILE_NAME)
}

/// Whether `rel` (relative to the config dir) is a plugin directory a restore
/// may write or remove (`plugins/<valid id>`).
pub fn is_restorable_plugin_dir(rel: &str) -> bool {
    rel.strip_prefix(PLUGINS_DIR)
        .and_then(|r| r.strip_prefix('/'))
        .is_some_and(is_valid_plugin_id)
}
