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
use std::path::Path;

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::fs::write_atomic;

/// The schema version an unversioned or version-less-parse file is assumed to
/// carry. A file with no readable `version` is treated as the baseline (v1)
/// rather than as newer, so a legacy/pre-versioning file still loads.
const ASSUMED_VERSION: u32 = 1;

/// A parsed store was written by a **newer** app version than this binary
/// supports. Carried out of the load path (never reset) and returned by
/// [`guard_not_newer`] to refuse an overwriting save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewerVersionError {
    /// Diagnostic name of the store (e.g. `"workspaces.json"`).
    pub store: &'static str,
    /// The schema version found on disk.
    pub found: u32,
    /// The newest schema version this binary understands.
    pub supported: u32,
}

impl std::fmt::Display for NewerVersionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} was written by a newer version of termiHub (schema v{}, this build supports v{}); \
             refusing to overwrite it to avoid data loss",
            self.store, self.found, self.supported
        )
    }
}

impl std::error::Error for NewerVersionError {}

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
}

/// Read a `version` field as an integer, accepting either a JSON string (`"2"`)
/// or a JSON number (`2`). Absent or unparseable → `None`.
pub fn read_version(value: &Value) -> Option<u32> {
    match value.get("version") {
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(Value::Number(n)) => u32::try_from(n.as_u64()?).ok(),
        _ => None,
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

/// Refuse to overwrite a file that was written by a **newer** schema version.
///
/// Reads `path` (if present) and, if it parses as JSON whose `version` is newer
/// than `current`, returns a [`NewerVersionError`]. A missing, unparseable, or
/// same/older file is fine to overwrite — only a *parseable-but-newer* file is
/// protected, so genuine corruption can still be reset. Being stateless (it
/// re-reads the file), it protects a save even across a fresh storage instance
/// or after the in-memory data was reset to defaults on a newer-version load.
pub fn guard_not_newer(path: &Path, store: &'static str, current: u32) -> Result<()> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    if let Some(found) = read_version(&value) {
        if found > current {
            return Err(NewerVersionError {
                store,
                found,
                supported: current,
            }
            .into());
        }
    }
    Ok(())
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
/// * genuinely unparseable → back up to `<name>.bak` + reset to `T::default()`
///   (the pre-existing corruption behavior, unchanged)
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
                warnings: vec![RecoveryWarning {
                    file_name: file_name.to_string(),
                    message: format!(
                        "This file was written by a newer version of termiHub (schema v{}). \
                         It was left unchanged to avoid data loss; changes made now will not be \
                         saved over it. Update termiHub to use this data.",
                        err.found
                    ),
                    details: Some(err.to_string()),
                }],
            })
        }
        LoadOutcome::Corrupt(detail) => {
            // Genuine corruption — back up and reset (pre-existing behavior).
            let backup = path.with_extension("json.bak");
            let _ = fs::copy(path, &backup);
            tracing::error!(
                "{file_name} is corrupt, backed up to {} and reset to defaults",
                backup.display()
            );
            let defaults = T::default();
            let pretty = serde_json::to_string_pretty(&defaults)
                .with_context(|| format!("Failed to serialize default {file_name}"))?;
            write_atomic(path, &pretty)
                .with_context(|| format!("Failed to write default {file_name} after recovery"))?;
            Ok(RecoveryResult {
                data: defaults,
                warnings: vec![RecoveryWarning {
                    file_name: file_name.to_string(),
                    message: format!("{file_name} was corrupt and has been reset to defaults."),
                    details: Some(detail),
                }],
            })
        }
    }
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
        assert_eq!(after, newer, "the newer file must be left byte-for-byte intact");
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
}
