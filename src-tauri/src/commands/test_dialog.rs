//! Test-bridge-only file-access grant for stubbed native dialogs (#4122).
//!
//! The Python harness cannot drive a native OS open/save dialog, so in the
//! test-bridge build it pre-programs the dialog's result instead (the frontend
//! `stubNativeDialog` bridge verb, `src/services/nativeDialog.ts`). A real pick
//! does one more thing the stub cannot do from the webview: the dialog plugin
//! adds the picked path to the fs plugin's scope, so the follow-up
//! `writeTextFile` / `readTextFile` call is allowed. This command makes the
//! same grant for a stubbed path.
//!
//! Compiled only with the `test-bridge` feature (SEC-005) and refused unless the
//! app was launched in test-bridge mode, so a release build has no command that
//! widens the fs scope. `scripts/internal/assert-no-test-bridge.sh` checks a
//! release binary carries no test-bridge code at all.

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

/// Where a granted path goes. Split out so the gate is unit-testable without a
/// running app; the live implementation is the fs plugin's runtime scope.
trait ScopeGrant {
    fn allow_file(&self, path: &Path) -> Result<(), String>;
    fn allow_directory(&self, path: &Path) -> Result<(), String>;
}

/// The fs plugin's runtime scope, the same one the dialog plugin extends.
struct FsScope(tauri::fs::Scope);

impl ScopeGrant for FsScope {
    fn allow_file(&self, path: &Path) -> Result<(), String> {
        self.0.allow_file(path).map_err(|e| e.to_string())
    }

    fn allow_directory(&self, path: &Path) -> Result<(), String> {
        // A picked folder is granted recursively, like a dialog pick with
        // `recursive: true` (portable export/import read and write inside it).
        self.0.allow_directory(path, true).map_err(|e| e.to_string())
    }
}

/// Grant fs access to a path the harness stubbed as a native dialog's result.
///
/// An existing directory is granted recursively (a folder pick); anything else
/// is granted as a single file (an open pick, or a save target that does not
/// exist yet).
#[tauri::command]
pub fn test_allow_dialog_path(app: AppHandle, path: String) -> Result<(), String> {
    allow_dialog_path_gated(
        crate::utils::test_bridge::is_test_bridge_enabled(),
        Path::new(&path),
        &FsScope(app.fs_scope()),
    )
}

/// The gate and grant behind [`test_allow_dialog_path`].
fn allow_dialog_path_gated(
    bridge_enabled: bool,
    path: &Path,
    scope: &impl ScopeGrant,
) -> Result<(), String> {
    if !bridge_enabled {
        return Err("test_allow_dialog_path is a test-bridge-only hook".to_string());
    }
    // A native dialog only ever returns an absolute path.
    if !path.is_absolute() {
        return Err(format!(
            "a stubbed dialog path must be absolute: {}",
            path.display()
        ));
    }
    tracing::warn!(
        path = %path.display(),
        "TEST-ONLY: granting fs access to a stubbed native-dialog path"
    );
    if path.is_dir() {
        scope.allow_directory(path)
    } else {
        scope.allow_file(path)
    }
}

#[cfg(test)]
#[path = "test_dialog_tests.rs"]
mod tests;
