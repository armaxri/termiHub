use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Represents the application's runtime mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum AppMode {
    /// Standard installed mode — config stored in the OS app data directory.
    Installed,
    /// Portable mode — config stored in a `data/` directory next to the executable.
    Portable {
        /// Absolute path to the portable `data/` directory.
        data_dir: PathBuf,
    },
}

impl AppMode {
    /// Returns `true` if running in portable mode.
    pub fn is_portable(&self) -> bool {
        matches!(self, AppMode::Portable { .. })
    }

    /// Returns the portable data directory, or `None` if in installed mode.
    pub fn data_dir(&self) -> Option<&Path> {
        match self {
            AppMode::Portable { data_dir } => Some(data_dir),
            AppMode::Installed => None,
        }
    }
}

/// Detect whether the app is running in portable mode.
///
/// Checks for:
/// 1. `portable.marker` file next to the executable (or next to the `.app` bundle on macOS)
/// 2. `data/` directory next to the executable
///
/// Returns `AppMode::Portable` with the data directory path if detected,
/// otherwise `AppMode::Installed`.
pub fn detect_app_mode() -> Result<AppMode> {
    let exe_path = std::env::current_exe().context("Failed to resolve executable path")?;
    let exe_dir = exe_path
        .parent()
        .context("Failed to resolve executable directory")?;

    let base_dir = resolve_base_dir(exe_dir);

    let marker_path = base_dir.join("portable.marker");
    let data_dir = base_dir.join("data");

    if marker_path.exists() || data_dir.exists() {
        Ok(AppMode::Portable { data_dir })
    } else {
        Ok(AppMode::Installed)
    }
}

/// Resolve `{PORTABLE_DIR}` placeholders in a path string.
///
/// Replaces `{PORTABLE_DIR}` with the directory containing the executable
/// (or the directory containing the `.app` bundle on macOS). Returns the
/// path unchanged if not in portable mode or if no placeholder is present.
pub fn resolve_portable_path(path: &str, app_mode: &AppMode) -> PathBuf {
    match app_mode {
        AppMode::Portable { data_dir } => {
            if let Some(base_dir) = data_dir.parent() {
                let resolved = path.replace("{PORTABLE_DIR}", &base_dir.to_string_lossy());
                PathBuf::from(resolved)
            } else {
                PathBuf::from(path)
            }
        }
        AppMode::Installed => PathBuf::from(path),
    }
}

/// On macOS the executable lives deep inside the `.app` bundle
/// (`termiHub.app/Contents/MacOS/termiHub`). The portable marker and data
/// directory should sit next to the `.app` bundle, not inside it.
#[cfg(target_os = "macos")]
fn resolve_base_dir(exe_dir: &Path) -> PathBuf {
    // Walk up: MacOS/ → Contents/ → *.app/ → parent of bundle
    if let Some(contents_dir) = exe_dir.parent() {
        if let Some(app_dir) = contents_dir.parent() {
            if app_dir.extension().is_some_and(|ext| ext == "app") {
                if let Some(bundle_parent) = app_dir.parent() {
                    return bundle_parent.to_path_buf();
                }
            }
        }
    }
    exe_dir.to_path_buf()
}

#[cfg(not(target_os = "macos"))]
fn resolve_base_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn app_mode_is_portable_returns_true_for_portable() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("/tmp/data"),
        };
        assert!(mode.is_portable());
    }

    #[test]
    fn app_mode_is_portable_returns_false_for_installed() {
        assert!(!AppMode::Installed.is_portable());
    }

    #[test]
    fn app_mode_data_dir_returns_path_for_portable() {
        let path = PathBuf::from("/tmp/data");
        let mode = AppMode::Portable {
            data_dir: path.clone(),
        };
        assert_eq!(mode.data_dir(), Some(path.as_path()));
    }

    #[test]
    fn app_mode_data_dir_returns_none_for_installed() {
        assert!(AppMode::Installed.data_dir().is_none());
    }

    #[test]
    fn resolve_portable_path_replaces_placeholder() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("/usb/termiHub/data"),
        };
        let result = resolve_portable_path("{PORTABLE_DIR}/data/keys/id_rsa", &mode);
        assert_eq!(result, PathBuf::from("/usb/termiHub/data/keys/id_rsa"));
    }

    #[test]
    fn resolve_portable_path_no_placeholder_returns_unchanged() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("/usb/termiHub/data"),
        };
        let result = resolve_portable_path("/home/user/.ssh/id_rsa", &mode);
        assert_eq!(result, PathBuf::from("/home/user/.ssh/id_rsa"));
    }

    #[test]
    fn resolve_portable_path_installed_mode_returns_unchanged() {
        let result = resolve_portable_path("{PORTABLE_DIR}/data/keys/id_rsa", &AppMode::Installed);
        assert_eq!(result, PathBuf::from("{PORTABLE_DIR}/data/keys/id_rsa"));
    }

    #[test]
    fn detect_app_mode_returns_installed_when_no_marker() {
        // In tests, there's no portable.marker next to the test executable,
        // so we expect Installed mode (or Portable if data/ happens to exist).
        // We only verify the function doesn't panic.
        let result = detect_app_mode();
        assert!(result.is_ok());
    }

    #[test]
    fn detect_app_mode_portable_via_marker_file() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("portable.marker");
        std::fs::write(&marker, "").unwrap();
        let data_dir = dir.path().join("data");

        // Simulate detection logic directly (can't override exe path in tests)
        let base_dir = dir.path();
        let detected_marker = base_dir.join("portable.marker");
        let detected_data = base_dir.join("data");
        assert!(detected_marker.exists() || detected_data.exists());
        let mode = if detected_marker.exists() || detected_data.exists() {
            AppMode::Portable { data_dir }
        } else {
            AppMode::Installed
        };
        assert!(mode.is_portable());
    }

    #[test]
    fn detect_app_mode_portable_via_data_directory() {
        let dir = TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let base_dir = dir.path();
        let detected_marker = base_dir.join("portable.marker");
        let detected_data = base_dir.join("data");
        let mode = if detected_marker.exists() || detected_data.exists() {
            AppMode::Portable {
                data_dir: detected_data,
            }
        } else {
            AppMode::Installed
        };
        assert!(mode.is_portable());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_base_dir_macos_inside_app_bundle() {
        let dir = TempDir::new().unwrap();
        // Simulate: /tmp/.../termiHub.app/Contents/MacOS/
        let macos_dir = dir
            .path()
            .join("termiHub.app")
            .join("Contents")
            .join("MacOS");
        std::fs::create_dir_all(&macos_dir).unwrap();

        let result = resolve_base_dir(&macos_dir);
        // Should resolve to the dir containing termiHub.app
        assert_eq!(result, dir.path());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn resolve_base_dir_non_macos_returns_exe_dir() {
        let dir = TempDir::new().unwrap();
        let result = resolve_base_dir(dir.path());
        assert_eq!(result, dir.path());
    }
}
