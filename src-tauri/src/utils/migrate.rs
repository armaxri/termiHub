//! Schema-version migration + downgrade data-safety for the JSON config stores.
//!
//! Every persisted store carries a `version` field. Historically that field was
//! *written but never read* (PER-001): there was no migration step, no version
//! gate, and the corruption-recovery path could not tell a genuinely-unparseable
//! file from one written by a **newer** app version — so a downgrade or a staged
//! auto-update rollback silently reset the newer file to defaults (PER-004) or
//! dropped its unknown fields on the next save (PER-010). Because termiHub
//! auto-updates, every one of those is a live data-loss path.
//!
//! This module is the shared read/write safety layer:
//!
//! * [`VersionedStore`] — a store declares its current schema version, a name for
//!   diagnostics, and (optionally) ordered forward migrations.
//! * [`load_versioned`] parses the raw JSON, reads its version, and either uses
//!   it as-is (`== current`), migrates it forward (`< current`), refuses it
//!   without touching the file (`> current`), or reports genuine corruption
//!   (unparseable).
//! * [`load_store_with_recovery`] wires that into the shared "load a store with
//!   recovery" flow the reset-to-default JSON stores share, so they all gain the
//!   version gate and the downgrade protection uniformly.
//! * [`guard_not_newer`] is called by every wired store's `save` **before** it
//!   writes, so an older binary can never overwrite a file a newer binary wrote —
//!   even across a fresh storage instance or a process restart, and even after
//!   the in-memory data was reset to defaults.
//!
//! ## Versioning policy
//!
//! `version` stays a JSON **string** on disk (`"1"`, `"2"`) — this module reads
//! it flexibly (string *or* number) so the current on-disk format is unchanged;
//! there is no gratuitous migration of existing current-version files. The value
//! of this layer today is the machinery for the **future** plus the **downgrade
//! protection now**. When a schema actually changes, bump the store's
//! `CURRENT_VERSION` and register a step in its `migrate` — the version gate then
//! makes the change forward-migrating and downgrade-safe automatically.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::fs::write_atomic;

// The primitives themselves live in the shared core layer (#4334), so the
// desktop, the agent and the plugin stores run one implementation.
pub use termihub_core::util::persist::{
    backup_corrupt_file, is_unbacked_corrupt, protect_unbacked_corrupt, read_version,
    release_unbacked_corrupt, NewerVersionError, OverwriteError, ASSUMED_VERSION,
};

/// Outcome of [`load_versioned`].
pub enum LoadOutcome<T> {
    /// The store parsed (possibly after a forward migration). `migrated_from`
    /// carries the on-disk version when a migration ran, else `None`.
    Loaded { data: T, migrated_from: Option<u32> },
    /// The file was written by a newer schema version — it must be left intact.
    Newer(NewerVersionError),
    /// The file was genuinely unparseable (not a version mismatch). The string
    /// is the parse/migration error detail.
    Corrupt(String),
}

/// A persisted store that participates in schema versioning + downgrade safety.
pub trait VersionedStore: DeserializeOwned {
    /// Diagnostic name of the store's file (e.g. `"workspaces.json"`).
    const STORE_NAME: &'static str;
    /// The newest schema version this binary reads and writes.
    const CURRENT_VERSION: u32;

    /// Migrate a parsed JSON value from `from_version` up to `CURRENT_VERSION`.
    ///
    /// The default is the **identity** migration: a store at v1 with no prior
    /// released schema has nothing to migrate, so the value passes through
    /// unchanged. Override this once a schema actually changes to transform the
    /// older on-disk shape forward, one version at a time, up to the current one.
    fn migrate(value: Value, from_version: u32) -> Result<Value> {
        let _ = from_version;
        Ok(value)
    }

    /// Attempt granular, per-entry recovery of a readable-but-invalid file,
    /// dropping only the corrupt entries instead of resetting the whole store
    /// (PER-004).
    ///
    /// `value` is the file's JSON **after** [`VersionedStore::migrate`] ran
    /// on it (when it was readable at an older version — PER2-007), so entries
    /// are judged against the current shape exactly as a clean load would.
    ///
    /// The default treats the store as **atomic** — no per-entry salvage — so
    /// [`load_store_with_recovery`] falls back to a whole reset, preserving the
    /// pre-existing behavior. A list-shaped store overrides this to delegate to
    /// [`salvage_list_store`] with its collection field and entry type.
    fn salvage(value: Value, file_name: &str) -> Salvage<Self> {
        let _ = (value, file_name);
        Salvage::Unsalvageable
    }
}

