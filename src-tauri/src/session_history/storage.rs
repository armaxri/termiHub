use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::SessionHistoryStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "session-history.json";

/// Handles reading/writing the session-history JSON file.
///
/// The file lives alongside `connections.json`/`macros.json` in the config
/// directory and is deliberately **separate** so session history is never
/// swept into connection export/import operations.
pub struct SessionHistoryStorage {
    file_path: PathBuf,
}

impl SessionHistoryStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set, it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery via the shared schema-migration layer.
    ///
    /// A current/older file is used as-is (or migrated forward), a **newer** file
    /// is left untouched and reported as a warning (never reset — PER-004), and
    /// only a genuinely unparseable file is backed up to `.bak` and reset.
    ///
    /// Legacy plugin connection-type ids in the loaded entries are rewritten to
    /// their stable `plugin:<plugin-id>:<type>` form (PLG-007).
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<SessionHistoryStore>> {
        let mut result =
            load_store_with_recovery::<SessionHistoryStore>(&self.file_path, FILE_NAME)?;
        if let Some(config_dir) = self.file_path.parent() {
            let resolver = crate::connection::plugin_type_ids::legacy_resolver(config_dir);
            migrate_entry_type_ids(&mut result.data, &resolver);
        }
        Ok(result)
    }

    /// Save the session-history store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file + rename) so an interrupted save cannot
    /// truncate the file into invalid JSON that the recovery path would then
    /// discard (PER-002 torn-write class). Before writing, [`guard_not_newer`]
    /// refuses to overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &SessionHistoryStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            SessionHistoryStore::STORE_NAME,
            SessionHistoryStore::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize session history")?;

        write_atomic(&self.file_path, &data).context("Failed to write session-history file")?;

        Ok(())
    }

    /// Create a storage instance for testing (bypasses Tauri AppHandle).
    #[cfg(test)]
    pub fn new_test(dir: &std::path::Path) -> Self {
        Self {
            file_path: dir.join(FILE_NAME),
        }
    }
}

/// Rewrite legacy plugin type ids in every history entry — its `connectionType`
/// and its `config.type` — and re-derive the dedup key of an entry that changed,
/// so a later session on the namespaced type collapses into it (PLG-007).
fn migrate_entry_type_ids(
    store: &mut SessionHistoryStore,
    resolver: &termihub_core::connection::LegacyTypeIdResolver,
) {
    use crate::connection::plugin_type_ids::{migrate_config_value, migrate_type_id};
    for entry in &mut store.entries {
        let what = format!("session-history entry \"{}\"", entry.title);
        let type_changed = migrate_type_id(&mut entry.connection_type, resolver, &what);
        let config_changed = migrate_config_value(&mut entry.config, resolver, &what);
        if type_changed || config_changed {
            entry.dedup_key =
                super::config::compute_dedup_key(&entry.connection_type, &entry.config);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_history::config::SessionHistoryEntry;
    use serde_json::json;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> SessionHistoryStorage {
        SessionHistoryStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_store() -> SessionHistoryStore {
        SessionHistoryStore {
            version: "1".to_string(),
            extra: Default::default(),
            entries: vec![SessionHistoryEntry {
                dedup_key: "ssh:admin@host:22".to_string(),
                title: "admin@host".to_string(),
                connection_type: "ssh".to_string(),
                config: json!({ "type": "ssh", "config": { "host": "host", "username": "admin" } }),
                first_used: 100,
                last_used: 200,
                use_count: 2,
                pinned: false,
                promoted: false,
            }],
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.entries.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.entries.len(), 1);
        assert_eq!(result.data.entries[0].title, "admin@host");
        assert_eq!(result.data.entries[0].use_count, 2);
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt history data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.entries.is_empty());

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid history entry and one
    /// corrupt entry keeps the valid entry and drops only the corrupt one.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let mut value = serde_json::to_value(sample_store()).unwrap();
        value["entries"]
            .as_array_mut()
            .unwrap()
            .push(json!("corrupt history entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.entries.len(), 1, "the valid entry survives");
        assert_eq!(result.data.entries[0].title, "admin@host");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 1"));

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.entries.len(), 1);
    }

    /// A successful atomic save must leave only the target file behind — no
    /// leftover temporary write artifacts in the config directory (PER-002).
    #[test]
    fn save_leaves_no_stray_files() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_store()).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![FILE_NAME.to_string()],
            "atomic save must leave only the target file, got {names:?}"
        );
    }

    /// Regression (PER-002): a save that cannot durably complete must fail
    /// **without** clobbering the previously-saved store. The old truncate-in-place
    /// `fs::write` succeeds here by overwriting the existing file, so this fails
    /// red on it; the atomic temp+rename write cannot create its temp file in a
    /// read-only directory and therefore leaves the prior file untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_store() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Seed a good, complete store and capture its exact on-disk bytes.
        storage.save(&sample_store()).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

        // Make the directory read-only so no new (temp) file can be created in it.
        let restore = fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        fs::set_permissions(dir.path(), ro).unwrap();

        // A privileged/root process can create files regardless of mode — skip.
        let probe = dir.path().join(".probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let result = storage.save(&SessionHistoryStore::default());

        // Restore permissions before asserting so TempDir can clean up.
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous store fully intact"
        );
        serde_json::from_str::<SessionHistoryStore>(&after).expect("preserved store still parses");
    }

    /// PLG-007: legacy plugin type ids in history entries are migrated on load,
    /// and the dedup key follows the new id.
    #[test]
    fn load_migrates_legacy_plugin_type_ids() {
        let dir = tempfile::TempDir::new().unwrap();
        crate::connection::plugin_type_ids::write_backend_plugin_manifest(
            dir.path(),
            "beta",
            "k8s",
        );
        let storage = SessionHistoryStorage::new_test(dir.path());
        let raw = serde_json::json!({
            "version": "1",
            "entries": [{
                "dedupKey": "k8s-beta:{\"pod\":\"p\"}",
                "title": "pod p",
                "connectionType": "k8s-beta",
                "config": { "type": "k8s-beta", "config": { "pod": "p" } },
                "firstUsed": 1,
                "lastUsed": 2
            }, {
                "dedupKey": "ssh:u@h:22",
                "title": "u@h",
                "connectionType": "ssh",
                "config": { "type": "ssh", "config": { "host": "h", "username": "u" } },
                "firstUsed": 1,
                "lastUsed": 2
            }]
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let store = storage.load_with_recovery().unwrap().data;
        let plugin = &store.entries[0];
        assert_eq!(plugin.connection_type, "plugin:beta:k8s");
        assert_eq!(plugin.config["type"], "plugin:beta:k8s");
        assert!(
            plugin.dedup_key.starts_with("plugin:beta:k8s:"),
            "{}",
            plugin.dedup_key
        );
        let ssh = &store.entries[1];
        assert_eq!(ssh.connection_type, "ssh");
        assert_eq!(ssh.dedup_key, "ssh:u@h:22");
    }
}
