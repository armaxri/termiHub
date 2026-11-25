//! Desktop host for the embedded HTTP/FTP/TFTP servers.
//!
//! Each configured server is an [`EmbeddedServerService`] behind the core
//! [`Service`](termihub_core::service::Service) trait (#2154, following the
//! HTTP-monitor pilot #2157/#2172). The manager owns the persisted configs, a
//! map of live services. Each service emits its status transitions on a core
//! [`EventChannel`](termihub_core::service::EventChannel); the manager answers
//! each by publishing the shared [`services`](super::projection) region (#6028).
//!
//! # Agent-hosted servers (#2214)
//!
//! A server whose stored [`host`](EmbeddedServerConfig::host) is an agent runs
//! its listen socket **on that agent**: the desktop keeps only control, driving it over the agent RPC's
//! `service.start` / `service.stop` / `service.status` methods (protocol 0.7.0,
//! #2192). This mirrors [`tunnel_manager`](crate::tunnel::tunnel_manager)'s
//! agent-hosted tunnels (#2185).
//!
//! # The right machine or not at all (#6028)
//!
//! The host is stored with the server. When it cannot be honoured (the agent is
//! offline, removed or too old, it refuses, or this build cannot read the
//! field) the server is **not started**: nothing falls back to this computer,
//! and the row says why until a stop, a save or a good start. A server that is
//! moved while it runs is stopped where it ran.
//!
//! # Honest states (#6028)
//!
//! [`HostedServices`] holds what is known about the agent-hosted ones. A server
//! whose agent is gone is not reachable, not running; an automatic start that
//! is not possible yet waits (visibly, for a bounded time, and only for the
//! machine it belongs on); a stop the agent has not confirmed is kept until it
//! does. Servers on this computer wait for the credential store the same way.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, Runtime, Wry};
use termihub_core::service::drain_broadcast;
use termihub_core::util::entry_extra::{upsert_keeping_extra, without_extra};
use termihub_core::util::service_cause::ServiceCause;
use termihub_core::util::service_host::{HostChoice, ServiceHost};

use super::activity::ActivitySnapshot;
use super::config::{
    EmbeddedServerConfig, EmbeddedServerStore, ServerState, ServerStats, ServerStatus,
};
use super::migration::{load_and_migrate, persist_store};
use super::secrets::{self, ServerSecrets, TakenSecrets};
use super::service::{service_id_for, EmbeddedServerService, STATUS_EVENT_KIND};
use super::storage::EmbeddedServerStorage;
use crate::agent_service::hosted::{
    is_unanswered, Busy, Change, Finished, HostedKind, HostedServices, Outcome, Reading, Sample,
    StartedBy, StopPlan, Target, Ticket, View, WaitFor,
};
use crate::agent_service::{
    agent_for_start, agent_is_ready, agent_is_removed, agent_rpc_client, agent_start_error,
    not_reachable_reason, poll_now, port_in_use_here, stopping_reason, unanswered_start_failed,
    waited_too_long, waiting_reason, AgentStatusPollDelegate, AgentStatusPoller, Reason,
    HOST_UNREADABLE,
};
use crate::app_tasks::AppTasks;
use crate::connection::recovery::RecoveryWarning;
use crate::credential::CredentialStore;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use termihub_core::protocol::methods::{
    EmbeddedServerActivityParams, EmbeddedServerActivityResult, EmbeddedServerClearActivityParams,
    ServiceStartParams, ServiceStartResult, ServiceStatusParams, ServiceStatusResult,
    ServiceStopParams, EMBEDDED_SERVER_ACTIVITY, EMBEDDED_SERVER_CLEAR_ACTIVITY, SERVICE_START,
    SERVICE_STATUS, SERVICE_STOP,
};
use termihub_core::service::{Service, ServiceStatus};