/// Parse `raw`, read its version, and produce a [`LoadOutcome`]:
///
/// * unparseable JSON → [`LoadOutcome::Corrupt`]
/// * `version > current` → [`LoadOutcome::Newer`] (the caller must not touch the file)
/// * `version < current` → run [`VersionedStore::migrate`], then deserialize
/// * `version == current` (or absent) → deserialize as-is
///
/// A deserialize or migration failure at or below the current version is treated
/// as [`LoadOutcome::Corrupt`] — the value was readable JSON but not a valid
/// store of this (or a migratable) shape.
pub fn load_versioned<T: VersionedStore>(raw: &str) -> LoadOutcome<T> {
    let value: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return LoadOutcome::Corrupt(e.to_string()),
    };

    let version = read_version(&value).unwrap_or(ASSUMED_VERSION);

    if version > T::CURRENT_VERSION {
        return LoadOutcome::Newer(NewerVersionError {
            store: T::STORE_NAME,
            found: version,
            supported: T::CURRENT_VERSION,
        });
    }

    let (payload, migrated_from) = if version < T::CURRENT_VERSION {
        match T::migrate(value, version) {
            Ok(v) => (v, Some(version)),
            Err(e) => {
                return LoadOutcome::Corrupt(format!("migration from v{version} failed: {e}"))
            }
        }
    } else {
        (value, None)
    };

    match serde_json::from_value::<T>(payload) {
        Ok(data) => LoadOutcome::Loaded {
            data,
            migrated_from,
        },
        Err(e) => LoadOutcome::Corrupt(e.to_string()),
    }
}

/// Refuse to overwrite a file that was written by a **newer** schema version,
/// or a corrupt file whose backup failed this session ([`protect_unbacked_corrupt`]).
///
/// An adapter over the shared [`termihub_core::util::persist::guard_not_newer`]
/// (#4334): stateless (it re-reads the file), so it protects a save even across
/// a fresh storage instance or after the in-memory data was reset to defaults on
/// a newer-version load. A missing, unparseable, or same/older file is fine to
/// overwrite, so genuine corruption can still be reset.
pub fn guard_not_newer(path: &Path, store: &'static str, current: u32) -> Result<()> {
    if is_unbacked_corrupt(path) {
        return Err(OverwriteError::UnbackedCorrupt { store }.into());
    }
    Ok(termihub_core::util::persist::guard_not_newer(
        path, store, current,
    )?)
}

/// The top-level fields of the store file at `path` that are **not** in `known`
/// — the unknown fields a save must carry forward (PER-010).
///
/// For a store whose save path writes from an in-memory list rather than from
/// a loaded store value (so it never held the file's `extra` fields), this
/// re-reads them from disk just before the write. A missing, unparseable or
/// non-object file yields an empty map. Call it only after [`guard_not_newer`]
/// has passed, so the fields come from a same-or-older schema.
pub fn read_unknown_fields(path: &Path, known: &[&str]) -> serde_json::Map<String, Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return serde_json::Map::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(mut obj)) => {
            obj.retain(|key, _| !known.contains(&key.as_str()));
            obj
        }
        _ => serde_json::Map::new(),
    }
}

/// Outcome of a granular, per-entry salvage attempt on a list-shaped store.
pub enum Salvage<T> {
    /// The store was rebuilt from the entries that still parse; `warnings`
    /// records each dropped entry.
    Recovered {
        data: T,
        warnings: Vec<RecoveryWarning>,
    },
    /// The file could not be salvaged at the entry level — the JSON was not an
    /// object with the expected array, every entry already parsed (so the
    /// breakage is elsewhere), or the rebuilt store still failed to deserialize.
    /// The caller falls back to a whole-store reset.
    Unsalvageable,
}

