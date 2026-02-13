use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "settings.json";

/// Configuration for a single external connection file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalFileConfig {
    pub path: String,
    pub enabled: bool,
}

/// Application-wide settings persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub version: String,
    pub external_connection_files: Vec<ExternalFileConfig>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            external_connection_files: Vec::new(),
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

        fs::create_dir_all(&config_dir)
            .context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load settings from disk. Returns defaults if the file doesn't exist.
    pub fn load(&self) -> Result<AppSettings> {
        if !self.file_path.exists() {
            return Ok(AppSettings::default());
        }

        let data = fs::read_to_string(&self.file_path)
            .context("Failed to read settings file")?;

        let settings: AppSettings = serde_json::from_str(&data)
            .context("Failed to parse settings file")?;

        Ok(settings)
    }

    /// Save settings to disk (pretty-printed JSON).
    pub fn save(&self, settings: &AppSettings) -> Result<()> {
        let data = serde_json::to_string_pretty(settings)
            .context("Failed to serialize settings")?;

        fs::write(&self.file_path, data)
            .context("Failed to write settings file")?;

        Ok(())
    }
}
