use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::TunnelStore;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;

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

    /// Load with recovery: on parse failure, backs up the corrupt file and resets to defaults.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<TunnelStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: TunnelStore::default(),
                warnings: Vec::new(),
            });
        }

        let data = fs::read_to_string(&self.file_path).context("Failed to read tunnels file")?;

        // Fast path: normal parse succeeds
        if let Ok(store) = serde_json::from_str::<TunnelStore>(&data) {
            return Ok(RecoveryResult {
                data: store,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Tunnels file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<TunnelStore>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Tunnels file was corrupt and has been reset.".to_string(),
            details: parse_error,
        };
        tracing::error!("Tunnels file corrupt, resetting to defaults");

        let defaults = TunnelStore::default();
        self.save(&defaults)
            .context("Failed to save default tunnels after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save the tunnel store to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file in the same directory + rename), so an
    /// interrupted save can never truncate the existing file and lose the saved
    /// tunnels (same data-loss class as PER-002/PER-003).
    pub fn save(&self, store: &TunnelStore) -> Result<()> {
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
}