/// Granular per-entry recovery for a flat, list-shaped store — the
/// don't-reset-everything counterpart to `connection::storage`'s per-node
/// recovery (PER-004).
///
/// When a store shaped `{ "version": …, "<field>": [ <entries> ], … }` fails a
/// whole-file parse, this validates each element of the `<field>` array of the
/// (already migrated) `value` against `Entry` individually, keeping the ones
/// that parse and dropping only the corrupt ones (each recorded as a
/// [`RecoveryWarning`]). The store is then rebuilt from the survivors **plus
/// every other top-level field** (so unknown/`extra` fields are preserved) and
/// returned as [`Salvage::Recovered`].
///
/// Returns [`Salvage::Unsalvageable`] — leaving the caller to whole-reset — when
/// `value` is not an object, has no `<field>` array, every entry already parses
/// (so the breakage is in another field), or the rebuilt store still fails to
/// deserialize. `Entry` is the *current* entry shape: the caller
/// ([`load_store_with_recovery`]) runs the store's forward migration first, so
/// an older file's entries are judged after they were brought up to date
/// (PER2-007).
pub fn salvage_list_store<T, Entry>(mut value: Value, file_name: &str, field: &str) -> Salvage<T>
where
    T: DeserializeOwned,
    Entry: DeserializeOwned,
{
    let Some(entries) = value.get(field).and_then(Value::as_array) else {
        return Salvage::Unsalvageable;
    };

    let mut kept: Vec<Value> = Vec::with_capacity(entries.len());
    let mut warnings: Vec<RecoveryWarning> = Vec::new();

    for (index, entry) in entries.iter().enumerate() {
        match serde_json::from_value::<Entry>(entry.clone()) {
            Ok(_) => kept.push(entry.clone()),
            Err(e) => {
                let label = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("id").and_then(Value::as_str))
                    .or_else(|| entry.get("title").and_then(Value::as_str))
                    .unwrap_or("unknown");
                warnings.push(RecoveryWarning {
                    file_name: file_name.to_string(),
                    message: format!("Removed corrupt entry at index {index} (\"{label}\")."),
                    details: Some(e.to_string()),
                });
                tracing::warn!(
                    "Dropped corrupt {file_name} entry at index {index} (\"{label}\"): {e}"
                );
            }
        }
    }

    // Nothing was individually corrupt — the breakage is in some other field, so
    // leave it to the caller's whole-store reset rather than returning a store we
    // already know does not deserialize.
    if warnings.is_empty() {
        return Salvage::Unsalvageable;
    }

    // Rebuild with only the surviving entries; every other top-level field is
    // carried through untouched.
    if let Some(slot) = value.get_mut(field) {
        *slot = Value::Array(kept);
    }

    match serde_json::from_value::<T>(value) {
        Ok(data) => Salvage::Recovered { data, warnings },
        Err(_) => Salvage::Unsalvageable,
    }
}

/// Shared "load a versioned store with recovery" flow for the standard
/// reset-to-default JSON stores.
///
/// * missing file → `T::default()` (no warning)
/// * parseable at/below the current version → the (migrated) typed store; a
///   migrated file is upgraded on disk (best-effort atomic rewrite) so the
///   migration runs once
/// * **newer** version → `T::default()` in memory **plus a warning**, and the
///   file is left *completely intact* (never backed up, never overwritten) — the
///   PER-004 downgrade-safety guarantee. The store's own `save` guards too, so an
///   in-version change made afterwards cannot clobber the newer file either.
/// * genuinely unparseable → [`recover_corrupt_store`]: back up to a fresh
///   `<name>.bak[.N]`, salvage what parses, and rewrite the file only once the
///   backup is safely on disk
pub fn load_store_with_recovery<T>(path: &Path, file_name: &str) -> Result<RecoveryResult<T>>
where
    T: VersionedStore + Default + Serialize,
{
    if !path.exists() {
        return Ok(RecoveryResult {
            data: T::default(),
            warnings: Vec::new(),
        });
    }

    let raw = fs::read_to_string(path).with_context(|| format!("Failed to read {file_name}"))?;

    match load_versioned::<T>(&raw) {
        LoadOutcome::Loaded {
            data,
            migrated_from,
        } => {
            // The file parses again, so a guard armed by an earlier failed
            // backup has nothing left to protect.
            release_unbacked_corrupt(path);
            if let Some(from) = migrated_from {
                tracing::info!(
                    "Migrated {file_name} from schema v{from} to v{}",
                    T::CURRENT_VERSION
                );
                // Upgrade the on-disk file once so the migration is not re-run
                // on every load. Best-effort: the in-memory data is already
                // correct, so a failed rewrite must not fail the load.
                if let Ok(pretty) = serde_json::to_string_pretty(&data) {
                    if let Err(e) = write_atomic(path, &pretty) {
                        tracing::warn!("Could not persist migrated {file_name}: {e}");
                    }
                }
            }
            Ok(RecoveryResult {
                data,
                warnings: Vec::new(),
            })
        }
        LoadOutcome::Newer(err) => {
            // PER-004: NEVER touch a newer-but-readable file. Run on defaults in
            // memory and warn; the file stays exactly as the newer version left
            // it. (The save path guards against clobbering it later.)
            tracing::error!("{err}");
            Ok(RecoveryResult {
                data: T::default(),
                warnings: vec![newer_version_warning(file_name, &err)],
            })
        }
        LoadOutcome::Corrupt(detail) => {
            recover_corrupt_store::<T>(path, file_name, &raw, detail, |data| {
                let pretty = serde_json::to_string_pretty(data)
                    .with_context(|| format!("Failed to serialize recovered {file_name}"))?;
                write_atomic(path, &pretty)
            })
        }
    }
}