/// How often the poller asks the agents (#2214) and publishes live traffic.
/// Matches the tunnel cadence (#2199).
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The agent-hosted embedded servers (#2214), as [`HostedServices`] sees them.
///
/// The listen socket, the served files, and the traffic counters all live on the
/// agent; the desktop holds only *control* — which agent runs it — and the last
/// [`ServerState`] the agent reported.
pub(super) struct HostedServers;

impl HostedKind for HostedServers {
    type State = ServerState;

    fn unknown_state(id: &str) -> ServerState {
        ServerState {
            status: ServerStatus::Running,
            ..stopped_state(id)
        }
    }

    fn stop_request(id: &str) -> (&'static str, serde_json::Value) {
        let params = ServiceStopParams {
            instance_id: id.to_string(),
        };
        (
            SERVICE_STOP,
            serde_json::to_value(params).unwrap_or_default(),
        )
    }

    fn status_request(id: &str) -> (&'static str, serde_json::Value) {
        let params = ServiceStatusParams {
            instance_id: id.to_string(),
        };
        (
            SERVICE_STATUS,
            serde_json::to_value(params).unwrap_or_default(),
        )
    }

    fn read_status(
        id: &str,
        reply: &serde_json::Value,
        _last: &ServerState,
    ) -> Reading<ServerState> {
        read_status_reply(id, reply)
    }

    fn is_news(before: &ServerState, after: &ServerState) -> bool {
        before.status != after.status || before.error != after.error
    }
}

/// Central manager for embedded HTTP/FTP/TFTP servers.
///
/// Follows the same pattern as `NetworkManager` (#2172): holds the services and
/// routes each start by the server's stored host.
pub struct EmbeddedServerManager<R: Runtime = Wry> {
    configs: Mutex<EmbeddedServerStore>,
    storage: EmbeddedServerStorage,
    /// FTP / HTTP Basic passwords: kept in the credential store, never in
    /// `configs` or on disk (#3514). `configs` always holds stripped configs.
    secrets: ServerSecrets,
    /// Live services keyed by config id (running **or** stopped-but-listed).
    services: Mutex<HashMap<String, EmbeddedServerService>>,
    /// What is known about the servers on agents, and about the automatic
    /// starts that wait (#2214, #6028). Disjoint from `services`, which holds
    /// the desktop-hosted servers.
    hosted: HostedServices<HostedServers>,
    /// Why a server that belongs on an agent was not started, by config id
    /// (#6028): durable, so its row keeps saying it. Cleared by a good start,
    /// a stop, a save or a delete.
    refusals: Mutex<HashMap<String, Reason>>,
    /// Servers whose delete can still be undone.
    deleted: Mutex<HashMap<String, Deleted>>,
    /// The single periodic agent `service.status` poller (#2214). Runs while at
    /// least one agent-hosted server exists, self-reaping once none remain; the
    /// shared [`AgentStatusPoller`] owns the task lifecycle (DUP-020).
    agent_status_poller: AgentStatusPoller,
    app_handle: AppHandle<R>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl<R: Runtime> EmbeddedServerManager<R> {
    /// Create a new manager, loading saved configurations from disk and
    /// migrating any legacy plaintext passwords into `credential_store` (#3514).
    pub fn new(
        app_handle: &AppHandle<R>,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Result<Self> {
        let storage = EmbeddedServerStorage::new(app_handle)
            .context("Failed to initialise embedded server storage")?;
        let secrets = ServerSecrets::new(credential_store);
        let result = load_and_migrate(&storage, &secrets)?;
        Ok(Self {
            configs: Mutex::new(result.data),
            storage,
            secrets,
            services: Mutex::new(HashMap::new()),
            hosted: HostedServices::default(),
            refusals: Mutex::new(HashMap::new()),
            deleted: Mutex::new(HashMap::new()),
            // App-owned (ARCH-007, #3105): teardown cancels + awaits the poller.
            agent_status_poller: AgentStatusPoller::with_tasks(AppTasks::for_app(app_handle)),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
        })
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
    ///
    /// Its passwords go to the credential store (an empty one keeps the saved
    /// password) and are stripped before the config is kept or written (#3514).
    pub fn save_config(&self, mut config: EmbeddedServerConfig) -> Result<(), TerminalError> {
        self.sync_secrets();
        self.secrets.capture(&mut config)?;
        let id = config.id.clone();
        let moved = {
            let mut store = self.lock_configs()?;
            let moved = upsert_server(&mut store, config);
            self.persist(&store)?;
            moved
        };
        // A moved server must not stay open on the machine it was moved off.
        if moved {
            self.stop_server(&id)?;
        } else {
            self.lock_refusals().remove(&id);
            self.announce();
        }
        Ok(())
    }

    /// Write `store` to disk without its passwords (legacy plaintext still
    /// awaiting a store unlock excepted — see [`ServerSecrets::disk_view`]).
    fn persist(&self, store: &EmbeddedServerStore) -> Result<(), TerminalError> {
        persist_store(&self.storage, &self.secrets, store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))
    }

    /// Move any passwords held in memory into the credential store once it can
    /// take them — completing a migration that waited for an unlock, or keeping
    /// session-only passwords after a store is enabled — and rewrite the file
    /// when legacy plaintext left it (#3514).
    ///
    /// Cheap when nothing is held. Called on every config operation and by the
    /// credential-store unlock / switch commands.
    pub fn sync_secrets(&self) {
        let outcome = self.secrets.reconcile();
        if outcome.moved_to_session > 0 {
            tracing::warn!(
                count = outcome.moved_to_session,
                "No credential store: embedded server passwords are kept for this session only"
            );
        }
        if outcome.rewrite {
            match self.lock_configs() {
                Ok(store) => {
                    if let Err(e) = self.persist(&store) {
                        tracing::warn!("Failed to rewrite embedded servers after migration: {e}");
                    }
                }
                Err(e) => tracing::warn!("Failed to rewrite embedded servers: {e}"),
            }
        }
    }

    /// Credential owners of every configured server, labelled for the
    /// credential vault (#3514).
    pub fn vault_owners(&self) -> Vec<(String, String)> {
        self.lock_configs()
            .map(|store| secrets::vault_owners(&store.servers))
            .unwrap_or_default()
    }

    /// Delete a configuration. Stops the server first if it is running. For
    /// [`UNDO_KEPT`] it can be [brought back](Self::restore_deleted).
    pub fn delete_config(&self, server_id: &str) -> Result<(), TerminalError> {
        // An agent-hosted server is stopped on its agent; a desktop-hosted one
        // is shut down and dropped so its listen port closes (#1393).
        self.stop_hosted(server_id);
        if let Ok(mut services) = self.services.lock() {
            remove_local_service(&mut services, server_id);
        }
        self.lock_refusals().remove(server_id);
        let secrets = self.secrets.take(server_id);
        {
            let mut store = self.lock_configs()?;
            let index = store.servers.iter().position(|s| s.id == server_id);
            if let Some(index) = index {
                let config = store.servers.remove(index);
                if let Err(e) = self.persist(&store) {
                    store.servers.insert(index, config);
                    self.secrets.put_back(server_id, secrets);
                    return Err(e);
                }
                self.keep_for_undo(index, config, secrets);
            }
        }
        self.announce();
        Ok(())
    }

    fn lock_deleted(&self) -> std::sync::MutexGuard<'_, HashMap<String, Deleted>> {
        self.deleted.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keep what was deleted, its passwords included, in memory for the undo.
    fn keep_for_undo(&self, index: usize, config: EmbeddedServerConfig, secrets: TakenSecrets) {
        let id = config.id.clone();
        let deleted = Deleted {
            index,
            config,
            secrets,
            at: Instant::now(),
        };
        self.lock_deleted().insert(id, deleted);
        // Not app-owned (#3105): it only drops what a quitting app drops anyway.
        let app = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(UNDO_KEPT).await;
            if let Some(manager) = app.try_state::<Arc<EmbeddedServerManager<R>>>() {
                manager.forget_deleted(Instant::now());
            }
        });
    }

    /// Drop what can no longer be brought back at `now`.
    fn forget_deleted(&self, now: Instant) {
        self.lock_deleted()
            .retain(|_, deleted| now.saturating_duration_since(deleted.at) < UNDO_KEPT);
    }

    /// Bring back a server that was just deleted, with its passwords and at its
    /// place in the list. It is not started.
    pub fn restore_deleted(&self, server_id: &str) -> Result<(), TerminalError> {
        let Some(deleted) = self.lock_deleted().remove(server_id) else {
            return Err(TerminalError::EmbeddedServerError(
                "It can no longer be brought back.".to_string(),
            ));
        };
        {
            let mut store = self.lock_configs()?;
            if store.servers.iter().all(|s| s.id != server_id) {
                let index = deleted.index.min(store.servers.len());
                store.servers.insert(index, deleted.config.clone());
                if let Err(e) = self.persist(&store) {
                    store.servers.remove(index);
                    self.lock_deleted().insert(server_id.to_string(), deleted);
                    return Err(e);
                }
            }
        }
        self.secrets.put_back(server_id, deleted.secrets);
        self.announce();
        Ok(())
    }

    /// Take back the stop of a server that its agent has not got (#6076).
    pub fn keep_running(&self, server_id: &str) -> Result<(), TerminalError> {
        let host = self
            .get_configs()?
            .into_iter()
            .find(|config| config.id == server_id)
            .map(|config| config.host);
        let agent = host.as_ref().map(|host| host.choice());
        if let Some(HostChoice::Agent(agent_id)) = agent {
            if self.hosted.keep(agent_id, server_id) {
                self.ensure_status_poller();
                self.announce();
            }
        }
        Ok(())
    }

    /// The current state of every configured server, as its row shows it.
    pub fn get_states(&self) -> Result<Vec<ServerState>, TerminalError> {
        let configs = self.get_configs()?;
        configs.iter().map(|cfg| self.state_of(cfg)).collect()
    }

    /// What the row of `cfg` shows: what is known about it on its agent, else
    /// why it was not started, else the desktop service's state.
    fn state_of(&self, cfg: &EmbeddedServerConfig) -> Result<ServerState, TerminalError> {
        let host = match cfg.host.choice() {
            HostChoice::Agent(agent_id) => Some(agent_id),
            _ => None,
        };
        if let Some(view) = self.hosted.view(&cfg.id, host) {
            return Ok(self.hosted_state(&cfg.id, view));
        }
        if let Some(reason) = self.lock_refusals().get(&cfg.id) {
            return Ok(ServerState {
                status: ServerStatus::Error,
                error: Some(reason.text.clone()),
                cause: reason.cause,
                ..stopped_state(&cfg.id)
            });
        }
        Ok(self
            .lock_services()?
            .get(&cfg.id)
            .and_then(|svc| svc.state())
            .unwrap_or_else(|| stopped_state(&cfg.id)))
    }

    /// The row of a server that [`HostedServices`] decides.
    fn hosted_state(&self, server_id: &str, view: View<ServerState>) -> ServerState {
        let app = &self.app_handle;
        let (status, reason) = match view {
            View::Running { state, .. } => return state,
            View::Starting => (ServerStatus::Starting, None),
            View::Stopping { agent_id } => (
                ServerStatus::Stopping,
                Some(stopping_reason(app, &agent_id)),
            ),
            View::Waiting { on, until } => {
                (ServerStatus::Waiting, Some(waiting_reason(&on, until)))
            }
            View::NotReachable { agent_id, why, .. } => (
                ServerStatus::NotReachable,
                Some(not_reachable_reason(app, &agent_id, why)),
            ),
        };
        ServerState {
            status,
            cause: reason.as_ref().and_then(|reason| reason.cause),
            error: reason.map(|reason| reason.text),
            ..stopped_state(server_id)
        }
    }

    /// Tell every window what the rows show now.
    fn announce(&self) {
        crate::embedded_servers::projection::publish_services(&self.app_handle);
    }

    /// Start a server by ID.
    ///
    /// It runs where its stored host says: on this computer, or on an agent over
    /// the agent RPC (#2214). A host that cannot be honoured or read starts
    /// nothing (#6028). What its row shows reaches every window through the
    /// [`services`](super::projection) region.
    pub fn start_server(&self, server_id: &str) -> Result<(), TerminalError> {
        self.start(server_id, StartedBy::User)
    }

    fn start(&self, server_id: &str, by: StartedBy) -> Result<(), TerminalError> {
        self.sync_secrets();
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
        // The host decides before anything else: only a host that says this
        // computer may reach the listener below.
        let agent_id = match config.host.choice() {
            HostChoice::ThisComputer => None,
            HostChoice::Agent(id) => Some(id.to_string()),
            HostChoice::Unreadable => {
                return Err(self.refuse(server_id, HOST_UNREADABLE));
            }
        };
        // Only the user may undo the user's stop.
        if agent_id
            .as_deref()
            .is_some_and(|agent_id| self.hosted.stop_wins(agent_id, server_id, by))
        {
            return Ok(());
        }
        if let Some(on) = self.not_ready(&config, agent_id.as_deref()) {
            if by != StartedBy::User {
                self.wait(server_id, on);
                return Ok(());
            }
            // "Start now" on a waiting server that still cannot: it goes on waiting.
            if let Some(until) = self.hosted.waits_until(server_id) {
                return Err(TerminalError::EmbeddedServerError(
                    waiting_reason(&on, until).text,
                ));
            }
        }
        let ticket = match by {
            StartedBy::User => self.hosted.begin(server_id).map_err(|busy| {
                TerminalError::EmbeddedServerError(match busy {
                    Busy::Starting => format!("Server {server_id} is already starting"),
                    Busy::Running => format!("Server {server_id} is already running on an agent"),
                })
            })?,
            // Started, or stopped, another way meanwhile.
            StartedBy::Itself => match self.hosted.begin(server_id) {
                Ok(ticket) => ticket,
                Err(_) => return Ok(()),
            },
            StartedBy::Wait => match self.hosted.begin_waiting(server_id) {
                Some(ticket) => ticket,
                None => return Ok(()),
            },
        };
        match agent_id {
            Some(agent_id) => self.start_on_agent(ticket, config, &agent_id, by),
            None => self.start_here(ticket, config),
        }
    }

    /// What an automatic start of `config` has to wait for, if anything.
    fn not_ready(&self, config: &EmbeddedServerConfig, agent_id: Option<&str>) -> Option<WaitFor> {
        if let Some(agent_id) = agent_id {
            // A removed agent never comes back: the start refuses it.
            if !agent_is_ready(&self.app_handle, agent_id)
                && !agent_is_removed(&self.app_handle, agent_id)
            {
                return Some(WaitFor::Agent(agent_id.to_string()));
            }
        }
        self.secrets
            .needs_unlock(config)
            .then_some(WaitFor::CredentialStore)
    }

    /// Let the automatic start of `server_id` wait for `on`.
    fn wait(&self, server_id: &str, on: WaitFor) {
        if self.hosted.wait(server_id, on, Instant::now()) {
            self.lock_refusals().remove(server_id);
            self.announce();
        }
        self.ensure_status_poller();
    }

    /// Start every waiting server that can start now, and end the waits that
    /// took too long. Blocking: called on every tick of the poller.
    pub fn start_ready(&self) {
        self.start_ready_at(Instant::now());
    }

    fn start_ready_at(&self, now: Instant) {
        for (id, on) in self.hosted.take_expired(now) {
            let reason = waited_too_long(&on);
            let _ = self.refuse(&id, reason);
        }
        for (id, _) in self.hosted.waiting() {
            if let Err(e) = self.start(&id, StartedBy::Wait) {
                self.record_failed_auto_start(&id, &e);
            }
        }
        let app = &self.app_handle;
        let forgotten = self
            .hosted
            .forget_removed_agents(|agent_id| agent_is_removed(app, agent_id));
        if !forgotten.is_empty() {
            self.announce();
        }
    }

    /// End a start: `Ok(true)` when it counts, `Ok(false)` when a stop was
    /// pressed meanwhile (what it started is stopped again).
    fn finish(&self, ticket: Ticket, outcome: Outcome<ServerState>, server_id: &str) -> bool {
        match self.hosted.finish(ticket, outcome, Instant::now()) {
            Finished::Done => true,
            Finished::Stopped => {
                self.announce();
                false
            }
            Finished::StopThere(agent_id) => {
                self.settle_stop(&agent_id, server_id);
                false
            }
        }
    }

    /// Open `config`'s listener on this computer. A stop pressed meanwhile
    /// closes it again.
    fn start_here(
        &self,
        ticket: Ticket,
        mut config: EmbeddedServerConfig,
    ) -> Result<(), TerminalError> {
        let server_id = config.id.clone();
        self.lock_refusals().remove(&server_id);
        self.announce();
        let asked = config.clone();
        let started = self
            .secrets
            .resolve(&mut config)
            .and_then(|()| self.listen_here(&server_id, config));
        let taken = started.is_err() && EmbeddedServerService::port_is_taken(&asked);
        if !self.finish(ticket, Outcome::Failed, &server_id) {
            if let Some(service) = self.lock_services()?.get_mut(&server_id) {
                service.shutdown();
            }
            return Ok(());
        }
        // The row was "starting" until now.
        match started {
            Ok(()) => {
                self.announce();
                self.ensure_status_poller();
                Ok(())
            }
            // Durable: the row keeps saying why, not only the toast.
            Err(e) => {
                let reason = if taken {
                    Reason::new(port_in_use_here(asked.port), Some(ServiceCause::PortInUse))
                } else {
                    plain_reason(&e).into()
                };
                let _ = self.refuse(&server_id, reason);
                Err(e)
            }
        }
    }

    /// Open `config`'s listener on this computer: the only place that does.
    fn listen_here(
        &self,
        server_id: &str,
        config: EmbeddedServerConfig,
    ) -> Result<(), TerminalError> {
        // Held until the listener is up: a save that moves the server meanwhile
        // waits, and then stops it here.
        let store = self.lock_configs()?;
        if host_in(&store, server_id) != Some(HostChoice::ThisComputer) {
            return Err(TerminalError::EmbeddedServerError(format!(
                "Server {server_id} was moved or deleted while it was starting"
            )));
        }
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
        let service = services.get_mut(server_id).ok_or_else(|| {
            TerminalError::EmbeddedServerError(
                "embedded server service missing immediately after insert".to_string(),
            )
        })?;
        service.start_with(config).map_err(Into::into)
    }

    /// Start a server hosted on a remote agent (#2214).
    ///
    /// The agent runs the listen socket; the desktop sends only control over the
    /// agent RPC. Sends `service.start` with the desktop config id as the
    /// instance id, the server-type `service_id`, and the full
    /// [`EmbeddedServerConfig`] — mirroring
    /// [`tunnel_manager::start_agent_tunnel`](crate::tunnel::tunnel_manager). On
    /// success the agent-reported state is stored for the projection and streamed
    /// to the frontend, and the `service.status` poller is (re)started. A start
    /// that gets no answer leaves the server not reachable, not stopped (#6028).
    fn start_on_agent(
        &self,
        ticket: Ticket,
        mut config: EmbeddedServerConfig,
        agent_id: &str,
        by: StartedBy,
    ) -> Result<(), TerminalError> {
        let server_id = config.id.clone();
        let server_id = server_id.as_str();
        self.announce();
        let failed = |this: &Self, ticket: Ticket, reason: Reason| {
            if this.finish(ticket, Outcome::Failed, server_id) {
                Err(this.refuse(server_id, reason))
            } else {
                Ok(())
            }
        };

        // Fill the passwords from the credential store (#3514); refuses with a
        // clear message when the store is locked or has none. The resolved
        // config reaches only the agent RPC.
        let params = self
            .secrets
            .resolve(&mut config)
            .and_then(|()| service_start_params(server_id, &config));
        let params = match params {
            Ok(params) => params,
            Err(e) => {
                let counts = self.finish(ticket, Outcome::Failed, server_id);
                self.announce();
                return if counts { Err(e) } else { Ok(()) };
            }
        };
        let client = match agent_for_start(&self.app_handle, agent_id) {
            Ok(client) => client,
            // The agent went away since it was ready: wait for it again.
            Err(_) if by != StartedBy::User && !agent_is_removed(&self.app_handle, agent_id) => {
                if self.finish(ticket, Outcome::Failed, server_id) {
                    self.wait(server_id, WaitFor::Agent(agent_id.to_string()));
                }
                return Ok(());
            }
            Err(reason) => return failed(self, ticket, reason),
        };
        // An older stop the agent has not confirmed comes first.
        if !self
            .hosted
            .send_owed_stop(client.as_ref(), agent_id, server_id, Instant::now())
        {
            let reason = stopping_reason(&self.app_handle, agent_id);
            let counts = self.finish(ticket, Outcome::Failed, server_id);
            self.announce();
            return if counts {
                Err(TerminalError::EmbeddedServerError(reason.text))
            } else {
                Ok(())
            };
        }

        let agent = agent_id.to_string();
        match client.send_request(agent_id, SERVICE_START, params) {
            Ok(result) => {
                let state = server_state_from_start_reply(server_id, &result);
                let outcome = Outcome::Started {
                    agent_id: agent,
                    state,
                };
                if !self.finish(ticket, outcome, server_id) {
                    return Ok(());
                }
            }
            Err(e) if is_unanswered(&e) => {
                tracing::warn!(%server_id, %agent_id, error = %e, "start got no answer");
                let outcome = Outcome::Unanswered {
                    agent_id: agent,
                    state: stopped_state(server_id),
                };
                if !self.finish(ticket, outcome, server_id) {
                    return Ok(());
                }
            }
            Err(e) => {
                let reason = agent_start_error(&e);
                return failed(self, ticket, reason);
            }
        }
        // Moved or deleted while the agent was starting it: not there.
        let still_there = {
            let store = self.lock_configs()?;
            host_in(&store, server_id) == Some(HostChoice::Agent(agent_id))
        };
        if !still_there {
            self.stop_hosted(server_id);
            return Err(TerminalError::EmbeddedServerError(format!(
                "Server {server_id} was moved or deleted while it was starting"
            )));
        }
        self.lock_refusals().remove(server_id);
        self.announce();
        // Sample the agent's status periodically so a later transition
        // (e.g. a crash → Error) and live stats reach the frontend.
        self.ensure_status_poller();
        tracing::info!("Embedded server {server_id} started on agent {agent_id}");
        Ok(())
    }

    /// Record and announce why `server_id` was not started, and build the error
    /// for the caller. Durable (see [`refusals`](Self::refusals)).
    fn refuse(&self, server_id: &str, reason: impl Into<Reason>) -> TerminalError {
        let reason = reason.into();
        tracing::warn!(%server_id, "{}", reason.text);
        self.lock_refusals()
            .insert(server_id.to_string(), reason.clone());
        self.announce();
        TerminalError::EmbeddedServerError(reason.text)
    }

    /// Forget why `server_id` was not started, and put its row back to stopped.
    fn clear_refusal(&self, server_id: &str) {
        if self.lock_refusals().remove(server_id).is_some() {
            self.announce();
        }
    }

    fn lock_refusals(&self) -> std::sync::MutexGuard<'_, HashMap<String, Reason>> {
        self.refusals.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stop `server_id` if it runs on an agent, starts or waits. Returns whether
    /// there is nothing left to stop on this computer.
    fn stop_hosted(&self, server_id: &str) -> bool {
        match self.hosted.stop(server_id) {
            StopPlan::Nothing => false,
            StopPlan::StoppedWaiting => {
                self.announce();
                false
            }
            StopPlan::StartWillStop => {
                self.announce();
                true
            }
            StopPlan::StopThere(agent_id) => {
                self.settle_stop(&agent_id, server_id);
                true
            }
        }
    }

    /// Send the stop that agent `agent_id` owes for `server_id`; what it does
    /// not confirm now, the poller sends again.
    fn settle_stop(&self, agent_id: &str, server_id: &str) {
        let confirmed = agent_rpc_client(&self.app_handle).is_some_and(|client| {
            self.hosted
                .send_owed_stop(client.as_ref(), agent_id, server_id, Instant::now())
        });
        if confirmed {
            tracing::info!("Embedded server {server_id} stopped on agent {agent_id}");
        } else {
            tracing::warn!("Agent {agent_id} has not confirmed the stop of server {server_id}");
            self.ensure_status_poller();
        }
        self.announce();
    }

    /// Stop a running server by ID (kept listed as `Stopped`).
    ///
    /// One that waits or starts is stopped too. One whose agent is gone rests
    /// as `Stopping` until the agent is back and confirms it (#6028).
    pub fn stop_server(&self, server_id: &str) -> Result<(), TerminalError> {
        self.clear_refusal(server_id);
        if self.stop_hosted(server_id) {
            return Ok(());
        }
        if let Some(service) = self.lock_services()?.get_mut(server_id) {
            service.shutdown();
        }
        self.announce();
        Ok(())
    }

    /// Where `server_id`'s access log lives (#3453): on the agent currently
    /// hosting it, else on this desktop (which also covers an unknown server —
    /// its desktop read is simply `None`).
    pub fn activity_route(&self, server_id: &str) -> Result<ActivityRoute, TerminalError> {
        Ok(route_for(self.hosted.agent_id_of(server_id).as_deref()))
    }

    /// The agent RPC client, for reading an agent-hosted server's log.
    pub fn agent_client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        agent_rpc_client(&self.app_handle)
    }

    /// Read a **desktop-hosted** server's access log (entries newer than
    /// `since`) plus its detailed statistics (PROD-034, PROD-036).
    ///
    /// `None` when the server has never run on this desktop. An agent-hosted
    /// server's log is read over the agent RPC instead — see
    /// [`activity_route`](Self::activity_route) and [`fetch_agent_activity`].
    pub fn get_activity(
        &self,
        server_id: &str,
        since: Option<u64>,
    ) -> Result<Option<ActivitySnapshot>, TerminalError> {
        let services = self.lock_services()?;
        Ok(read_activity(&services, server_id, since))
    }

    /// Clear a **desktop-hosted** server's access log and its request/error/top
    /// counters. A no-op for a server with no desktop-hosted log.
    pub fn clear_activity(&self, server_id: &str) -> Result<(), TerminalError> {
        if let Some(service) = self.lock_services()?.get(server_id) {
            service.clear_activity();
        }
        Ok(())
    }

    /// Stop all running servers (called on app shutdown).
    pub fn stop_all(&self) {
        if let Ok(mut services) = self.services.lock() {
            for (id, service) in services.iter_mut() {
                service.shutdown();
                tracing::debug!(%id, "Stopped embedded server during teardown");
            }
        } else {
            tracing::error!("embedded server services lock poisoned during stop_all");
        }

        // Tear down agent-hosted servers too (#2214): `service.stop` each one and
        // drop its handle, then abort the poller.
        for id in self.hosted.live_ids() {
            self.stop_hosted(&id);
        }
        self.agent_status_poller.stop();
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
                if let Err(e) = self.start(&cfg.id, StartedBy::Itself) {
                    self.record_failed_auto_start(&cfg.id, &e);
                }
            }
        }
    }

    /// Surface a failed automatic start (e.g. port busy at boot) as an Error
    /// state so the sidebar shows the server red with a reason, instead of
    /// silently leaving it stopped (GAP G7, #1145).
    fn record_failed_auto_start(&self, server_id: &str, error: &TerminalError) {
        // A refusal was announced with its reason already (#6028).
        if self.lock_refusals().contains_key(server_id) {
            return;
        }
        tracing::warn!(id = %server_id, "Failed to auto-start embedded server: {error}");
        let _ = self.refuse(server_id, plain_reason(error));
    }

    /// Ensure the single periodic agent `service.status` poller is running
    /// (#2214). Idempotent; the shared [`AgentStatusPoller`] owns the task
    /// lifecycle and the [`EmbeddedServerPoll`] delegate supplies the
    /// service-specific poll + write-back/emit (DUP-020).
    fn ensure_status_poller(&self) {
        self.agent_status_poller.ensure(self.status_poll());
    }

    /// Ask the agents about their servers now, instead of on the next tick.
    /// Blocking.
    pub fn check_again(&self) {
        poll_now(&self.status_poll());
    }

    fn status_poll(&self) -> EmbeddedServerPoll<R> {
        EmbeddedServerPoll {
            hosted: self.hosted.clone(),
            app: self.app_handle.clone(),
        }
    }

    /// Show on the rows what a poll tick changed.
    fn show_changes(&self, changes: Vec<Change>) {
        if changes.is_empty() {
            return;
        }
        for change in changes {
            if let Change::Gone {
                id,
                unanswered: true,
                ..
            } = change
            {
                self.lock_refusals().insert(id, unanswered_start_failed());
            }
        }
        self.announce();
    }

    /// Whether the status poller runs.
    #[cfg(test)]
    pub(super) fn is_polling(&self) -> bool {
        self.agent_status_poller.is_running()
    }

    /// Where the desktop-hosted server `server_id` listens.
    #[cfg(test)]
    pub(super) fn local_addr_of(&self, server_id: &str) -> Option<std::net::SocketAddr> {
        self.lock_services().ok()?.get(server_id)?.local_addr()
    }

    /// Whether a server listens on this computer, so its traffic is live.
    fn any_running_here(&self) -> bool {
        self.lock_services()
            .is_ok_and(|services| services.values().any(|service| service.is_live()))
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

/// Resolve the activity snapshot for `server_id` (see
/// [`EmbeddedServerManager::get_activity`]). A pure helper so the routing can be
/// unit-tested without an `AppHandle`.
fn read_activity(
    services: &HashMap<String, EmbeddedServerService>,
    server_id: &str,
    since: Option<u64>,
) -> Option<ActivitySnapshot> {
    services
        .get(server_id)
        .map(|svc| svc.activity_snapshot(since))
}

/// Where an embedded server's access log is read from (#3453).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityRoute {
    /// Hosted on this agent: read over `embedded_server.activity`.
    Agent(String),
    /// Desktop-hosted, or not running anywhere: read the desktop service.
    Desktop,
}

