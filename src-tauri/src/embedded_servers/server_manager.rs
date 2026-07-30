//! Desktop host for the embedded HTTP/FTP/TFTP servers.
//!
//! Each configured server is an [`EmbeddedServerService`] behind the core
//! [`Service`](termihub_core::service::Service) trait (#2154, following the
//! HTTP-monitor pilot #2157/#2172). The manager owns the persisted configs, a
//! map of live services, a [`ServiceRegistry`] for run-location discovery, and a
//! [`RunLocationResolver`] deciding where a server runs. Each service emits its
//! status transitions on a core [`EventChannel`](termihub_core::service::EventChannel);
//! the manager bridges those to the existing `embedded-server-status-changed`
//! Tauri event, so the frontend contract is unchanged.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;

use super::config::{
    EmbeddedServerConfig, EmbeddedServerStore, ServerState, ServerStats, ServerStatus,
};
use super::service::{auto_start_error_state, EmbeddedServerService, STATUS_EVENT_KIND};
use super::storage::EmbeddedServerStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::run_location::{ResolvedLocation, RunLocationResolver};
use crate::utils::errors::TerminalError;

use termihub_core::service::{Service, ServiceInfo, ServiceRegistry};

/// Tauri event forwarded to the frontend for each embedded server status change.
///
/// A server's [`EmbeddedServerService`] emits the status on its core
/// [`EventChannel`](termihub_core::service::EventChannel); the manager bridges it
/// to this Tauri event so the frontend receives the same `ServerState` payload as
/// before the lift.
const SERVER_STATUS_EVENT: &str = "embedded-server-status-changed";

/// Central manager for embedded HTTP/FTP/TFTP servers.
///
/// Follows the same pattern as `NetworkManager` (#2172): holds the services,
/// registers their types in a [`ServiceRegistry`], and routes each start through
/// the [`RunLocationResolver`].
pub struct EmbeddedServerManager {
    configs: Mutex<EmbeddedServerStore>,
    storage: EmbeddedServerStorage,
    /// Live services keyed by config id (running **or** stopped-but-listed).
    services: Mutex<HashMap<String, EmbeddedServerService>>,
    /// Registry of run-location-routable server types (discovery, schema,
    /// capabilities). Backs the run-location selector UI (a later S-phase).
    service_registry: ServiceRegistry,
    /// Resolver deciding where a server runs (local vs agent). S1 default is
    /// always local — the run-location selector UI arrives in a later S-phase.
    run_location: RunLocationResolver,
    app_handle: AppHandle,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl EmbeddedServerManager {
    /// Create a new manager, loading saved configurations from disk.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = EmbeddedServerStorage::new(app_handle)
            .context("Failed to initialise embedded server storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load embedded servers")?;
        Ok(Self {
            configs: Mutex::new(result.data),
            storage,
            services: Mutex::new(HashMap::new()),
            service_registry: build_service_registry(),
            run_location: RunLocationResolver::new(),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// The server types registered for run-location routing (HTTP/FTP/TFTP).
    /// Backs discovery and the run-location selector UI.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.service_registry.available_services()
    }

    /// Drain and return any recovery warnings collected during initialisation.
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| w.drain(..).collect())
            .unwrap_or_default()
    }

    /// Return all saved server configurations.
    pub fn get_configs(&self) -> Result<Vec<EmbeddedServerConfig>, TerminalError> {
        let store = self.lock_configs()?;
        Ok(store.servers.clone())
    }

