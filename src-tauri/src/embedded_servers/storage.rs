use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{EmbeddedServerConfig, EmbeddedServerStore};
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{salvage_list_store, Salvage};

const FILE_NAME: &str = "embedded_servers.json";

/// Handles reading/writing the embedded_servers.json configuration file.
pub struct EmbeddedServerStorage {
    file_path: PathBuf,
}

impl EmbeddedServerStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery: on parse failure, back up the corrupt file and reset to defaults.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<EmbeddedServerStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: EmbeddedServerStore::default(),
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read embedded servers file")?;

        if let Ok(store) = serde_json::from_str::<EmbeddedServerStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up the corrupt file first.
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Embedded servers file is corrupt, backed up to {}",
            backup_path.display()
        );

        // Granular recovery (PER-004): drop only the individually-corrupt server
        // entries and keep the rest; reset the whole store only when even the
        // container is unparseable.
        if let Salvage::Recovered {
            data: store,
            warnings,
        } = salvage_list_store::<EmbeddedServerStore, EmbeddedServerConfig>(
            &data, FILE_NAME, "servers",
        ) {
            self.save(&store)
                .context("Failed to save salvaged embedded servers")?;
            return Ok(RecoveryResult {
                data: store,
                warnings,
            });
        }

        let parse_error = serde_json::from_str::<EmbeddedServerStore>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Embedded servers file was corrupt and has been reset.".to_string(),
            details: parse_error,
        };

        let defaults = EmbeddedServerStore::default();
        self.save(&defaults)
            .context("Failed to save defaults after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save the store to disk as pretty-printed JSON.
    ///
    /// The write is **atomic** (temp file in the same directory → `sync_all` →
    /// rename over the target): a crash, power loss, or full disk mid-write
    /// leaves `embedded_servers.json` holding either the complete previous
    /// contents or the complete new contents, never a truncated mix that the
    /// recovery path would discard as corrupt (#2320 torn-write class, #2327).
    pub fn save(&self, store: &EmbeddedServerStore) -> Result<()> {
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize embedded servers")?;
        write_atomic(&self.file_path, &data).context("Failed to write embedded servers file")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> EmbeddedServerStorage {
        EmbeddedServerStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    #[test]
    fn save_and_reload() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let store = EmbeddedServerStore::default();
        storage.save(&store).unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    /// Regression (#2327): a `save` that cannot durably complete must fail
    /// **without** clobbering the previously-saved servers. The old
    /// truncate-in-place `fs::write` opens the existing file for writing (which a
    /// read-only *directory* does not block) and reports success, so this test
    /// fails red on it; the atomic temp+rename write cannot create its temp file
    /// in a read-only directory and therefore errors while leaving the prior
    /// `embedded_servers.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_servers() {
        use super::super::config::{EmbeddedServerConfig, ServerType};
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = EmbeddedServerStore {
            version: "1".to_string(),
            servers: vec![EmbeddedServerConfig {
                id: "srv-1".to_string(),
                name: "docs".to_string(),
                server_type: ServerType::Http,
                root_directory: "/tmp/docs".to_string(),
                bind_host: "127.0.0.1".to_string(),
                port: 8080,
                auto_start: false,
                read_only: true,
                directory_listing: Some(true),
                ftp_auth: None,
                http_auth: None,
                max_transfer_bytes: None,
            }],
        };
        storage.save(&store).unwrap();
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

        let result = storage.save(&store);
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous servers fully intact"
        );
        serde_json::from_str::<EmbeddedServerStore>(&after).expect("preserved store still parses");
    }

    #[test]
    fn corrupt_file_triggers_recovery() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "not valid json!!!").unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.servers.is_empty());
        // Backup should exist.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid server and one corrupt
    /// entry keeps the valid server and drops only the corrupt one (rather than
    /// resetting every embedded server the user configured).
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        use super::super::config::{EmbeddedServerConfig, ServerType};

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let good = EmbeddedServerStore {
            version: "1".to_string(),
            servers: vec![EmbeddedServerConfig {
                id: "srv-1".to_string(),
                name: "docs".to_string(),
                server_type: ServerType::Http,
                root_directory: "/tmp/docs".to_string(),
                bind_host: "127.0.0.1".to_string(),
                port: 8080,
                auto_start: false,
                read_only: true,
                directory_listing: Some(true),
                ftp_auth: None,
                http_auth: None,
                max_transfer_bytes: None,
            }],
        };
        // Serialize the valid store, then append a corrupt (non-object) entry so
        // the whole-file parse fails but the good server can still be salvaged.
        let mut value = serde_json::to_value(&good).unwrap();
        value["servers"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt server entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.servers.len(), 1, "the valid server survives");
        assert_eq!(result.data.servers[0].id, "srv-1");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 1"));

        // The corrupt file must have been backed up.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        // The rewritten file must now parse cleanly and hold only the survivor.
        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.servers.len(), 1);
    }
}