/// Pure routing decision behind [`EmbeddedServerManager::activity_route`].
fn route_for(hosting_agent: Option<&str>) -> ActivityRoute {
    match hosting_agent {
        Some(agent_id) => ActivityRoute::Agent(agent_id.to_string()),
        None => ActivityRoute::Desktop,
    }
}

/// Whether `agent_id` advertised the `embeddedServerActivity` capability.
fn agent_supports_activity(client: &dyn AgentRpcClient, agent_id: &str) -> bool {
    client
        .get_capabilities(agent_id)
        .is_some_and(|caps| caps.embedded_server_activity)
}

/// Read an agent-hosted server's access log + detailed stats over the agent
/// RPC (#3453). Blocking — call from `spawn_blocking`.
///
/// `Ok(None)` when the agent predates the RPC (no `embeddedServerActivity`
/// capability, or it answers "method not found") or no longer hosts the
/// server; a transport/agent error is returned as `Err`.
pub fn fetch_agent_activity(
    client: &dyn AgentRpcClient,
    agent_id: &str,
    server_id: &str,
    since: Option<u64>,
) -> Result<Option<ActivitySnapshot>, TerminalError> {
    agent_activity_via(
        agent_supports_activity(client, agent_id),
        |method, params| client.send_request(agent_id, method, params),
        server_id,
        since,
    )
}

