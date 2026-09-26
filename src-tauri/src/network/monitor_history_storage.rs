//! On-disk storage for the HTTP monitor check history (#3462).

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::monitor_history::HttpMonitorHistoryStore;
use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

const FILE_NAME: &str = "http-monitor-history.json";

/// Handles reading/writing the HTTP monitor check-history JSON file (#3462).
/// Mirrors [`super::tool_history_storage::NetworkToolHistoryStorage`].
pub struct HttpMonitorHistoryStorage {
    file_path: PathBuf,
}

impl HttpMonitorHistoryStorage {
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
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<HttpMonitorHistoryStore>> {
        load_store_with_recovery::<HttpMonitorHistoryStore>(&self.file_path, FILE_NAME)
    }

    /// Save the check-history store to disk.
    ///
    /// Written as **compact** JSON (unlike the small config stores): a time
    /// series is thousands of tiny records, and pretty-printing would roughly
    /// double the file. The write is atomic (temp file + rename) so an
    /// interrupted save cannot truncate the history (PER-003), and
    /// [`guard_not_newer`] refuses to overwrite a newer schema's file (PER-004).
    pub fn save(&self, store: &HttpMonitorHistoryStore) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            HttpMonitorHistoryStore::STORE_NAME,
            HttpMonitorHistoryStore::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string(store).context("Failed to serialize HTTP monitor history")?;

        write_atomic(&self.file_path, &data)
            .context("Failed to write HTTP monitor history file")?;

        Ok(())
    }

    /// Create a storage instance for testing (bypasses Tauri AppHandle).
    #[cfg(test)]
    pub fn new_test(dir: &std::path::Path) -> Self {
        Self {
            file_path: dir.join(FILE_NAME),
        }
    }

    /// The backing file path (tests only).
    #[cfg(test)]
    pub fn file_path(&self) -> &std::path::Path {
        &self.file_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::monitor_history::{HttpMonitorCheck, HttpMonitorSeries};
    use tempfile::TempDir;

    fn check(ts: u64) -> HttpMonitorCheck {
        HttpMonitorCheck {
            timestamp_ms: ts,
            status_code: Some(200),
            latency_ms: Some(10),
            ok: true,
            error: None,
        }
    }

    fn sample_store() -> HttpMonitorHistoryStore {
        HttpMonitorHistoryStore {
            monitors: vec![
                HttpMonitorSeries {
                    id: "mon-1".into(),
                    checks: vec![check(1), check(2)],
                },
                HttpMonitorSeries {
                    id: "mon-2".into(),
                    checks: vec![check(3)],
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.monitors.is_empty());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        storage.save(&sample_store()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.monitors, sample_store().monitors);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_reset() {
        let dir = TempDir::new().unwrap();
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        fs::write(&storage.file_path, "not json at all").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.data.monitors.is_empty());
        assert!(storage.file_path.with_extension("json.bak").exists());
    }

    /// PER-004 granular salvage: one corrupt series is dropped, the rest survive.
    #[test]
    fn corrupt_series_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        let mut value = serde_json::to_value(sample_store()).unwrap();
        value["monitors"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id": "broken", "checks": [{"ok": "nope"}]}));
        fs::write(&storage.file_path, value.to_string()).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.monitors.len(), 2);
        assert_eq!(result.warnings.len(), 1);
    }

    /// Downgrade safety (PER-004): a file from a newer schema is neither reset
    /// on load nor overwritten on save.
    #[test]
    fn newer_file_is_left_intact() {
        let dir = TempDir::new().unwrap();
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        let newer = r#"{"version": "99", "monitors": [], "fromTheFuture": true}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.data.monitors.is_empty());
        assert!(!loaded.warnings.is_empty(), "the newer file is reported");

        assert!(storage.save(&sample_store()).is_err());
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
    }
}