/// The user-facing warning for a store file written by a newer schema version.
pub fn newer_version_warning(file_name: &str, err: &NewerVersionError) -> RecoveryWarning {
    RecoveryWarning {
        file_name: file_name.to_string(),
        message: format!(
            "This file was written by a newer version of termiHub (schema v{}). \
             It was left unchanged to avoid data loss; changes made now will not be \
             saved over it. Update termiHub to use this data.",
            err.found
        ),
        details: Some(err.to_string()),
    }
}

/// The JSON a corrupt file's salvage should see: the raw document brought up
/// to the current schema by [`VersionedStore::migrate`] when it is readable at
/// an older version (PER2-007). `None` when the text is not JSON at all.
pub fn salvage_input<T: VersionedStore>(raw: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let version = read_version(&value).unwrap_or(ASSUMED_VERSION);
    if version < T::CURRENT_VERSION {
        if let Ok(migrated) = T::migrate(value.clone(), version) {
            return Some(migrated);
        }
    }
    Some(value)
}

/// Recover a store whose file is genuinely corrupt (readable bytes that are
/// not a valid store at/below the current version) — the one shared rule for
/// every store (ERR2-002):
///
/// 1. **Back up first, checked.** The original is copied to a fresh
///    `<name>.bak[.N]` ([`backup_corrupt_file`]); an earlier backup is never
///    overwritten.
/// 2. **Salvage** what parses via [`VersionedStore::salvage`] on the migrated
///    document, else fall back to `T::default()`.
/// 3. **Persist only if the backup succeeded.** `persist` writes the recovered
///    store (the store's own writer). If the backup failed, nothing is written:
///    the recovered data is returned in memory only, the save guard is armed
///    ([`protect_unbacked_corrupt`]) and the warning says so honestly.
pub fn recover_corrupt_store<T>(
    path: &Path,
    file_name: &str,
    raw: &str,
    detail: String,
    persist: impl FnOnce(&T) -> Result<()>,
) -> Result<RecoveryResult<T>>
where
    T: VersionedStore + Default,
{
    recover_corrupt_store_with(path, file_name, raw, detail, backup_corrupt_file, persist)
}

