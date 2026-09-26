//! About-screen commands: the bundled third-party license notices (PKG-009).

use std::path::Path;

use tauri::{AppHandle, Manager};
use tracing::debug;

/// File name of the generated notices inside the app's resource directory.
///
/// Produced by `pnpm notices:generate` and bundled via
/// `src-tauri/tauri.notices.conf.json` in release builds.
pub const NOTICES_FILE_NAME: &str = "THIRD_PARTY_NOTICES.txt";

/// Read the notices file from `resource_dir`, if it exists and is non-empty.
fn read_notices(resource_dir: &Path) -> Option<String> {
    let path = resource_dir.join(NOTICES_FILE_NAME);
    match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => Some(text),
        Ok(_) => {
            debug!("Third-party notices at {} are empty", path.display());
            None
        }
        Err(err) => {
            debug!(
                "No bundled third-party notices at {}: {err}",
                path.display()
            );
            None
        }
    }
}

/// Return the bundled third-party license notices, or `None` when this build
/// does not bundle them (dev builds; only release bundles generate the file).
#[tauri::command]
pub fn get_third_party_notices(app_handle: AppHandle) -> Option<String> {
    let resource_dir = app_handle.path().resource_dir().ok()?;
    read_notices(&resource_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bundled_notices() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(NOTICES_FILE_NAME), "notices body\n").expect("write");
        assert_eq!(read_notices(dir.path()).as_deref(), Some("notices body\n"));
    }

    #[test]
    fn missing_notices_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_notices(dir.path()), None);
    }

    #[test]
    fn empty_notices_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(NOTICES_FILE_NAME), " \n").expect("write");
        assert_eq!(read_notices(dir.path()), None);
    }
}
