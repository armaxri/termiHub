use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::TunnelStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "tunnels.json";

/// Handles reading/writing the tunnels JSON file.
pub struct TunnelStorage {
    file_path: PathBuf,
}

impl TunnelStorage {
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

    /// Load through the shared schema-version gate
    /// ([`load_store_with_recovery`], PER2-002): a newer file is left intact and
    /// reported, an older one migrates, and a corrupt one is backed up to a
    /// fresh `.bak` and salvaged per entry — rewritten only once the backup is
    /// safely on disk.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<TunnelStore>> {
        load_store_with_recovery::<TunnelStore>(&self.file_path, FILE_NAME)
    }

    /// Save the tunnel store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file in the same directory + rename), so an
    /// interrupted save can never truncate the existing file and lose the saved
    /// tunnels (same data-loss class as PER-002/PER-003).
    ///
    /// Before writing, [`guard_not_newer`] refuses to overwrite a file written
    /// by a newer schema version (PER2-002).
    pub fn save(&self, store: &TunnelStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            <TunnelStore as VersionedStore>::STORE_NAME,
            <TunnelStore as VersionedStore>::CURRENT_VERSION,
        )?;
        let data = serde_json::to_string_pretty(store).context("Failed to serialize tunnels")?;

        write_atomic(&self.file_path, &data).context("Failed to write tunnels file")?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> TunnelStorage {
        TunnelStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.tunnels.is_empty());
    }

    #[test]
    fn load_with_recovery_valid_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = TunnelStore::default();
        storage.save(&store).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn load_with_recovery_corrupt_json() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "corrupt tunnel data!!!").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.tunnels.is_empty());

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid tunnel and one corrupt
    /// entry keeps the valid tunnel and drops only the corrupt one.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        use super::super::config::{TunnelConfig, TunnelType};
        use termihub_core::tunnel::config::LocalForwardConfig;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let good = TunnelStore {
            version: "1".to_string(),
            extra: Default::default(),
            tunnels: vec![TunnelConfig {
                id: "tun-1".to_string(),
                name: "db".to_string(),
                ssh_connection_id: "conn-1".to_string(),
                tunnel_type: TunnelType::Local(LocalForwardConfig {
                    local_host: "127.0.0.1".to_string(),
                    local_port: 5432,
                    remote_host: "db.internal".to_string(),
                    remote_port: 5432,
                }),
                host: Default::default(),
                auto_start: false,
                start_with_connection: false,
                reconnect_on_disconnect: false,
                companion_of: None,
            }],
        };
        let mut value = serde_json::to_value(&good).unwrap();
        value["tunnels"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt tunnel entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.tunnels.len(), 1, "the valid tunnel survives");
        assert_eq!(result.data.tunnels[0].id, "tun-1");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 1"));

        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.tunnels.len(), 1);
    }

    /// A successful atomic save must leave only the target file behind — no
    /// leftover temporary write artifacts in the config directory.
    #[test]
    fn save_leaves_no_stray_files() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&TunnelStore::default()).unwrap();

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

    /// Regression: a save that cannot durably complete must fail **without**
    /// clobbering the previously-saved store. The old truncate-in-place
    /// `fs::write` succeeds here by overwriting the existing file, so this fails
    /// red on it; the atomic temp+rename write cannot create its temp file in a
    /// read-only directory and therefore leaves the prior file untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_store() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&TunnelStore::default()).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

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

        let result = storage.save(&TunnelStore::default());

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
        serde_json::from_str::<TunnelStore>(&after).expect("preserved store still parses");
    }
    /// PER2-002: a tunnels.json written by a NEWER schema is refused, not
    /// treated as corrupt: load runs on defaults with a warning, leaves the file
    /// byte-for-byte intact (no backup), and a later save refuses to clobber it.
    #[test]
    fn newer_version_file_is_left_intact() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let newer = r#"{"version":"99","tunnels":{"restructured":true}}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("newer version"));
        assert!(result.data.tunnels.is_empty());

        let err = storage.save(&TunnelStore::default()).unwrap_err();
        assert!(err.to_string().contains("newer version"), "{err}");

        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
        assert!(!storage.file_path.with_extension("json.bak").exists());
    }

    /// PER2-002: unknown top-level fields survive a load → save round-trip.
    #[test]
    fn unknown_top_level_fields_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(
            &storage.file_path,
            r#"{"version":"1","tunnels":[],"futureField":{"nested":true}}"#,
        )
        .unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.warnings.is_empty());
        storage.save(&loaded.data).unwrap();

        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        assert_eq!(
            on_disk["futureField"],
            serde_json::json!({"nested": true}),
            "unknown field must be written back out"
        );
    }

    /// ERR2-002: a second corruption never overwrites the first backup.
    #[test]
    fn second_corruption_keeps_earlier_backup() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let backup = storage.file_path.with_extension("json.bak");
        fs::write(&backup, "earlier backup").unwrap();
        fs::write(&storage.file_path, "corrupt again!!!").unwrap();

        storage.load_with_recovery().unwrap();

        assert_eq!(fs::read_to_string(&backup).unwrap(), "earlier backup");
        let second = dir.path().join("tunnels.json.bak.1");
        assert_eq!(fs::read_to_string(second).unwrap(), "corrupt again!!!");
    }
}