/// [`recover_corrupt_store`] with an injectable backup step (tests force it to
/// fail).
fn recover_corrupt_store_with<T>(
    path: &Path,
    file_name: &str,
    raw: &str,
    detail: String,
    backup: impl FnOnce(&Path) -> std::io::Result<PathBuf>,
    persist: impl FnOnce(&T) -> Result<()>,
) -> Result<RecoveryResult<T>>
where
    T: VersionedStore + Default,
{
    let backup = backup(path);

    // Granular recovery first (PER-004): for a list-shaped store, drop only the
    // individually-corrupt entries and keep the rest, resetting the whole store
    // only when even the container is unparseable. Atomic stores fall straight
    // through to the reset (default `salvage`).
    let salvaged = match salvage_input::<T>(raw) {
        Some(value) => T::salvage(value, file_name),
        None => Salvage::Unsalvageable,
    };
    let (data, mut warnings, salvaged) = match salvaged {
        Salvage::Recovered { data, warnings } => (data, warnings, true),
        Salvage::Unsalvageable => (T::default(), Vec::new(), false),
    };

    match backup {
        Ok(backup_path) => {
            let backup_name = backup_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if salvaged {
                tracing::warn!(
                    "{file_name} had {} corrupt entrie(s); salvaged the rest, backed up to {}",
                    warnings.len(),
                    backup_path.display()
                );
                // Persist so the drop is durable and the file parses cleanly next
                // launch. Best-effort: the in-memory data is already correct.
                if let Err(e) = persist(&data) {
                    tracing::warn!("Could not persist salvaged {file_name}: {e:#}");
                }
                for warning in &mut warnings {
                    warning.message = format!(
                        "{} The original was backed up as {backup_name}.",
                        warning.message
                    );
                }
            } else {
                tracing::error!(
                    "{file_name} is corrupt, backed up to {} and reset to defaults",
                    backup_path.display()
                );
                persist(&data).with_context(|| {
                    format!("Failed to write default {file_name} after recovery")
                })?;
                warnings.push(RecoveryWarning {
                    file_name: file_name.to_string(),
                    message: format!(
                        "{file_name} was corrupt and has been reset to defaults. \
                         The original was backed up as {backup_name}."
                    ),
                    details: Some(detail),
                });
            }
        }
        Err(e) => {
            // ERR2-002: without a backup the live file is the only copy — never
            // overwrite it. Run on the recovered data in memory and block saves.
            tracing::error!(
                "{file_name} is corrupt and could not be backed up ({e}); \
                 leaving it untouched and running on recovered data in memory only"
            );
            protect_unbacked_corrupt(path);
            let state = if salvaged {
                "the entries that could be read are loaded"
            } else {
                "termiHub is running on defaults"
            };
            warnings.insert(
                0,
                RecoveryWarning {
                    file_name: file_name.to_string(),
                    message: format!(
                        "{file_name} is corrupt and could not be backed up, so the original \
                         was left untouched; {state} in memory only. Changes will not be saved \
                         until the file is repaired or disk space is freed and termiHub restarted."
                    ),
                    details: Some(format!("{detail}; backup failed: {e}")),
                },
            );
        }
    }

    Ok(RecoveryResult { data, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;
    use tempfile::TempDir;

    /// A v1 store: identity migration, unknown top-level fields preserved.
    #[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
    struct V1Store {
        version: String,
        items: Vec<String>,
        #[serde(flatten, default)]
        extra: serde_json::Map<String, Value>,
    }

    impl VersionedStore for V1Store {
        const STORE_NAME: &'static str = "v1-store.json";
        const CURRENT_VERSION: u32 = 1;

        fn salvage(value: Value, file_name: &str) -> Salvage<Self> {
            salvage_list_store::<Self, String>(value, file_name, "items")
        }
    }

    /// A v2 store with a real v1 -> v2 migration (renames `oldName` -> `name`
    /// and bumps the version), to prove the migration path actually runs.
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct V2Store {
        version: String,
        name: String,
    }

    impl Default for V2Store {
        fn default() -> Self {
            Self {
                version: "2".to_string(),
                name: String::new(),
            }
        }
    }

    impl VersionedStore for V2Store {
        const STORE_NAME: &'static str = "v2-store.json";
        const CURRENT_VERSION: u32 = 2;

        fn migrate(mut value: Value, from_version: u32) -> Result<Value> {
            if from_version < 2 {
                if let Some(obj) = value.as_object_mut() {
                    if let Some(old) = obj.remove("oldName") {
                        obj.insert("name".to_string(), old);
                    }
                    obj.insert("version".to_string(), json!("2"));
                }
            }
            Ok(value)
        }
    }

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    /// A v2 list store whose v1 -> v2 migration adds a required `seeded` field
    /// to every entry — so an entry only validates against the current shape
    /// *after* the migration ran (PER2-007).
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct V2Item {
        name: String,
        seeded: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct V2List {
        version: String,
        items: Vec<V2Item>,
    }

    impl Default for V2List {
        fn default() -> Self {
            Self {
                version: "2".to_string(),
                items: Vec::new(),
            }
        }
    }

    impl VersionedStore for V2List {
        const STORE_NAME: &'static str = "v2-list.json";
        const CURRENT_VERSION: u32 = 2;

        fn migrate(mut value: Value, from_version: u32) -> Result<Value> {
            if from_version < 2 {
                if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
                    for item in items.iter_mut().filter_map(Value::as_object_mut) {
                        item.entry("seeded").or_insert(json!(true));
                    }
                }
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("version".to_string(), json!("2"));
                }
            }
            Ok(value)
        }

        fn salvage(value: Value, file_name: &str) -> Salvage<Self> {
            salvage_list_store::<Self, V2Item>(value, file_name, "items")
        }
    }

    /// PER2-007: salvage of an older-version file runs on the MIGRATED value,
    /// so a valid entry is not dropped merely for lacking a field the
    /// migration would have added.
    #[test]
    fn salvage_runs_on_migrated_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v2-list.json");
        fs::write(
            &path,
            r#"{"version":"1","items":[{"name":"keep"},{"name":7}]}"#,
        )
        .unwrap();

        let result = load_store_with_recovery::<V2List>(&path, "v2-list.json").unwrap();
        assert_eq!(
            result.data.items,
            vec![V2Item {
                name: "keep".to_string(),
                seeded: true
            }],
            "the valid v1 entry survives, migrated"
        );
        assert_eq!(
            result.warnings.len(),
            1,
            "only the corrupt entry is dropped"
        );
        let on_disk: V2List = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.version, "2");
    }

    /// ERR2-002: each corruption gets its own backup — a later one never
    /// overwrites an earlier `.bak`, which may hold entries salvage dropped.
    #[test]
    fn corruption_backup_never_overwrites_an_earlier_backup() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        fs::write(path.with_extension("json.bak"), "first backup").unwrap();
        fs::write(&path, "corrupt #2 {{{").unwrap();

        let result = load_store_with_recovery::<V1Store>(&path, "v1-store.json").unwrap();

        assert_eq!(
            fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "first backup"
        );
        let second = dir.path().join("v1-store.json.bak.1");
        assert_eq!(fs::read_to_string(&second).unwrap(), "corrupt #2 {{{");
        assert!(
            result.warnings[0].message.contains("v1-store.json.bak.1"),
            "the warning names the backup: {}",
            result.warnings[0].message
        );
    }

    #[test]
    fn backup_corrupt_file_picks_first_free_slot() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("s.json");
        fs::write(&path, "x").unwrap();
        assert_eq!(
            backup_corrupt_file(&path).unwrap(),
            dir.path().join("s.json.bak")
        );
        assert_eq!(
            backup_corrupt_file(&path).unwrap(),
            dir.path().join("s.json.bak.1")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("s.json.bak.1")).unwrap(),
            "x"
        );
    }

    /// ERR2-002: when the backup cannot be made, the live file is NOT
    /// rewritten — recovery runs in memory only, says so honestly, and arms the
    /// save guard so a later save cannot clobber the only copy either.
    #[test]
    fn failed_backup_leaves_original_untouched_and_blocks_saves() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        let corrupt = r#"{"version":"1","items":["ok",42]}"#;
        fs::write(&path, corrupt).unwrap();

        let result = recover_corrupt_store_with::<V1Store>(
            &path,
            "v1-store.json",
            corrupt,
            "bad entry".to_string(),
            |_| Err(std::io::Error::other("disk full")),
            |data| write_atomic(&path, &serde_json::to_string_pretty(data)?),
        )
        .unwrap();

        assert_eq!(
            result.data.items,
            vec!["ok".to_string()],
            "salvaged in memory"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            corrupt,
            "original untouched"
        );
        assert!(
            result.warnings[0]
                .message
                .contains("could not be backed up"),
            "honest warning: {}",
            result.warnings[0].message
        );
        assert!(!path.with_extension("json.bak").exists());
        assert!(
            guard_not_newer(&path, V1Store::STORE_NAME, V1Store::CURRENT_VERSION).is_err(),
            "the save guard is armed for the un-backed-up file"
        );

        // Once the file loads cleanly again the guard releases.
        fs::write(&path, r#"{"version":"1","items":[]}"#).unwrap();
        load_store_with_recovery::<V1Store>(&path, "v1-store.json").unwrap();
        assert!(guard_not_newer(&path, V1Store::STORE_NAME, V1Store::CURRENT_VERSION).is_ok());
    }

    /// ERR2-002: an unsalvageable file whose backup failed is not reset on disk.
    #[test]
    fn failed_backup_never_resets_the_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        fs::write(&path, "garbage {{{").unwrap();

        let result = recover_corrupt_store_with::<V1Store>(
            &path,
            "v1-store.json",
            "garbage {{{",
            "unparseable".to_string(),
            |_| Err(std::io::Error::other("read-only")),
            |data| write_atomic(&path, &serde_json::to_string_pretty(data)?),
        )
        .unwrap();

        assert!(result.data.items.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "garbage {{{");
        assert!(result.warnings[0]
            .message
            .contains("could not be backed up"));
    }

    #[test]
    fn read_version_accepts_string_and_number() {
        assert_eq!(read_version(&json!({"version": "3"})), Some(3));
        assert_eq!(read_version(&json!({"version": 3})), Some(3));
        assert_eq!(read_version(&json!({"version": "not-a-number"})), None);
        assert_eq!(read_version(&json!({"no": "version"})), None);
    }

    #[test]
    fn current_version_loads_as_is() {
        let raw = r#"{"version":"1","items":["a"]}"#;
        match load_versioned::<V1Store>(raw) {
            LoadOutcome::Loaded {
                data,
                migrated_from,
            } => {
                assert_eq!(data.items, vec!["a"]);
                assert_eq!(migrated_from, None);
            }
            _ => panic!("expected Loaded"),
        }
    }

    /// PER-001: an older-version file is migrated to current on load.
    #[test]
    fn older_version_is_migrated_forward() {
        let raw = r#"{"version":"1","oldName":"legacy"}"#;
        match load_versioned::<V2Store>(raw) {
            LoadOutcome::Loaded {
                data,
                migrated_from,
            } => {
                assert_eq!(data.version, "2");
                assert_eq!(data.name, "legacy");
                assert_eq!(migrated_from, Some(1));
            }
            _ => panic!("expected Loaded after migration"),
        }
    }

    /// PER-004 (core): a newer-version file is refused, not treated as corrupt.
    #[test]
    fn newer_version_is_refused_not_corrupt() {
        let raw = r#"{"version":"99","items":["future"]}"#;
        match load_versioned::<V1Store>(raw) {
            LoadOutcome::Newer(err) => {
                assert_eq!(err.found, 99);
                assert_eq!(err.supported, 1);
            }
            _ => panic!("expected Newer"),
        }
    }

    /// The crux of PER-004: the version gate runs BEFORE the typed parse, so a
    /// newer file whose *shape* this build cannot deserialize is still refused
    /// (Newer) rather than mis-classified as Corrupt — which is what would let
    /// the recovery path wipe it.
    #[test]
    fn newer_version_with_unknown_shape_is_refused_not_corrupt() {
        // `items` is an object here, not the array V1Store models.
        let raw = r#"{"version":"42","items":{"restructured":true}}"#;
        match load_versioned::<V1Store>(raw) {
            LoadOutcome::Newer(err) => assert_eq!(err.found, 42),
            LoadOutcome::Corrupt(_) => panic!("newer file must NOT be classified as corrupt"),
            _ => panic!("expected Newer"),
        }
    }

    #[test]
    fn unparseable_is_corrupt() {
        match load_versioned::<V1Store>("not json {{{") {
            LoadOutcome::Corrupt(_) => {}
            _ => panic!("expected Corrupt"),
        }
    }

    /// PER-010: unknown top-level fields survive a load -> save round-trip.
    #[test]
    fn unknown_fields_round_trip_via_flatten() {
        let raw = r#"{"version":"1","items":["a"],"futureField":{"nested":true}}"#;
        let store = match load_versioned::<V1Store>(raw) {
            LoadOutcome::Loaded { data, .. } => data,
            _ => panic!("expected Loaded"),
        };
        assert_eq!(
            store.extra.get("futureField"),
            Some(&json!({"nested": true})),
            "unknown field must be captured"
        );
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(
            out.get("futureField"),
            Some(&json!({"nested": true})),
            "unknown field must be written back out"
        );
    }

    /// PER-004 (write side): the save guard refuses to overwrite a newer file
    /// AND leaves its bytes exactly as they were on disk.
    #[test]
    fn guard_refuses_and_preserves_newer_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        let newer = r#"{"version":"5","items":["written-by-the-future"]}"#;
        fs::write(&path, newer).unwrap();

        let result = guard_not_newer(&path, V1Store::STORE_NAME, V1Store::CURRENT_VERSION);
        assert!(result.is_err(), "guard must refuse a newer file");

        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(
            after, newer,
            "the newer file must be left byte-for-byte intact"
        );
    }

    #[test]
    fn guard_allows_same_older_missing_and_corrupt() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v2-store.json");

        // Missing file — allowed.
        assert!(guard_not_newer(&path, V2Store::STORE_NAME, 2).is_ok());

        // Same version — allowed.
        fs::write(&path, r#"{"version":"2","name":"x"}"#).unwrap();
        assert!(guard_not_newer(&path, V2Store::STORE_NAME, 2).is_ok());

        // Older version — allowed (an upgrade is fine).
        fs::write(&path, r#"{"version":"1","oldName":"x"}"#).unwrap();
        assert!(guard_not_newer(&path, V2Store::STORE_NAME, 2).is_ok());

        // Corrupt (no readable version) — allowed, so genuine corruption resets.
        fs::write(&path, "garbage {{{").unwrap();
        assert!(guard_not_newer(&path, V2Store::STORE_NAME, 2).is_ok());
    }

    /// End-to-end PER-004 through the shared helper: a newer file on disk is
    /// left intact, load returns defaults + a warning (no backup written).
    #[test]
    fn load_store_with_recovery_preserves_newer_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        let newer = r#"{"version":"7","items":["future"]}"#;
        fs::write(&path, newer).unwrap();

        let result = load_store_with_recovery::<V1Store>(&path, "v1-store.json").unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.data.items.is_empty(), "runs on defaults in memory");

        // The file must be byte-for-byte intact and NOT backed up.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, newer, "newer file must be left intact");
        assert!(
            !path.with_extension("json.bak").exists(),
            "a newer file must never be backed up/reset"
        );
    }

    #[test]
    fn load_store_with_recovery_resets_genuine_corruption() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        fs::write(&path, "totally not json !!!").unwrap();

        let result = load_store_with_recovery::<V1Store>(&path, "v1-store.json").unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.items.is_empty());
        assert!(
            path.with_extension("json.bak").exists(),
            "genuine corruption must be backed up"
        );
        // The reset file is now a valid current-version store.
        let after = fs::read_to_string(&path).unwrap();
        serde_json::from_str::<V1Store>(&after).expect("reset file parses");
    }

    #[test]
    fn load_store_with_recovery_missing_returns_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-store.json");
        let result = load_store_with_recovery::<V1Store>(&path, "v1-store.json").unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.items.is_empty());
    }

    /// PER-004 granular salvage: a readable store with one valid and one corrupt
    /// entry keeps the valid one and drops only the corrupt one.
    #[test]
    fn salvage_list_store_drops_only_corrupt_entry() {
        // `items` is `Vec<String>`; the object element cannot deserialize to a
        // String, the two string elements can.
        let raw = r#"{"version":"1","items":["a",{"not":"a string"},"b"]}"#;
        match salvage_list_store::<V1Store, String>(parse(raw), "v1-store.json", "items") {
            Salvage::Recovered { data, warnings } => {
                assert_eq!(data.items, vec!["a".to_string(), "b".to_string()]);
                assert_eq!(warnings.len(), 1);
                assert!(warnings[0].message.contains("index 1"));
            }
            Salvage::Unsalvageable => panic!("expected a granular recovery"),
        }
    }

    /// When every entry parses, the breakage is in another field — salvage bows
    /// out so the caller whole-resets rather than returning an unchanged store.
    #[test]
    fn salvage_list_store_all_valid_is_unsalvageable() {
        let raw = r#"{"version":"1","items":["a","b"]}"#;
        assert!(matches!(
            salvage_list_store::<V1Store, String>(parse(raw), "v1-store.json", "items"),
            Salvage::Unsalvageable
        ));
    }

    /// A non-object document and a missing collection field are both
    /// unsalvageable.
    #[test]
    fn salvage_list_store_non_object_or_missing_field_is_unsalvageable() {
        assert!(matches!(
            salvage_list_store::<V1Store, String>(json!(["a"]), "v1-store.json", "items"),
            Salvage::Unsalvageable
        ));
        assert!(matches!(
            salvage_list_store::<V1Store, String>(
                json!({"version": "1"}),
                "v1-store.json",
                "items"
            ),
            Salvage::Unsalvageable
        ));
    }

    /// The salvaged store preserves unknown top-level fields (PER-010) — they
    /// ride through the rebuild via `V1Store`'s flattened `extra`.
    #[test]
    fn salvage_list_store_preserves_unknown_top_level_fields() {
        let raw = r#"{"version":"1","items":["ok",42],"futureFlag":{"on":true}}"#;
        match salvage_list_store::<V1Store, String>(parse(raw), "v1-store.json", "items") {
            Salvage::Recovered { data, warnings } => {
                assert_eq!(data.items, vec!["ok".to_string()]);
                assert_eq!(warnings.len(), 1);
                assert_eq!(
                    data.extra.get("futureFlag"),
                    Some(&json!({"on": true})),
                    "unknown field must survive granular salvage"
                );
            }
            Salvage::Unsalvageable => panic!("expected a granular recovery"),
        }
    }

    #[test]
    fn read_unknown_fields_keeps_only_unknown_top_level_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("store.json");
        assert!(
            read_unknown_fields(&path, &["items"]).is_empty(),
            "missing file"
        );
        fs::write(&path, "not json").unwrap();
        assert!(
            read_unknown_fields(&path, &["items"]).is_empty(),
            "unparseable"
        );
        fs::write(&path, r#"{"version":"1","items":[1],"future":{"a":1}}"#).unwrap();
        let extra = read_unknown_fields(&path, &["version", "items"]);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra.get("future"), Some(&json!({"a": 1})));
    }
}