/// Clear an agent-hosted server's access log over the agent RPC (#3453). A
/// no-op against an agent that predates the RPC. Blocking — call from
/// `spawn_blocking`.
pub fn clear_agent_activity(
    client: &dyn AgentRpcClient,
    agent_id: &str,
    server_id: &str,
) -> Result<(), TerminalError> {
    clear_agent_activity_via(
        agent_supports_activity(client, agent_id),
        |method, params| client.send_request(agent_id, method, params),
        server_id,
    )
}

/// Testable core of [`fetch_agent_activity`]: `supported` is the capability,
/// `send` performs the RPC.
fn agent_activity_via(
    supported: bool,
    send: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, TerminalError>,
    server_id: &str,
    since: Option<u64>,
) -> Result<Option<ActivitySnapshot>, TerminalError> {
    if !supported {
        return Ok(None);
    }
    let params = serde_json::to_value(EmbeddedServerActivityParams {
        server_id: server_id.to_string(),
        since_seq: since,
    })
    .map_err(|e| TerminalError::EmbeddedServerError(format!("Failed to build params: {e}")))?;
    let reply = match send(EMBEDDED_SERVER_ACTIVITY, params) {
        Ok(reply) => reply,
        // Defensive: an agent that advertised the capability but lacks the
        // method still degrades to "no log", never an error toast.
        Err(TerminalError::AgentUnsupported(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let result: EmbeddedServerActivityResult = serde_json::from_value(reply).map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Invalid embedded_server.activity reply: {e}"))
    })?;
    Ok(result.activity)
}

/// Testable core of [`clear_agent_activity`].
fn clear_agent_activity_via(
    supported: bool,
    send: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, TerminalError>,
    server_id: &str,
) -> Result<(), TerminalError> {
    if !supported {
        return Ok(());
    }
    let params = serde_json::to_value(EmbeddedServerClearActivityParams {
        server_id: server_id.to_string(),
    })
    .map_err(|e| TerminalError::EmbeddedServerError(format!("Failed to build params: {e}")))?;
    match send(EMBEDDED_SERVER_CLEAR_ACTIVITY, params) {
        Ok(_) | Err(TerminalError::AgentUnsupported(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

/// A synthetic `Stopped` [`ServerState`] for a server that is not running.
/// Shut down a desktop-hosted server (if running) and drop its service, the
/// local half of [`EmbeddedServerManager::delete_config`] (#1393). Returns
/// whether a service was listed under `server_id`.
///
/// Split out so the "deleting a running server closes its port" guarantee is
/// testable with a real listener and no Tauri `AppHandle`.
fn remove_local_service(
    services: &mut HashMap<String, EmbeddedServerService>,
    server_id: &str,
) -> bool {
    match services.remove(server_id) {
        Some(mut service) => {
            service.shutdown();
            true
        }
        None => false,
    }
}

/// How long a deleted server can be brought back. Longer than the Undo is
/// offered (`UNDO_WINDOW_MS`), which waits while the pointer is on it.
const UNDO_KEPT: Duration = Duration::from_secs(120);

/// A server whose delete can still be undone.
struct Deleted {
    /// Its place in the list.
    index: usize,
    config: EmbeddedServerConfig,
    secrets: TakenSecrets,
    at: Instant,
}

/// What `error` says, without the prefix that says it is about a file server.
fn plain_reason(error: &TerminalError) -> String {
    match error {
        TerminalError::EmbeddedServerError(reason) => reason.clone(),
        other => other.to_string(),
    }
}

fn stopped_state(server_id: &str) -> ServerState {
    ServerState {
        server_id: server_id.to_string(),
        status: ServerStatus::Stopped,
        error: None,
        cause: None,
        stats: ServerStats::default(),
        started_at: None,
    }
}

/// Build the `service.start` RPC params the agent parses into `ServiceStartParams`
/// (#2214).
///
/// The instance id is the desktop config id (so later stop/status key off it),
/// the service id is the server type's registered id, and the config is the full
/// [`EmbeddedServerConfig`]. Pure so the wire shape is unit-testable.
pub(super) fn service_start_params(
    server_id: &str,
    config: &EmbeddedServerConfig,
) -> Result<serde_json::Value, TerminalError> {
    // The desktop file's unknown fields (#3951) and the host (#6028) are not
    // the agent's business.
    let mut config = without_extra(config);
    config.host = ServiceHost::default();
    let config_value = serde_json::to_value(&config).map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Failed to serialize server config: {e}"))
    })?;
    serde_json::to_value(ServiceStartParams {
        instance_id: server_id.to_string(),
        service_id: service_id_for(&config.server_type).to_string(),
        config: config_value,
    })
    .map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Failed to build service.start params: {e}"))
    })
}

/// Where server `server_id` is stored to run; `None` when it is gone.
fn host_in<'a>(store: &'a EmbeddedServerStore, server_id: &str) -> Option<HostChoice<'a>> {
    let server = store.servers.iter().find(|s| s.id == server_id)?;
    Some(server.host.choice())
}