    /// Add or update a server configuration.
    pub fn save_config(&self, config: EmbeddedServerConfig) -> Result<(), TerminalError> {
        let mut store = self.lock_configs()?;
        if let Some(existing) = store.servers.iter_mut().find(|s| s.id == config.id) {
            *existing = config;
        } else {
            store.servers.push(config);
        }
        self.storage
            .save(&store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))?;
        Ok(())
    }

    /// Delete a configuration. Stops the server first if it is running.
    pub fn delete_config(&self, server_id: &str) -> Result<(), TerminalError> {
        self.stop_server(server_id)?;
        if let Ok(mut services) = self.services.lock() {
            services.remove(server_id);
        }
        let mut store = self.lock_configs()?;
        store.servers.retain(|s| s.id != server_id);
        self.storage
            .save(&store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))?;
        Ok(())
    }

    /// Return the current runtime state of every configured server.
    pub fn get_states(&self) -> Result<Vec<ServerState>, TerminalError> {
        let store = self.lock_configs()?;
        let services = self.lock_services()?;
        let states = store
            .servers
            .iter()
            .map(|cfg| {
                services
                    .get(&cfg.id)
                    .and_then(|svc| svc.state())
                    .unwrap_or_else(|| ServerState {
                        server_id: cfg.id.clone(),
                        status: ServerStatus::Stopped,
                        error: None,
                        stats: ServerStats::default(),
                        started_at: None,
                    })
            })
            .collect();
        Ok(states)
    }

    /// Start a server by ID.
    ///
    /// The run-location is resolved through the [`RunLocationResolver`] (S1
    /// default: always local; an agent request is rejected until agent hosting
    /// lands). The server's status transitions are emitted on its core
    /// [`EventChannel`](termihub_core::service::EventChannel) and bridged to the
    /// [`SERVER_STATUS_EVENT`] Tauri event.
    pub fn start_server(&self, server_id: &str) -> Result<(), TerminalError> {
        match self.run_location.resolve_default() {
            ResolvedLocation::Local => {}
            ResolvedLocation::Agent(agent) => {
                // The run-location selector UI (which could request an agent) is a
                // later S-phase; today the resolver always returns local.
                return Err(TerminalError::EmbeddedServerError(format!(
                    "agent-hosted embedded servers are not yet supported (requested '{agent}')"
                )));
            }
        }

        let config = {
            let store = self.lock_configs()?;
            store
                .servers
                .iter()
                .find(|s| s.id == server_id)
                .cloned()
                .ok_or_else(|| {
                    TerminalError::EmbeddedServerError(format!("Server not found: {server_id}"))
                })?
        };

        let mut services = self.lock_services()?;
        // Reuse an existing (stopped) service so its event channel + bridge task
        // persist across restarts; create + bridge a fresh one otherwise.
        if !services.contains_key(server_id) {
            let service = EmbeddedServerService::new(config.server_type.clone());
            // Subscribe before starting so the bridge cannot miss the first
            // Starting transition.
            spawn_event_bridge(self.app_handle.clone(), service.subscribe_events());
            services.insert(server_id.to_string(), service);
        }
        let service = services
            .get_mut(server_id)
            .expect("service was just inserted");
        service.start_with(config).map_err(Into::into)
    }

    /// Stop a running server by ID (kept listed as `Stopped`).
    pub fn stop_server(&self, server_id: &str) -> Result<(), TerminalError> {
        let mut services = self.lock_services()?;
        if let Some(service) = services.get_mut(server_id) {
            service.shutdown();
        }
        Ok(())
    }

    /// Stop all running servers (called on app shutdown).
    pub fn stop_all(&self) {
        let Ok(mut services) = self.services.lock() else {
            tracing::error!("embedded server services lock poisoned during stop_all");
            return;
        };
        for (id, service) in services.iter_mut() {
            service.shutdown();
            tracing::debug!(%id, "Stopped embedded server during teardown");
        }
    }

    /// Start all servers with `auto_start: true`.
    pub fn start_auto_servers(&self) {
        let configs = match self.get_configs() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to load configs for auto-start: {e}");
                return;
            }
        };
        for cfg in configs {
            if cfg.auto_start {
                if let Err(e) = self.start_server(&cfg.id) {
                    // Surface the failure (e.g. port busy at boot) as an Error
                    // state so the sidebar shows the server red with a reason,
                    // instead of silently leaving it stopped (GAP G7, #1145). A
                    // pre-flight failure returns before the service emits, so the
                    // manager emits the Error state here.
                    let msg = e.to_string();
                    tracing::warn!(id = %cfg.id, "Failed to auto-start embedded server: {msg}");
                    let state = auto_start_error_state(&cfg.id, &msg);
                    let _ = self.app_handle.emit(SERVER_STATUS_EVENT, &state);
                }
            }
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    fn lock_configs(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, EmbeddedServerStore>, TerminalError> {
        self.configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))
    }

    fn lock_services(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, EmbeddedServerService>>, TerminalError>
    {
        self.services
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))
    }
}

/// Build the [`ServiceRegistry`] with the run-location-routable server types.
///
/// Delegates to [`termihub_core::embedded_servers::build_service_registry`] so
/// the desktop host and the agent register identical server-type factories from
/// one source of truth (#2192).
fn build_service_registry() -> ServiceRegistry {
    termihub_core::embedded_servers::build_service_registry()
}

/// Bridge a server's core [`EventChannel`](termihub_core::service::EventChannel)
/// to the desktop's Tauri emitter.
///
/// Forwards each `status` [`ServiceEvent`](termihub_core::service::ServiceEvent)
/// as a [`SERVER_STATUS_EVENT`] Tauri event so the frontend receives the same
/// `ServerState` payload as before the lift. The task ends when the service is
/// dropped (channel closed).
fn spawn_event_bridge(app: AppHandle, mut events: termihub_core::service::ServiceEventReceiver) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.kind == STATUS_EVENT_KIND => {
                    let _ = app.emit(SERVER_STATUS_EVENT, event.payload);
                }
                Ok(_) => {}
                // Advisory events: a lagging bridge drops the oldest and keeps going.
                Err(RecvError::Lagged(_)) => continue,
                // All senders dropped (service removed) — nothing more to forward.
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop manager sources its server-type registry from the shared core
    /// factory (#2192). The factory's contents are tested in
    /// `termihub_core::embedded_servers`; here we only confirm the desktop wires
    /// through to it and exposes the three run-location-routable types.
    #[test]
    fn build_service_registry_delegates_to_core_and_lists_the_three_types() {
        let ids: Vec<String> = build_service_registry()
            .available_services()
            .into_iter()
            .map(|s| s.service_id)
            .collect();
        assert!(ids.contains(&"http_server".to_string()));
        assert!(ids.contains(&"ftp_server".to_string()));
        assert!(ids.contains(&"tftp_server".to_string()));
    }
}
