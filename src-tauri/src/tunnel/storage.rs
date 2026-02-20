use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use super::config::TunnelStore;

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

    /// Load the tunnel store from disk. Returns an empty store if the file doesn't exist.
    pub fn load(&self) -> Result<TunnelStore> {
        if !self.file_path.exists() {
            return Ok(TunnelStore::default());
        }

        let data = fs::read_to_string(&self.file_path).context("Failed to read tunnels file")?;

        let store: TunnelStore =
            serde_json::from_str(&data).context("Failed to parse tunnels file")?;

        Ok(store)
    }

    /// Save the tunnel store to disk (pretty-printed JSON).
    pub fn save(&self, store: &TunnelStore) -> Result<()> {
        let data = serde_json::to_string_pretty(store).context("Failed to serialize tunnels")?;

        fs::write(&self.file_path, data).context("Failed to write tunnels file")?;

        Ok(())
    }
}