/// Replace the server with `config`'s id, or append `config` when there is none.
/// Returns whether the server now runs on another machine than before.
///
/// The entry keeps the unknown fields it had on disk and drops the IPC copy's
/// (#3951), and keeps its stored host when the IPC copy has none (#6028). Pure
/// so the save path is unit-testable.
pub(super) fn upsert_server(
    store: &mut EmbeddedServerStore,
    mut config: EmbeddedServerConfig,
) -> bool {
    let stored = store.servers.iter().find(|s| s.id == config.id);
    let moved = stored.is_some_and(|stored| {
        config.host.keep_if_absent(&stored.host);
        config.host.choice() != stored.host.choice()
    });
    upsert_keeping_extra(&mut store.servers, config);
    moved
}

/// Parse an agent `service.start` reply into the desktop [`ServerState`] (#2214).
///
/// Prefers the streamed `state` payload (a full `ServerState` with live stats);
/// falls back to synthesizing one from the lifecycle `status` when no event has
/// been emitted yet. Pure, so it is unit-testable without an agent mock.
fn server_state_from_start_reply(server_id: &str, reply: &serde_json::Value) -> ServerState {
    // Deserialize the reply into the shared `ServiceStartResult` wire DTO
    // (DUP-001). A reply that doesn't even carry a lifecycle status degrades to
    // `Stopped`, matching the old parser's null-status fallback.
    match serde_json::from_value::<ServiceStartResult>(reply.clone()) {
        Ok(result) => result
            .state
            .as_ref()
            .and_then(|state| server_state_from_value(server_id, state))
            .unwrap_or_else(|| synth_state_from_service_status(server_id, &result.status)),
        Err(_) => synth_state_from_service_status(server_id, &ServiceStatus::Stopped),
    }
}

