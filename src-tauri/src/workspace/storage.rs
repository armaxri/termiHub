use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::WorkspaceStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "workspaces.json";

/// Handles reading/writing the workspaces JSON file.
pub struct WorkspaceStorage {
    file_path: PathBuf,
}

impl WorkspaceStorage {
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
    /// Reads the on-disk `version` first: a current/older file is used as-is (or
    /// migrated forward), a **newer** file is left untouched and reported as a
    /// warning (never reset — PER-004), and only a genuinely unparseable file is
    /// backed up to `.bak` and reset to defaults.
    ///
    /// Legacy plugin connection-type ids in tabs' inline configs are rewritten to
    /// their stable `plugin:<plugin-id>:<type>` form (PLG-007).
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<WorkspaceStore>> {
        let mut result = load_store_with_recovery::<WorkspaceStore>(&self.file_path, FILE_NAME)?;
        if let Some(config_dir) = self.file_path.parent() {
            let resolver = crate::connection::plugin_type_ids::legacy_resolver(config_dir);
            for ws in &mut result.data.workspaces {
                let what = format!("workspace \"{}\"", ws.name);
                crate::connection::plugin_type_ids::migrate_tab_groups(
                    &mut ws.tab_groups,
                    &resolver,
                    &what,
                );
            }
        }
        Ok(result)
    }

    /// The PLG-007 legacy plugin type-id resolver for this store's config
    /// directory, used to resolve imported workspaces' inline configs (#3343).
    pub fn legacy_type_resolver(&self) -> Option<termihub_core::connection::LegacyTypeIdResolver> {
        crate::connection::plugin_type_ids::legacy_resolver_beside(&self.file_path)
    }

    /// Save the workspace store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file in the same directory + rename), so an
    /// interrupted save can never truncate the existing store and lose every
    /// saved workspace (#2318). Before writing, [`guard_not_newer`] refuses to
    /// overwrite a file written by a newer schema version (PER-004).
    pub fn save(&self, store: &WorkspaceStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            WorkspaceStore::STORE_NAME,
            WorkspaceStore::CURRENT_VERSION,
        )?;

        let data = serde_json::to_string_pretty(store).context("Failed to serialize workspaces")?;

        write_atomic(&self.file_path, &data).context("Failed to write workspaces file")?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> WorkspaceStorage {
        WorkspaceStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.workspaces.is_empty());
    }

    #[test]
    fn load_with_recovery_valid_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = WorkspaceStore::default();
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt workspace data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.workspaces.is_empty());

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid workspace and one corrupt
    /// entry keeps the valid workspace and drops only the corrupt one (rather
    /// than resetting every saved workspace).
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // A valid single-workspace store, then a corrupt (non-object) entry
        // appended so the whole-file parse fails but the good one is salvageable.
        let mut value: serde_json::Value = serde_json::from_str(
            r#"{"version":"1","workspaces":[{"id":"ws-1","name":"Work","tabGroups":[]}]}"#,
        )
        .unwrap();
        value["workspaces"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt workspace entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(
            result.data.workspaces.len(),
            1,
            "the valid workspace survives"
        );
        assert_eq!(result.data.workspaces[0].id, "ws-1");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 1"));

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.workspaces.len(), 1);
    }

    /// PER-004 (the real downgrade hazard): a workspaces file written by a NEWER
    /// schema version whose *structure* an older build cannot parse must never be
    /// wiped. Here `workspaces` is no longer an array — the old fast-path typed
    /// parse fails, and the pre-fix code would treat that as corruption, back it
    /// up to `.bak`, and overwrite the live file with empty defaults (silent total
    /// data loss on a rollback). The version gate now catches `version > current`
    /// *before* the typed parse, so the file is left byte-for-byte intact with no
    /// `.bak`, the load runs on defaults in memory, and a warning is surfaced.
    #[test]
    fn newer_version_file_is_not_wiped_on_load() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        // version newer than current AND a shape this build can't deserialize.
        let newer = r#"{"version":"99","workspaces":{"v100":"restructured"}}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1, "a newer file surfaces a warning");
        assert!(result.data.workspaces.is_empty(), "runs on defaults");

        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(after, newer, "the newer file must be left intact");
        assert!(
            !storage.file_path.with_extension("json.bak").exists(),
            "a newer file must never be backed up/reset"
        );
    }

    /// PER-004 (write side): a save must refuse to overwrite a newer file and
    /// leave it intact, so an in-version change can't clobber future data.
    #[test]
    fn save_refuses_to_overwrite_newer_file() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let newer = r#"{"version":"99","workspaces":[]}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.save(&WorkspaceStore::default());
        assert!(result.is_err(), "saving over a newer file must fail");
        assert_eq!(
            fs::read_to_string(&storage.file_path).unwrap(),
            newer,
            "the newer file must be untouched"
        );
    }

    /// PER-010: an unknown top-level field survives a load -> save round-trip
    /// instead of being silently dropped by the typed struct.
    #[test]
    fn unknown_field_survives_load_save_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        // Same current version, but with an extra field a newer build added.
        fs::write(
            &storage.file_path,
            r#"{"version":"1","workspaces":[],"experimentalFlag":{"on":true}}"#,
        )
        .unwrap();

        let loaded = storage.load_with_recovery().unwrap().data;
        storage.save(&loaded).unwrap();

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        assert_eq!(
            after.get("experimentalFlag"),
            Some(&serde_json::json!({"on": true})),
            "unknown field must survive the round-trip"
        );
    }

    /// A successful atomic save must leave only the target file behind — no
    /// leftover temporary write artifacts in the config directory.
    #[test]
    fn save_leaves_no_stray_files() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&WorkspaceStore::default()).unwrap();

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

    /// Regression (#2318): a save that cannot durably complete must fail
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
        storage.save(&WorkspaceStore::default()).unwrap();
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

        let updated = WorkspaceStore {
            version: "2".to_string(),
            workspaces: Vec::new(),
            extra: Default::default(),
        };
        let result = storage.save(&updated);

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
        // And the preserved file must still be valid JSON.
        serde_json::from_str::<WorkspaceStore>(&after).expect("preserved store still parses");
    }

    /// PLG-007: a legacy plugin type id in a tab's inline config is migrated to
    /// the namespaced id on load.
    #[test]
    fn load_migrates_legacy_plugin_type_ids_in_inline_configs() {
        let dir = TempDir::new().unwrap();
        crate::connection::plugin_type_ids::write_backend_plugin_manifest(
            dir.path(),
            "beta",
            "k8s",
        );
        let storage = create_test_storage(&dir);
        let raw = serde_json::json!({
            "version": "1",
            "workspaces": [{
                "id": "w1",
                "name": "K8s",
                "tabGroups": [{
                    "name": "Main",
                    "layout": { "type": "leaf", "tabs": [
                        { "inlineConfig": { "type": "k8s", "config": { "pod": "p" } } }
                    ] }
                }]
            }]
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let store = storage.load_with_recovery().unwrap().data;
        let crate::workspace::config::WorkspaceLayoutNode::Leaf { tabs } =
            &store.workspaces[0].tab_groups[0].layout
        else {
            panic!("leaf expected");
        };
        assert_eq!(
            tabs[0].inline_config.as_ref().unwrap()["type"],
            "plugin:beta:k8s"
        );
    }
}
