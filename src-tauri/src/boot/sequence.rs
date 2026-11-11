//! The ordered boot-phase sequence `setup()` runs (#5311).
//!
//! [`run_setup_phases`] is the one place that fixes the phase order and threads
//! the values between phases (the config dir, the connection-type registry, the
//! recovery-warnings accumulator, the connections-file path). It drives the
//! phases through the [`BootPhases`] trait: [`LivePhases`] runs the real phase
//! functions on the app, and a test implementation records a trace, so the
//! ordering invariants are asserted without a running app.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::connection::recovery::RecoveryWarning;
use crate::terminal::xserver::{ConnectConsentRegistry, XServerManager};

/// One boot phase per method, called by [`run_setup_phases`] in order.
pub(crate) trait BootPhases {
    /// What [`BootPhases::plugin_host`] hands to [`BootPhases::session_managers`].
    type Registry;

    fn platform_and_capture(&mut self);
    fn config_dir(&mut self, warnings: &mut Vec<RecoveryWarning>) -> PathBuf;
    fn plugin_host(&mut self, config_dir: &Path) -> Self::Registry;
    fn network(&mut self, config_dir: PathBuf, warnings: &mut Vec<RecoveryWarning>);
    fn credentials_and_connections(
        &mut self,
        config_dir: PathBuf,
        warnings: &mut Vec<RecoveryWarning>,
    );
    fn session_managers(&mut self, registry: Self::Registry, warnings: &mut Vec<RecoveryWarning>);
    fn tunnels(&mut self, warnings: &mut Vec<RecoveryWarning>);
    fn projection(&mut self);
    fn secondary_managers(&mut self, warnings: &mut Vec<RecoveryWarning>);
    fn spawn_ipc(&mut self);
    fn finalize(&mut self, warnings: Vec<RecoveryWarning>, connections_file: PathBuf);
}

/// Run every boot phase in the order `setup()` requires.
pub(crate) fn run_setup_phases<P: BootPhases>(phases: &mut P) {
    phases.platform_and_capture();

    let mut recovery_warnings: Vec<RecoveryWarning> = Vec::new();

    // Resolve + materialize the effective config directory, publish it as
    // managed state, and store the detected app mode (ORDER: the
    // ConfigDirOverride is managed before any storage module is built).
    let config_dir = phases.config_dir(&mut recovery_warnings);

    // Build the shared connection-type registry (ORDER: before both the
    // PluginHost, built here, and the SessionManager, built below — both
    // share it by Arc).
    let connection_registry = phases.plugin_host(&config_dir);

    // Capture path for the connections file watcher before config_dir is moved.
    let connections_file = config_dir.join("connections.json");

    phases.network(config_dir.clone(), &mut recovery_warnings);

    // ORDER: the credential manager is built before the ConnectionManager,
    // which consumes it; config_dir is moved in here (its last use).
    phases.credentials_and_connections(config_dir, &mut recovery_warnings);

    phases.session_managers(connection_registry, &mut recovery_warnings);

    // ORDER: the tunnel manager is managed before the projection Pass B
    // seeds the tunnels region below.
    phases.tunnels(&mut recovery_warnings);

    // ORDER: the ConnectionManager (managed above) must exist before the
    // projection Pass B seeds the agents/connections/settings regions.
    phases.projection();

    phases.secondary_managers(&mut recovery_warnings);

    phases.spawn_ipc();

    // ORDER: recovery_warnings is managed last, after every push/extend
    // site above.
    phases.finalize(recovery_warnings, connections_file);
}

/// The real phases, run on the app inside `setup()`.
pub(crate) struct LivePhases<'a> {
    pub(crate) app: &'a tauri::App,
    pub(crate) app_handle_slot: &'a Arc<Mutex<Option<tauri::AppHandle>>>,
    pub(crate) x_server_manager: &'a Arc<XServerManager>,
    pub(crate) x_server_consent_registry: &'a Arc<ConnectConsentRegistry>,
    pub(crate) pending_spawn: Option<crate::spawn::SpawnRequest>,
}

impl BootPhases for LivePhases<'_> {
    type Registry = Arc<Mutex<termihub_core::connection::ConnectionTypeRegistry>>;

    fn platform_and_capture(&mut self) {
        super::init_platform_and_capture(self.app, self.app_handle_slot);
    }

    fn config_dir(&mut self, warnings: &mut Vec<RecoveryWarning>) -> PathBuf {
        super::resolve_and_manage_config_dir(self.app, warnings)
    }

    fn plugin_host(&mut self, config_dir: &Path) -> Self::Registry {
        super::init_plugin_host(self.app, config_dir)
    }

    fn network(&mut self, config_dir: PathBuf, warnings: &mut Vec<RecoveryWarning>) {
        super::init_network(self.app, config_dir, warnings);
    }

    fn credentials_and_connections(
        &mut self,
        config_dir: PathBuf,
        warnings: &mut Vec<RecoveryWarning>,
    ) {
        super::init_credentials_and_connections(self.app, config_dir, warnings);
    }

    fn session_managers(&mut self, registry: Self::Registry, warnings: &mut Vec<RecoveryWarning>) {
        super::init_session_managers(
            self.app,
            registry,
            self.x_server_manager,
            self.x_server_consent_registry,
            warnings,
        );
    }

    fn tunnels(&mut self, warnings: &mut Vec<RecoveryWarning>) {
        super::init_tunnels(self.app, warnings);
    }

    fn projection(&mut self) {
        super::init_projection(self.app);
    }

    fn secondary_managers(&mut self, warnings: &mut Vec<RecoveryWarning>) {
        super::init_secondary_managers(self.app, warnings);
    }

    fn spawn_ipc(&mut self) {
        super::init_spawn_ipc(self.app, self.pending_spawn.take());
    }

    fn finalize(&mut self, warnings: Vec<RecoveryWarning>, connections_file: PathBuf) {
        super::finalize(self.app, warnings, connections_file);
    }
}

#[cfg(test)]
#[path = "sequence_tests.rs"]
mod tests;