/// Read an agent `service.status` reply (#2214). Pure, so the parse is
/// unit-testable without an agent mock.
fn read_status_reply(server_id: &str, reply: &serde_json::Value) -> Reading<ServerState> {
    // Deserialize into the shared `ServiceStatusResult` wire DTO (DUP-001).
    let Ok(result) = serde_json::from_value::<ServiceStatusResult>(reply.clone()) else {
        return Reading::Unreadable;
    };
    if !result.running {
        return Reading::NotRunning;
    }
    let fallback = ServiceStatus::Stopped;
    Reading::Running(
        result
            .state
            .as_ref()
            .and_then(|state| server_state_from_value(server_id, state))
            .unwrap_or_else(|| {
                synth_state_from_service_status(
                    server_id,
                    result.status.as_ref().unwrap_or(&fallback),
                )
            }),
    )
}

/// Parse a streamed `state` payload (a serialized [`ServerState`]) into one keyed
/// by the desktop `server_id`. Returns `None` for a null/unparseable payload.
fn server_state_from_value(server_id: &str, state: &serde_json::Value) -> Option<ServerState> {
    if state.is_null() {
        return None;
    }
    let mut parsed: ServerState = serde_json::from_value(state.clone()).ok()?;
    // Normalise to the desktop config id (defensive — the agent already keys off
    // it, since the instance id is the config id).
    parsed.server_id = server_id.to_string();
    Some(parsed)
}

/// Synthesize a [`ServerState`] from the typed core [`ServiceStatus`] when no
/// full state payload is available.
///
/// Projects the lifecycle status onto the embedded-server `(ServerStatus, error)`
/// pair via the single shared conversion (DUP-022) — so the variant relationship
/// between the two enums is defined in one place, not hand-matched here as well.
fn synth_state_from_service_status(server_id: &str, status: &ServiceStatus) -> ServerState {
    let (server_status, error) = ServerStatus::from_service_status(status);
    ServerState {
        server_id: server_id.to_string(),
        status: server_status,
        error,
        cause: None,
        stats: ServerStats::default(),
        started_at: None,
    }
}

/// The embedded-server side of the shared agent status poller (DUP-020).
///
/// Asks the agents what they host, sends the stops they owe, and lets the
/// manager start what waited, and publishes live traffic every tick while a
/// server runs anywhere.
struct EmbeddedServerPoll<R: Runtime> {
    hosted: HostedServices<HostedServers>,
    app: AppHandle<R>,
}

impl<R: Runtime> AgentStatusPollDelegate for EmbeddedServerPoll<R> {
    type Target = Target<ServerState>;
    type Sample = Sample<ServerState>;

    fn interval(&self) -> Duration {
        STATUS_POLL_INTERVAL
    }

    fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        agent_rpc_client(&self.app)
    }

    fn snapshot_targets(&self) -> (Vec<Self::Target>, bool) {
        let here = self
            .app
            .try_state::<Arc<EmbeddedServerManager<R>>>()
            .is_some_and(|manager| manager.any_running_here());
        (self.hosted.targets(), here || self.hosted.any())
    }

    fn on_tick(&self) {
        // The traffic of this computer's servers; an unchanged view sends nothing.
        crate::embedded_servers::projection::publish_services(&self.app);
        if !self.hosted.needs_tick() {
            return;
        }
        let app = self.app.clone();
        // A start blocks on the agent.
        tokio::task::spawn_blocking(move || {
            if let Some(manager) = app.try_state::<Arc<EmbeddedServerManager<R>>>() {
                manager.start_ready();
            }
        });
    }

    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[Self::Target]) -> Vec<Self::Sample> {
        HostedServices::<HostedServers>::poll(client.as_ref(), targets)
    }

    fn apply(&self, samples: Vec<Self::Sample>) {
        let changes = self.hosted.apply(samples, Instant::now());
        if let Some(manager) = self.app.try_state::<Arc<EmbeddedServerManager<R>>>() {
            manager.show_changes(changes);
        }
    }
}

/// Publish what the rows show whenever the desktop-hosted service behind
/// `events` changes its status, e.g. when its listener ends with an error.
fn spawn_event_bridge<R: Runtime>(
    app: AppHandle<R>,
    events: termihub_core::service::ServiceEventReceiver,
) {
    // Not app-owned (#3105): ends when the server's service (and its channel) drops.
    tauri::async_runtime::spawn(async move {
        drain_broadcast(events, move |event| {
            if event.kind == STATUS_EVENT_KIND {
                crate::embedded_servers::projection::publish_services(&app);
            }
        })
        .await;
    });
}

