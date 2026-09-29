//! Tunnels whose SSH connection was deleted (#2850).
//!
//! A tunnel names its SSH connection by id (`TunnelConfig.sshConnectionId`).
//! When that connection is deleted — one at a time, in a bulk delete, or because
//! the external connection file holding it changed or was disabled — the tunnel
//! can no longer resolve its SSH handshake. The contract is deliberate and loses
//! no data:
//!
//! * a **running** tunnel that references a deleted connection is **stopped**;
//! * its **config is kept**, and the tunnel rests in the explicit
//!   [`TunnelStatus::MissingConnection`] state instead of `Disconnected`;
//! * it **cannot be started** while unresolved ([`ConnectionRefs::ensure_resolved`]);
//! * it **resolves on its own** once it points at a connection that exists again
//!   — the user repoints it in the tunnel editor, or the connection comes back.
//!
//! "Unresolved" is derived, never persisted: [`ConnectionRefs`] holds the live
//! set of saved-connection ids and a tunnel is unresolved exactly when its id is
//! not in it. The set is refreshed server-side from the connection fold
//! ([`reconcile_tunnels_with_connections`], called by
//! `fold_connections_from_manager`, which every connection-config mutation runs
//! through the `commit()` choke point), so every client sees the state through
//! the shared `tunnels` projection — not only the client that deleted.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime};

use crate::connection::manager::UnifiedConnectionView;
use crate::tunnel::config::{TunnelConfig, TunnelStatus};
use crate::tunnel::tunnel_manager::TunnelManager;
use crate::utils::errors::TerminalError;

/// What the cascade needs from the tunnel authority. Implemented by the real
/// [`TunnelManager`]; the tests drive an in-memory double.
pub trait TunnelControl {
    /// Every saved tunnel config.
    fn tunnel_configs(&self) -> Vec<TunnelConfig>;
    /// Whether the tunnel is running or on its way up (connected, connecting,
    /// or retrying).
    fn is_running(&self, tunnel_id: &str) -> bool;
    /// Stop the tunnel (best effort).
    fn stop(&self, tunnel_id: &str);
}

/// The saved connections that exist right now, as the connection fold sees
/// them: each id with the external connection file it came from (`None` for the
/// main store), plus the external files that failed to load.
///
/// A file that fails to load contributes no rows, but its connections were not
/// deleted — a transient parse error must not stop tunnels. [`ConnectionRefs`]
/// therefore keeps the previously seen ids of an unreadable file live.
#[derive(Debug, Default, Clone)]
pub struct LiveConnections {
    /// Every loaded connection id with its source file.
    pub ids: Vec<(String, Option<String>)>,
    /// External connection files that failed to load.
    pub unreadable_files: HashSet<String>,
}

impl LiveConnections {
    /// The live connections of a unified main + external-file view.
    pub fn from_view(view: &UnifiedConnectionView) -> Self {
        Self {
            ids: view
                .connections
                .iter()
                .map(|c| (c.id.clone(), c.source_file.clone()))
                .collect(),
            unreadable_files: view
                .external_errors
                .iter()
                .map(|(file, _)| file.clone())
                .collect(),
        }
    }
}

impl From<HashSet<String>> for LiveConnections {
    /// Main-store ids only, every file readable.
    fn from(ids: HashSet<String>) -> Self {
        Self {
            ids: ids.into_iter().map(|id| (id, None)).collect(),
            unreadable_files: HashSet::new(),
        }
    }
}

/// The live saved-connection ids the tunnels are checked against, each with its
/// source file (`None` for the main store).
///
/// `None` until the first reconcile: before the manager has seen the connection
/// list nothing is flagged or refused, so a startup ordering never marks a
/// healthy tunnel unresolved on a guess.
#[derive(Default)]
pub struct ConnectionRefs {
    live: Mutex<Option<HashMap<String, Option<String>>>>,
}

impl ConnectionRefs {
    /// Whether `ssh_connection_id` names no saved connection.
    pub fn is_unresolved(&self, ssh_connection_id: &str) -> bool {
        match self.live.lock() {
            Ok(live) => live
                .as_ref()
                .is_some_and(|ids| !ids.contains_key(ssh_connection_id)),
            Err(_) => false,
        }
    }

    /// The resting status a tunnel takes because of its SSH connection:
    /// [`TunnelStatus::MissingConnection`] when that connection is gone, `None`
    /// otherwise (the tunnel's own resting status applies).
    pub fn resting_status(&self, config: &TunnelConfig) -> Option<TunnelStatus> {
        self.is_unresolved(&config.ssh_connection_id)
            .then_some(TunnelStatus::MissingConnection)
    }

    /// Refuse to start a tunnel whose SSH connection was deleted.
    pub fn ensure_resolved(&self, config: &TunnelConfig) -> Result<(), TerminalError> {
        if self.is_unresolved(&config.ssh_connection_id) {
            return Err(TerminalError::TunnelError(format!(
                "The SSH connection '{}' of tunnel '{}' was deleted. \
                 Edit the tunnel and choose another SSH connection.",
                config.ssh_connection_id, config.name
            )));
        }
        Ok(())
    }

    /// Record the live saved connections, then stop every running tunnel whose
    /// SSH connection is not among them. Returns the stopped tunnel ids.
    ///
    /// The ids previously seen in a file that is now unreadable stay live. The
    /// set is stored before any stop, so the status a stop publishes already
    /// reads `MissingConnection`.
    pub fn reconcile(
        &self,
        live: impl Into<LiveConnections>,
        control: &impl TunnelControl,
    ) -> Vec<String> {
        let live = live.into();
        if let Ok(mut slot) = self.live.lock() {
            let mut next: HashMap<String, Option<String>> = live.ids.into_iter().collect();
            if let Some(previous) = slot.take() {
                for (id, source) in previous {
                    let unreadable = source
                        .as_ref()
                        .is_some_and(|file| live.unreadable_files.contains(file));
                    if unreadable {
                        next.entry(id).or_insert(source);
                    }
                }
            }
            *slot = Some(next);
        }
        let mut stopped = Vec::new();
        for config in control.tunnel_configs() {
            if self.is_unresolved(&config.ssh_connection_id) && control.is_running(&config.id) {
                tracing::info!(
                    "Stopping tunnel {}: its SSH connection {} was deleted",
                    config.id,
                    config.ssh_connection_id
                );
                control.stop(&config.id);
                stopped.push(config.id);
            }
        }
        stopped
    }
}

/// Reconcile the managed tunnels against the live saved-connection ids and
/// republish the `tunnels` region (#2850).
///
/// Called from the connection fold, after the `connections` region took the
/// new unified view. A no-op when the tunnel manager is not managed (tunnel
/// storage failed to initialize, or a headless test app).
pub fn reconcile_tunnels_with_connections<R: Runtime>(
    app_handle: &AppHandle<R>,
    live: LiveConnections,
) {
    let Some(manager) = app_handle.try_state::<Arc<TunnelManager>>() else {
        return;
    };
    manager.reconcile_connections(live);
    crate::tunnel::projection::publish_tunnels(app_handle);
}

#[cfg(test)]
#[path = "connection_refs_tests.rs"]
mod tests;
