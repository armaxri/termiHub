use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::recovery::{RecoveryResult, RecoveryWarning};

const FILE_NAME: &str = "settings.json";

/// Configuration for a single external connection file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalFileConfig {
    pub path: String,
    pub enabled: bool,
}

/// Helper for serde default that returns `true`.
fn default_true() -> bool {
    true
}

/// Layout configuration for UI section positioning and visibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutConfig {
    pub activity_bar_position: String,
    pub sidebar_position: String,
    pub sidebar_visible: bool,
    pub status_bar_visible: bool,
}

/// Application-wide settings persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub version: String,
    pub external_connection_files: Vec<ExternalFileConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ssh_key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_horizontal_scrolling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrollback_buffer: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    #[serde(default = "default_true")]
    pub power_monitoring_enabled: bool,
    #[serde(default = "default_true")]
    pub file_browser_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<LayoutConfig>,
    /// Credential storage mode: "keychain", "master_password", or "none".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_storage_mode: Option<String>,
    /// Auto-lock timeout in minutes for master password mode. None = never.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_auto_lock_minutes: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            external_connection_files: Vec::new(),
            default_user: None,
            default_ssh_key_path: None,
            default_shell: None,
            theme: None,
            font_family: None,
            font_size: None,
            default_horizontal_scrolling: None,
            scrollback_buffer: None,
            cursor_style: None,
            cursor_blink: None,
            power_monitoring_enabled: true,
            file_browser_enabled: true,
            layout: None,
            credential_storage_mode: None,
            credential_auto_lock_minutes: None,
        }
    }
}

/// Handles reading/writing the settings JSON file.
pub struct SettingsStorage {
    file_path: PathBuf,
}

impl SettingsStorage {
    /// Create a new settings storage instance, resolving the config directory.
    ///
    /// Uses the same directory as `ConnectionStorage` (respects `TERMIHUB_CONFIG_DIR`).
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => app_handle
                .path()
                .app_config_dir()
                .context("Failed to resolve app config directory")?,
        };

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load with recovery: on parse failure, backs up the corrupt file and resets to defaults.
    ///
    /// Since `AppSettings` uses `#[serde(default)]`, partial field corruption is handled
    /// by serde itself. Only completely unparseable files need recovery here.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<AppSettings>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: AppSettings::default(),
                warnings: Vec::new(),
            });
        }

        let data = fs::read_to_string(&self.file_path).context("Failed to read settings file")?;

        // Fast path: normal parse succeeds
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&data) {
            return Ok(RecoveryResult {
                data: settings,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Settings file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<AppSettings>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Settings file was corrupt and has been reset to defaults.".to_string(),
            details: parse_error,
        };
        tracing::error!("Settings file corrupt, resetting to defaults");

        let defaults = AppSettings::default();
        self.save(&defaults)
            .context("Failed to save default settings after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save settings to disk (pretty-printed JSON).
    pub fn save(&self, settings: &AppSettings) -> Result<()> {
        let data =
            serde_json::to_string_pretty(settings).context("Failed to serialize settings")?;

        fs::write(&self.file_path, data).context("Failed to write settings file")?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> SettingsStorage {
        SettingsStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.version, "1");
        assert!(result.data.power_monitoring_enabled);
    }

    #[test]
    fn load_with_recovery_valid_settings() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let settings = AppSettings {
            theme: Some("dark".to_string()),
            ..Default::default()
        };
        storage.save(&settings).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.theme.as_deref(), Some("dark"));
    }

    #[test]
    fn load_with_recovery_corrupt_settings() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        std::fs::write(&storage.file_path, "not valid json {{{").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.warnings[0].details.is_some());
        // Returns defaults
        assert_eq!(result.data.version, "1");
        assert!(result.data.power_monitoring_enabled);

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "not valid json {{{"
        );
    }

    #[test]
    fn deserialize_legacy_json_without_new_fields() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.version, "1");
        assert!(settings.external_connection_files.is_empty());
        assert!(settings.default_user.is_none());
        assert!(settings.font_size.is_none());
        assert!(settings.cursor_blink.is_none());
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
        assert!(settings.credential_storage_mode.is_none());
        assert!(settings.credential_auto_lock_minutes.is_none());
    }

    #[test]
    fn deserialize_with_new_fields() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "defaultUser": "admin",
            "fontSize": 16,
            "cursorStyle": "underline",
            "cursorBlink": false,
            "scrollbackBuffer": 10000,
            "defaultHorizontalScrolling": true
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.default_user.as_deref(), Some("admin"));
        assert_eq!(settings.font_size, Some(16));
        assert_eq!(settings.cursor_style.as_deref(), Some("underline"));
        assert_eq!(settings.cursor_blink, Some(false));
        assert_eq!(settings.scrollback_buffer, Some(10000));
        assert_eq!(settings.default_horizontal_scrolling, Some(true));
    }

    #[test]
    fn default_settings_have_features_enabled() {
        let settings = AppSettings::default();
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
    }

    #[test]
    fn backward_compat_deserializes_missing_fields_as_true() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
    }

    #[test]
    fn deserializes_explicit_false_values() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "powerMonitoringEnabled": false,
            "fileBrowserEnabled": false
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(!settings.power_monitoring_enabled);
        assert!(!settings.file_browser_enabled);
    }

    #[test]
    fn deserialize_without_layout_field() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.layout.is_none());
    }

    #[test]
    fn deserialize_with_layout_field() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "layout": {
                "activityBarPosition": "right",
                "sidebarPosition": "left",
                "sidebarVisible": true,
                "statusBarVisible": false
            }
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        let layout = settings.layout.unwrap();
        assert_eq!(layout.activity_bar_position, "right");
        assert!(!layout.status_bar_visible);
    }

    #[test]
    fn deserialize_without_credential_fields() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.credential_storage_mode.is_none());
        assert!(settings.credential_auto_lock_minutes.is_none());
    }

    #[test]
    fn deserialize_with_credential_fields() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "credentialStorageMode": "keychain",
            "credentialAutoLockMinutes": 15
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.credential_storage_mode.as_deref(),
            Some("keychain")
        );
        assert_eq!(settings.credential_auto_lock_minutes, Some(15));
    }

    #[test]
    fn credential_fields_round_trip_all_modes() {
        for mode in &["keychain", "master_password", "none"] {
            let settings = AppSettings {
                credential_storage_mode: Some(mode.to_string()),
                credential_auto_lock_minutes: Some(30),
                ..Default::default()
            };

            let json = serde_json::to_string(&settings).unwrap();
            let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

            assert_eq!(deserialized.credential_storage_mode.as_deref(), Some(*mode));
            assert_eq!(deserialized.credential_auto_lock_minutes, Some(30));
        }
    }

    #[test]
    fn credential_none_values_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("credentialStorageMode"));
        assert!(!json.contains("credentialAutoLockMinutes"));
    }

    #[test]
    fn round_trip_serialization() {
        let settings = AppSettings {
            default_user: Some("testuser".to_string()),
            font_family: Some("Fira Code".to_string()),
            font_size: Some(18),
            theme: Some("light".to_string()),
            power_monitoring_enabled: false,
            ..Default::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.default_user.as_deref(), Some("testuser"));
        assert_eq!(deserialized.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(deserialized.font_size, Some(18));
        assert_eq!(deserialized.theme.as_deref(), Some("light"));
        assert!(!deserialized.power_monitoring_enabled);
        assert!(deserialized.file_browser_enabled);
        // Fields left as None should not appear in JSON
        assert!(!json.contains("cursorBlink"));
        assert!(!json.contains("scrollbackBuffer"));
    }
}
