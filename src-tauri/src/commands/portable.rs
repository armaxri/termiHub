use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::utils::portable::AppMode;

/// Frontend-facing representation of the current app mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppModeInfo {
    pub is_portable: bool,
    /// Absolute path to the portable data directory, or `null` in installed mode.
    pub data_dir: Option<String>,
}

impl From<&AppMode> for AppModeInfo {
    fn from(mode: &AppMode) -> Self {
        match mode {
            AppMode::Portable { data_dir } => AppModeInfo {
                is_portable: true,
                data_dir: Some(data_dir.to_string_lossy().into_owned()),
            },
            AppMode::Installed => AppModeInfo {
                is_portable: false,
                data_dir: None,
            },
        }
    }
}

/// Files that can be included in a config migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileStatus {
    pub name: String,
    pub present: bool,
}

/// Result of a config export or import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMigrationResult {
    pub files_copied: Vec<String>,
    pub warnings: Vec<String>,
}

/// Return the current app mode (portable vs. installed) with the data directory path.
#[tauri::command]
pub fn get_app_mode(app_mode: tauri::State<'_, AppMode>) -> AppModeInfo {
    AppModeInfo::from(app_mode.inner())
}

/// List config files present in a given directory.
#[tauri::command]
pub fn list_config_files(dir: String) -> Vec<ConfigFileStatus> {
    let base = PathBuf::from(&dir);
    let known = &[
        "connections.json",
        "settings.json",
        "tunnels.json",
        "credentials.enc",
        "workspaces.json",
    ];
    known
        .iter()
        .map(|name| ConfigFileStatus {
            name: name.to_string(),
            present: base.join(name).exists(),
        })
        .collect()
}

/// Resolve a `{PORTABLE_DIR}` placeholder in a path string.
///
/// Returns the path with the placeholder replaced by the actual portable
/// base directory, or the original string if not in portable mode.
#[tauri::command]
pub fn resolve_portable_path_cmd(path: String, app_mode: tauri::State<'_, AppMode>) -> String {
    crate::utils::portable::resolve_portable_path(&path, app_mode.inner())
        .to_string_lossy()
        .into_owned()
}

/// Copy config files from `src_dir` to `dest_dir`.
///
/// Only copies files that exist in `src_dir`. Returns the list of copied
/// file names and any non-fatal warnings.
#[tauri::command]
pub fn export_config(
    src_dir: String,
    dest_dir: String,
    files: Vec<String>,
) -> Result<ConfigMigrationResult, String> {
    let src = PathBuf::from(&src_dir);
    let dest = PathBuf::from(&dest_dir);

    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create destination directory: {e}"))?;

    let mut files_copied = Vec::new();
    let mut warnings = Vec::new();

    for name in &files {
        let src_file = src.join(name);
        if !src_file.exists() {
            warnings.push(format!("{name}: not found in source, skipped"));
            continue;
        }
        let dest_file = dest.join(name);
        std::fs::copy(&src_file, &dest_file).map_err(|e| format!("Failed to copy {name}: {e}"))?;
        files_copied.push(name.clone());
    }

    Ok(ConfigMigrationResult {
        files_copied,
        warnings,
    })
}

/// Export the currently active config to a portable `data/` directory.
///
/// Copies the selected config files from the current config directory to
/// `dest_dir`. Intended to be called when running in installed mode.
#[tauri::command]
pub fn export_config_to_portable(
    app_handle: AppHandle,
    dest_dir: String,
    files: Vec<String>,
) -> Result<ConfigMigrationResult, String> {
    let src_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
        Ok(dir) => dir,
        Err(_) => app_handle
            .path()
            .app_config_dir()
            .map_err(|e| format!("Failed to resolve config directory: {e}"))?
            .to_string_lossy()
            .into_owned(),
    };

    export_config(src_dir, dest_dir, files)
}

/// Import config from a portable `data/` directory into the current config directory.
///
/// Copies the selected config files from `src_dir` to the current config
/// directory. Intended to be called when running in installed mode.
#[tauri::command]
pub fn import_config_from_portable(
    app_handle: AppHandle,
    src_dir: String,
    files: Vec<String>,
) -> Result<ConfigMigrationResult, String> {
    let dest_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
        Ok(dir) => dir,
        Err(_) => app_handle
            .path()
            .app_config_dir()
            .map_err(|e| format!("Failed to resolve config directory: {e}"))?
            .to_string_lossy()
            .into_owned(),
    };

    export_config(src_dir, dest_dir, files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn app_mode_info_from_installed() {
        let info = AppModeInfo::from(&AppMode::Installed);
        assert!(!info.is_portable);
        assert!(info.data_dir.is_none());
    }

    #[test]
    fn app_mode_info_from_portable() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("/usb/termiHub/data"),
        };
        let info = AppModeInfo::from(&mode);
        assert!(info.is_portable);
        assert_eq!(info.data_dir.as_deref(), Some("/usb/termiHub/data"));
    }

    #[test]
    fn list_config_files_shows_present_and_missing() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("connections.json"), "[]").unwrap();
        std::fs::write(dir.path().join("settings.json"), "{}").unwrap();

        let files = list_config_files(dir.path().to_string_lossy().into_owned());
        let connections = files.iter().find(|f| f.name == "connections.json").unwrap();
        let settings = files.iter().find(|f| f.name == "settings.json").unwrap();
        let credentials = files.iter().find(|f| f.name == "credentials.enc").unwrap();

        assert!(connections.present);
        assert!(settings.present);
        assert!(!credentials.present);
    }

    #[test]
    fn export_config_copies_existing_files() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();

        std::fs::write(src.path().join("connections.json"), "[1,2,3]").unwrap();
        std::fs::write(src.path().join("settings.json"), "{\"v\":1}").unwrap();

        let result = export_config(
            src.path().to_string_lossy().into_owned(),
            dest.path().to_string_lossy().into_owned(),
            vec!["connections.json".to_string(), "settings.json".to_string()],
        )
        .unwrap();

        assert_eq!(result.files_copied.len(), 2);
        assert!(result.warnings.is_empty());
        assert!(dest.path().join("connections.json").exists());
        assert!(dest.path().join("settings.json").exists());
    }

    #[test]
    fn export_config_warns_on_missing_files() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();

        let result = export_config(
            src.path().to_string_lossy().into_owned(),
            dest.path().to_string_lossy().into_owned(),
            vec!["credentials.enc".to_string()],
        )
        .unwrap();

        assert!(result.files_copied.is_empty());
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("not found"));
    }
}
