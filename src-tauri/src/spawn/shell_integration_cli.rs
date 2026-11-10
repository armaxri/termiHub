//! Pre-init `install-shell-integration` / `uninstall-shell-integration` CLI
//! subcommands (#1368), with the portable data-dir lock taken first (#5245).
//!
//! These subcommands run before the Tauri app (and before startup's own
//! data-dir lock), yet they read-modify-write `settings.json`. In portable mode
//! that file lives in the shared `data/` dir, so the command takes the same OS
//! lock the GUI takes. If a termiHub instance already runs from the same
//! portable folder, the command refuses: it changes nothing (neither the OS
//! registration nor `settings.json`) and exits non-zero. The change is **not**
//! forwarded to the running instance — the user is told to use Settings there.
//! Installed mode takes no lock and is unchanged.

use crate::connection::settings::SettingsStorage;
use crate::connection::shell_integration::ShellIntegrationSettings;
use crate::utils::data_dir_lock;
use crate::utils::portable::AppMode;

/// Why a shell-integration subcommand did not complete.
#[derive(Debug)]
pub enum ShellIntegrationCliError {
    /// A termiHub instance holds the portable data dir; nothing was changed.
    /// Carries the user-facing message.
    Refused(String),
    /// Loading, (un)registering or saving failed.
    Failed(anyhow::Error),
}

/// Run the subcommand for this process: detect the app mode, take the
/// portable data-dir lock, then (un)register and persist the settings.
pub fn run(install: bool) -> Result<(), ShellIntegrationCliError> {
    let mode = match crate::utils::portable::detect_app_mode() {
        Ok(mode) => mode,
        Err(e) => {
            tracing::warn!("shell integration: app-mode detection failed, not locking: {e}");
            AppMode::Installed
        }
    };
    let override_set = std::env::var_os("TERMIHUB_CONFIG_DIR").is_some();
    apply_with_lock(
        &mode,
        override_set,
        SettingsStorage::new_standalone,
        |settings| {
            if install {
                super::registry::register(settings)
            } else {
                super::registry::unregister(settings)
            }
        },
    )
}

/// The testable core of [`run`]: storage construction and the OS
/// (un)registration are injected.
///
/// The lock is taken before `open_storage` (which may create the config dir)
/// and before `apply` (which touches the OS), and held until the save is done.
/// On a held lock neither is called and [`ShellIntegrationCliError::Refused`]
/// is returned.
pub(crate) fn apply_with_lock(
    mode: &AppMode,
    config_dir_env_override: bool,
    open_storage: impl FnOnce() -> anyhow::Result<SettingsStorage>,
    apply: impl FnOnce(&mut ShellIntegrationSettings) -> anyhow::Result<()>,
) -> Result<(), ShellIntegrationCliError> {
    let _lock = data_dir_lock::lock_for_cli_write(mode, config_dir_env_override)
        .map_err(ShellIntegrationCliError::Refused)?;
    let result = (|| -> anyhow::Result<()> {
        let storage = open_storage()?;
        let mut settings = storage.load_with_recovery()?.data;
        apply(&mut settings.shell_integration)?;
        storage.save(&settings)
    })();
    result.map_err(ShellIntegrationCliError::Failed)
}

#[cfg(test)]
#[path = "shell_integration_cli_tests.rs"]
mod tests;
