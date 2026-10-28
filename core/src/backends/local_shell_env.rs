//! Test seam: environment variables a local shell keeps from the app (#5055).
//!
//! On Windows, `portable_pty::CommandBuilder::new` starts from the app's
//! environment and then overwrites every variable the registry defines
//! (`HKLM\...\Session Manager\Environment`, `HKCU\Environment`), so a value
//! the app was launched with, such as `PSModulePath`, never reaches the shell.
//! The system-test harness needs exactly that: it gives each test app's
//! PowerShells a private PSReadLine history through a shim module on
//! `PSModulePath`. A `test-bridge` build reads the names to keep from the
//! harness and stores their values here once; every local shell then gets
//! them on top of the registry-merged base environment.
//!
//! Production builds never call [`set_shell_env_override`], so the list stays
//! empty and shells start exactly as before (#5009/#5045).

use std::sync::OnceLock;

/// Variables every local shell gets after the base environment, set at most
/// once per process.
static SHELL_ENV_OVERRIDE: OnceLock<Vec<(String, String)>> = OnceLock::new();

/// Give every local shell spawned from now on these `(name, value)` pairs,
/// applied after `portable-pty`'s base environment and before the session's
/// own variables (`TERM`, a connection's `envVars`), which still win.
///
/// This is a **test seam**, not a feature: the desktop app calls it only in a
/// `test-bridge` build launched by the system-test harness. Returns `false`
/// (and keeps the first list) when a list is already set.
pub fn set_shell_env_override(vars: Vec<(String, String)>) -> bool {
    SHELL_ENV_OVERRIDE.set(vars).is_ok()
}

/// The pairs set by [`set_shell_env_override`]; empty unless a test build set them.
pub(crate) fn shell_env_override() -> &'static [(String, String)] {
    pairs_in(&SHELL_ENV_OVERRIDE)
}

fn pairs_in(cell: &OnceLock<Vec<(String, String)>>) -> &[(String, String)] {
    cell.get().map(Vec::as_slice).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_shells_get_no_override() {
        // No test sets the process-global: real shells spawned by other tests
        // in this binary must keep their own environment.
        assert!(shell_env_override().is_empty());
    }

    #[test]
    fn an_unset_cell_is_empty_and_the_first_set_wins() {
        let cell = OnceLock::new();
        assert!(pairs_in(&cell).is_empty());
        let first = vec![("PSModulePath".to_string(), r"C:\shim".to_string())];
        assert!(cell.set(first.clone()).is_ok());
        assert!(cell.set(vec![("X".to_string(), "y".to_string())]).is_err());
        assert_eq!(pairs_in(&cell), first.as_slice());
    }
}