#[cfg(test)]
#[path = "server_manager_delete_tests.rs"]
mod delete_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_servers::config::ServerType;
    use serde_json::json;

    fn sample_config() -> EmbeddedServerConfig {
        EmbeddedServerConfig {
            description: None,
            id: "srv-1".to_string(),
            name: "Test HTTP".to_string(),
            server_type: ServerType::Http,
            root_directory: "/tmp".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: 8080,
            auto_start: false,
            read_only: true,
            directory_listing: Some(true),
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
            max_concurrent_sessions: None,
            host: Default::default(),
            extra: Default::default(),
        }
    }

    /// The `service.start` params carry the instance id (the config id), the
    /// server-type service id, and the full config — the exact shape the agent
    /// parses into `ServiceStartParams` (#2214). Locks the desktop side of that
    /// wire contract; the agent side is locked in `agent/src/protocol/methods.rs`.
    #[test]
    fn service_start_params_carry_instance_service_and_config() {
        let config = sample_config();
        let params = service_start_params("srv-1", &config).expect("params build");
        assert_eq!(params["instanceId"], "srv-1");
        assert_eq!(params["serviceId"], "http_server");
        // The config is nested verbatim (camelCase, as the agent expects).
        assert_eq!(params["config"]["id"], "srv-1");
        assert_eq!(params["config"]["serverType"], "http");
        assert_eq!(params["config"]["port"], 8080);
    }

    /// A `service.start` reply with a streamed `state` payload is adopted as-is
    /// (with live stats), re-keyed to the desktop server id (#2214).
    #[test]
    fn start_reply_prefers_the_streamed_state_payload() {
        let reply = json!({
            "status": { "state": "running" },
            "state": {
                "serverId": "srv-1",
                "status": "running",
                "stats": { "activeConnections": 2, "totalConnections": 7,
                           "bytesSent": 1024, "bytesReceived": 512 },
                "startedAt": "2026-07-30T00:00:00Z"
            }
        });
        let state = server_state_from_start_reply("srv-1", &reply);
        assert_eq!(state.server_id, "srv-1");
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(state.stats.total_connections, 7);
        assert_eq!(state.started_at.as_deref(), Some("2026-07-30T00:00:00Z"));
    }

    /// With no streamed `state` yet, the reply's lifecycle `status` is
    /// synthesized into a `ServerState` (#2214).
    #[test]
    fn start_reply_falls_back_to_status_when_no_state() {
        let reply = json!({ "status": { "state": "running" } });
        let state = server_state_from_start_reply("srv-2", &reply);
        assert_eq!(state.server_id, "srv-2");
        assert_eq!(state.status, ServerStatus::Running);
        assert!(state.error.is_none());
    }

    /// A `failed` lifecycle status maps to `Error` and carries its detail (#2214).
    #[test]
    fn failed_status_maps_to_error_with_detail() {
        let state = synth_state_from_service_status(
            "srv-3",
            &ServiceStatus::Failed("port in use".to_string()),
        );
        assert_eq!(state.status, ServerStatus::Error);
        assert_eq!(state.error.as_deref(), Some("port in use"));
    }

    /// Every non-failed lifecycle state synthesizes its matching `ServerStatus`
    /// with no error (DUP-022 — the reverse bridge routes through the shared
    /// conversion).
    #[test]
    fn synth_state_maps_each_lifecycle_state() {
        for (status, expected) in [
            (ServiceStatus::Stopped, ServerStatus::Stopped),
            (ServiceStatus::Starting, ServerStatus::Starting),
            (ServiceStatus::Running, ServerStatus::Running),
            (ServiceStatus::Stopping, ServerStatus::Stopping),
        ] {
            let state = synth_state_from_service_status("srv", &status);
            assert_eq!(state.status, expected, "status={status:?}");
            assert!(state.error.is_none(), "status={status:?}");
        }
    }

    /// A start reply whose lifecycle status is unparseable (or absent) degrades
    /// to `Stopped` — the typed-DTO equivalent of the old null-status fallback.
    #[test]
    fn start_reply_with_unparseable_status_degrades_to_stopped() {
        let reply = json!({ "status": { "state": "bogus" } });
        let state = server_state_from_start_reply("srv-9", &reply);
        assert_eq!(state.status, ServerStatus::Stopped);
        assert!(state.error.is_none());
    }

    /// DUP-001: the `service.*` request params serialize byte-for-byte to the
    /// pre-migration hand-built `json!` — a change is a WIRE BREAK, the agent
    /// deserializes them into `ServiceStart/Stop/StatusParams`.
    #[test]
    fn service_params_serialize_matches_hand_built_json() {
        let start = service_start_params("srv-1", &sample_config()).expect("params build");
        assert_eq!(
            start,
            json!({
                "instanceId": "srv-1",
                "serviceId": "http_server",
                "config": serde_json::to_value(sample_config()).unwrap(),
            }),
        );
        assert_eq!(
            serde_json::to_value(ServiceStopParams {
                instance_id: "srv-1".to_string()
            })
            .unwrap(),
            json!({ "instanceId": "srv-1" }),
        );
        assert_eq!(
            serde_json::to_value(ServiceStatusParams {
                instance_id: "srv-1".to_string()
            })
            .unwrap(),
            json!({ "instanceId": "srv-1" }),
        );
    }

    /// A `service.status` reply for a not-running instance yields no sample, so
    /// the poller leaves the last-known state untouched (#2214).
    #[test]
    fn status_reply_not_running_yields_none() {
        let reply = json!({ "running": false });
        assert!(matches!(
            read_status_reply("srv-1", &reply),
            Reading::NotRunning
        ));
    }

    /// A running `service.status` reply is parsed into the live state (#2214).
    #[test]
    fn status_reply_running_yields_state() {
        let reply = json!({
            "running": true,
            "status": { "state": "running" },
            "state": {
                "serverId": "srv-1",
                "status": "running",
                "stats": { "activeConnections": 0, "totalConnections": 3,
                           "bytesSent": 0, "bytesReceived": 0 },
                "startedAt": "2026-07-30T00:00:00Z"
            }
        });
        let Reading::Running(state) = read_status_reply("srv-1", &reply) else {
            panic!("running");
        };
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(state.stats.total_connections, 3);
    }

    // ── access log routing (PROD-034) ─────────────────────────────────────────

    #[test]
    fn read_activity_returns_desktop_service_log() {
        let mut services = HashMap::new();
        services.insert(
            "srv-1".to_string(),
            EmbeddedServerService::new(ServerType::Http),
        );
        let snap = read_activity(&services, "srv-1", None).expect("desktop log");
        assert!(snap.entries.is_empty());
        assert_eq!(
            snap.capacity,
            termihub_core::embedded_servers::activity::ACCESS_LOG_CAPACITY
        );
    }

    #[test]
    fn read_activity_is_none_for_unknown_servers() {
        let mut services = HashMap::new();
        services.insert(
            "srv-1".to_string(),
            EmbeddedServerService::new(ServerType::Http),
        );
        assert!(read_activity(&services, "missing", None).is_none());
    }

    // ── agent-hosted activity routing (#3453) ────────────────────────

    #[test]
    fn activity_routes_to_the_hosting_agent_else_the_desktop() {
        assert_eq!(
            route_for(Some("agent-1")),
            ActivityRoute::Agent("agent-1".to_string())
        );
        // Desktop-hosted and unknown servers both read the desktop service.
        assert_eq!(route_for(None), ActivityRoute::Desktop);
    }

    fn sample_snapshot() -> serde_json::Value {
        serde_json::json!({
            "activity": {
                "entries": [{
                    "seq": 3, "timestamp": "2026-09-26T10:00:00.000Z",
                    "client": "10.0.0.5", "method": "GET", "path": "/a.txt",
                    "status": "200", "success": true, "bytes": 12
                }],
                "latestSeq": 3, "epoch": 1, "dropped": 0, "capacity": 1000,
                "stats": {
                    "activeConnections": 0, "totalConnections": 1,
                    "bytesSent": 12, "bytesReceived": 0,
                    "totalRequests": 1, "errors": 0,
                    "topPaths": [], "topClients": [], "currentTransfers": []
                }
            }
        })
    }

    #[test]
    fn agent_activity_sends_the_rpc_and_parses_the_snapshot() {
        let mut seen = None;
        let snap = agent_activity_via(
            true,
            |method, params| {
                seen = Some((method.to_string(), params));
                Ok(sample_snapshot())
            },
            "srv-1",
            Some(2),
        )
        .expect("ok")
        .expect("snapshot");
        let (method, params) = seen.expect("rpc sent");
        assert_eq!(method, "embedded_server.activity");
        assert_eq!(
            params,
            serde_json::json!({ "serverId": "srv-1", "sinceSeq": 2 })
        );
        assert_eq!(snap.latest_seq, 3);
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.stats.total_requests, 1);
    }

    #[test]
    fn old_agent_without_the_capability_reads_as_none_without_an_rpc() {
        let res = agent_activity_via(
            false,
            |_, _| panic!("must not call an agent lacking the capability"),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
        clear_agent_activity_via(
            false,
            |_, _| panic!("must not call an agent lacking the capability"),
            "srv-1",
        )
        .expect("no-op");
    }

    #[test]
    fn method_not_found_degrades_to_none_other_errors_surface() {
        let res = agent_activity_via(
            true,
            |_, _| Err(TerminalError::AgentUnsupported("nope".into())),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
        let res = agent_activity_via(
            true,
            |_, _| Err(TerminalError::RemoteError("agent gone".into())),
            "srv-1",
            None,
        );
        assert!(matches!(res, Err(TerminalError::RemoteError(_))));
        // An agent that no longer hosts the server answers `activity: null`.
        let res = agent_activity_via(
            true,
            |_, _| Ok(serde_json::json!({ "activity": null })),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
    }

    #[test]
    fn clear_agent_activity_sends_the_rpc() {
        let mut seen = None;
        clear_agent_activity_via(
            true,
            |method, params| {
                seen = Some((method.to_string(), params));
                Ok(serde_json::json!({ "cleared": true }))
            },
            "srv-9",
        )
        .expect("ok");
        let (method, params) = seen.expect("rpc sent");
        assert_eq!(method, "embedded_server.clear_activity");
        assert_eq!(params, serde_json::json!({ "serverId": "srv-9" }));
        assert!(clear_agent_activity_via(
            true,
            |_, _| Err(TerminalError::RemoteError("x".into())),
            "srv-9"
        )
        .is_err());
    }

    // ── Unknown per-entry fields (#3951, part of #2744) ────────────────────

    fn server_json(id: &str, name: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "serverType": "http",
            "rootDirectory": "/tmp",
            "bindHost": "127.0.0.1",
            "port": 8080,
        })
    }

    /// A store loaded from a file whose server `a` carries an unknown field.
    fn store_with_future_server() -> EmbeddedServerStore {
        let mut entry = server_json("a", "Docs");
        entry["futureField"] = json!({"nested": true});
        serde_json::from_value(json!({"version": "2", "servers": [entry]})).unwrap()
    }

    fn servers_of(store: &EmbeddedServerStore) -> Vec<serde_json::Value> {
        serde_json::to_value(store).unwrap()["servers"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// Editing a server replaces it with the editor's IPC copy, which never has
    /// the unknown fields; the entry keeps the ones it had on disk.
    #[test]
    fn editing_a_server_keeps_its_unknown_fields() {
        let mut store = store_with_future_server();
        let edited: EmbeddedServerConfig =
            serde_json::from_value(server_json("a", "Renamed")).unwrap();
        upsert_server(&mut store, edited);

        let servers = servers_of(&store);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "Renamed");
        assert_eq!(servers[0]["futureField"], json!({"nested": true}));
    }

    /// Unknown keys on the IPC copy are frontend state and are not kept, for
    /// an edited server or a new one.
    #[test]
    fn ipc_only_server_keys_are_not_kept() {
        let mut store = store_with_future_server();
        let mut edited = server_json("a", "Renamed");
        edited["frontendOnly"] = json!(1);
        let mut added = server_json("b", "New");
        added["frontendOnly"] = json!(1);
        upsert_server(&mut store, serde_json::from_value(edited).unwrap());
        upsert_server(&mut store, serde_json::from_value(added).unwrap());

        let servers = servers_of(&store);
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().all(|s| s.get("frontendOnly").is_none()));
        assert_eq!(servers[0]["futureField"], json!({"nested": true}));
    }

    /// The desktop file's unknown fields are not sent to an agent host.
    #[test]
    fn service_start_params_do_not_carry_unknown_fields() {
        let store = store_with_future_server();
        let params = service_start_params("a", &store.servers[0]).expect("params build");
        assert!(params["config"].get("futureField").is_none());
        assert_eq!(params["config"]["name"], "Docs");
    }
}

#[cfg(test)]
#[path = "server_manager_e2e_tests.rs"]
mod e2e_tests;

#[cfg(test)]
#[path = "server_manager_failure_tests.rs"]
mod failure_tests;

#[cfg(test)]
#[path = "server_manager_host_tests.rs"]
mod host_tests;

#[cfg(test)]
#[path = "server_manager_state_tests.rs"]
mod state_tests;
