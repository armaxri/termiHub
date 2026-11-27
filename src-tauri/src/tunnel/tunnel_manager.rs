use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use tauri::{AppHandle, Manager, Runtime, Wry};
use termihub_core::backends::ssh::auth::connect_and_authenticate_cancellable_with_liveness as core_connect_cancellable_with_liveness;
use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, LivenessWatch, SshSession};
use termihub_core::backends::ssh::jump_host::connect_target_through_pooled_gateway_with_liveness;
use termihub_core::backends::ssh::parse_ssh_settings;
use termihub_core::backends::ssh::session_pool::{PooledRef, RefPool, SshGateway};
use termihub_core::connection::ConnectionTypeInfo;
use termihub_core::protocol::methods::{TunnelForwardSpec, TunnelStartParams, TUNNEL_START};
use termihub_core::reconnect_backoff::{
    policy_for, reconnect_reducer, system_jitter, BackoffConfig, ReconnectEvent, ReconnectKind,
    ReconnectPhase, INITIAL_RECONNECT_STATE,
};
use termihub_core::tunnel::ActiveForwarder;
use termihub_core::util::service_cause::{tcp_port_in_use, ServiceCause};
use termihub_core::util::service_host::HostChoice;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::terminal::backend::SshConfig;

use super::config::{
    TunnelConfig, TunnelState, TunnelStats, TunnelStatus, TunnelStore, TunnelType,
};
use super::connecting::{ConnectingTracker, FinishOutcome};
use super::connection_refs::{ConnectionRefs, LiveConnections, TunnelControl};
use super::dynamic_forward::DynamicForwarder;
use super::host::{ensure_runs_here, resolve_tunnel_host, RunsHere};
use super::hosted::{tunnel_state, HostedTunnel, HostedTunnels, Reasons};
use super::local_forward::LocalForwarder;
use super::remote_forward::RemoteForwarder;
use super::storage::TunnelStorage;
use crate::agent_service::hosted::{
    is_unanswered, Away, Busy, Change, Finished, HostedServices, Outcome, Sample, StartedBy,
    StopPlan, Target, Ticket, WaitFor,
};
use crate::agent_service::{
    agent_for_start, agent_is_ready, agent_is_removed, agent_rpc_client, agent_start_error,
    not_reachable_reason, poll_now, port_in_use_here, stopping_reason, unanswered_start_failed,
    waited_too_long, waiting_reason, AgentStatusPollDelegate, AgentStatusPoller, Reason,
};
use crate::app_tasks::AppTasks;
use crate::connection::jump_host_resolver::ReferenceRole;
use crate::connection::manager::ConnectionManager;
use crate::connection::recovery::RecoveryWarning;
use crate::run_location::ResolvedLocation;
use crate::session::manager::SessionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_with_registry_cancellable;

/// Drive an async future to completion on the current multi-threaded Tokio
/// runtime from a synchronous context.
///
/// Same runtime-context requirement as the `ssh_auth` helpers (#828): call only
/// from inside `spawn_blocking` or an async task. Used to bridge the synchronous
/// tunnel build path to the async session-pool / jump-host connect APIs.
fn block_on_runtime<F: std::future::Future>(fut: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

/// Run `f` — a tunnel's SSH connect — named after the tunnel, so a host-key
/// prompt it raises names the tunnel (#5943). The connect blocks on the
/// calling thread ([`block_on_runtime`]), which keeps the scope.
fn in_tunnel_prompt_scope<R>(config: &TunnelConfig, f: impl FnOnce() -> R) -> R {
    let name = crate::session::prompt_connection_name::tunnel(&config.name);
    crate::session::prompt_connection_name::with_prompt_connection_name_sync(Some(&name), f)
}

/// A pooled endpoint SSH session together with its native liveness watch (#1297).
///
/// Pooled by connection id so every local/dynamic tunnel sharing the endpoint
/// session also shares one [`LivenessWatch`] (cloned per supervisor); dropping the
/// last pool reference drains the session. Bundling the watch with the session in
/// the pooled value is what lets a shared session's death fan out to every
/// supervisor riding it.
struct LiveEndpoint {
    session: Arc<SshSession>,
    liveness: LivenessWatch,
}

/// What a jump-host tunnel connect yields: the target session, its forwarded-
/// channel registry, the pooled gateway hold to keep alive for the session's
/// lifetime, and the native session-[`LivenessWatch`] (#1297).
type GatewayConnect = (
    SshSession,
    ForwardedChannelRegistry,
    PooledRef<Arc<SshGateway>>,
    LivenessWatch,
);

/// RAII holder for the pool references a tunnel's SSH session(s) depend on.
///
/// Dropping it returns the references to their pools, draining sessions no
/// longer used by any tunnel or terminal.
///
/// The fields are never read — they are held purely so their `Drop` releases the
/// pool reference when the tunnel is torn down (RAII).
#[derive(Default)]
#[expect(
    dead_code,
    reason = "RAII: fields are held only so their Drop releases the pool ref"
)]
struct PooledSessionGuards {
    /// Pooled endpoint session, shared by local/dynamic forwarders on the same
    /// connection. `None` when the endpoint is reached through a jump host.
    endpoint: Option<PooledRef<Arc<LiveEndpoint>>>,
    /// Pooled jump-host gateway session shared across all connections that use
    /// the same bastion. `None` for direct (non-jump) connections.
    gateway: Option<PooledRef<Arc<SshGateway>>>,
}

impl PooledSessionGuards {
    /// Hold a pooled per-connection endpoint session.
    fn endpoint(endpoint: PooledRef<Arc<LiveEndpoint>>) -> Self {
        Self {
            endpoint: Some(endpoint),
            gateway: None,
        }
    }

    /// Hold a pooled jump-host gateway session.
    fn gateway(gateway: PooledRef<Arc<SshGateway>>) -> Self {
        Self {
            endpoint: None,
            gateway: Some(gateway),
        }
    }
}

/// Record a tunnel's last error into the persisted per-tunnel error map.
///
/// Set on the failing `Error` branch of a start so the failure becomes a
/// durable, queryable resting state (GAP 3, #1238). Poison-safe: a poisoned
/// mutex silently no-ops rather than panicking, consistent with the manager's
/// other lock handling.
fn record_last_error(
    errors: &Mutex<HashMap<String, Reason>>,
    tunnel_id: &str,
    reason: impl Into<Reason>,
) {
    if let Ok(mut map) = errors.lock() {
        map.insert(tunnel_id.to_string(), reason.into());
    }
}

/// Clear a tunnel's persisted last error (on a successful start or an explicit
/// stop), returning it to the "never failed" resting state.
fn clear_last_error(errors: &Mutex<HashMap<String, Reason>>, tunnel_id: &str) {
    if let Ok(mut map) = errors.lock() {
        map.remove(tunnel_id);
    }
}

/// Look up a tunnel's persisted last error, if any. Reading never mutates the
/// map, so repeated `get_statuses` calls (a reload) keep reporting `Error`.
fn last_error_for(errors: &Mutex<HashMap<String, Reason>>, tunnel_id: &str) -> Option<Reason> {
    errors
        .lock()
        .ok()
        .and_then(|map| map.get(tunnel_id).cloned())
}

/// Resolve the resting (non-active) status of a tunnel from its transient
/// connecting state and any persisted last error.
///
/// Precedence: an in-flight connect wins over a stale error; otherwise a
/// recorded failure surfaces as `Error` carrying its message, and only the
/// absence of both is a plain `Disconnected`. This is what distinguishes
/// "never started" (no error entry) from "died with an error" (entry present).
fn resting_status(
    is_connecting: bool,
    last_error: Option<Reason>,
) -> (TunnelStatus, Option<Reason>) {
    if is_connecting {
        (TunnelStatus::Connecting, None)
    } else if let Some(error) = last_error {
        (TunnelStatus::Error, Some(error))
    } else {
        (TunnelStatus::Disconnected, None)
    }
}

// ── Companion (chained desktop-hop) linkage — pure helpers (#2597) ───────────
//
// "Chain a hop to this computer" pairs an agent-hosted loopback forward (the
// *parent*) with a desktop-hosted `-L` *companion* that restores plain
// `localhost:PORT` on the desktop. The pairing lives on the companion's
// [`TunnelConfig::companion_of`] field; the parent's side is derived. These
// helpers are pure (no locking, no IO, no `AppHandle`) so the ordered
// pair-lifecycle decisions are unit-testable without a live SSH stack.

/// Whether a lock-guarded id→value map holds `id`. A poisoned lock reads as
/// absent (the manager treats a poisoned map as "not present" everywhere).
fn map_contains<V>(map: &Arc<Mutex<HashMap<String, V>>>, id: &str) -> bool {
    map.lock().map(|g| g.contains_key(id)).unwrap_or(false)
}

/// The companion linked to `parent_id`, if any — the config whose
/// `companion_of` points back at it.
fn find_companion<'a>(tunnels: &'a [TunnelConfig], parent_id: &str) -> Option<&'a TunnelConfig> {
    tunnels
        .iter()
        .find(|t| t.companion_of.as_deref() == Some(parent_id))
}

/// What a chained companion must do when its parent settles into `parent_status`.
///
/// The dependency is one-directional: the companion's forward target *is* the
/// parent's listen socket, so it may only run while the parent is `Connected`,
/// and must be held down otherwise (it can never outlive or outrun its parent).
/// `companion_running` gates the action so a steady state emits no churn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompanionAction {
    /// Bring the companion up (parent reached `Connected`, companion is down).
    Start,
    /// Tear the companion down (parent left `Connected`, companion is up).
    Stop,
    /// Nothing to do — the companion already matches the parent.
    None,
}

/// Decide the companion action for a parent status transition. Pure so the
/// ordered start / hold-down rules are unit-tested directly.
fn companion_action(parent_status: &TunnelStatus, companion_running: bool) -> CompanionAction {
    match parent_status {
        // Parent is carrying traffic → the companion's target is live; start it.
        TunnelStatus::Connected => {
            if companion_running {
                CompanionAction::None
            } else {
                CompanionAction::Start
            }
        }
        // The parent may still forward: its agent lost the desktop, not the
        // tunnel. Holding the companion down would drop connections that work
        // on every blip of the agent (#6028).
        TunnelStatus::NotReachable => CompanionAction::None,
        // Parent is not connected (connecting / reconnecting / disconnected /
        // error / its SSH connection deleted) → hold the companion down so it never dangles at a dead port.
        TunnelStatus::Connecting
        | TunnelStatus::Reconnecting
        | TunnelStatus::Disconnected
        | TunnelStatus::Error
        | TunnelStatus::Waiting
        | TunnelStatus::Stopping
        | TunnelStatus::MissingConnection => {
            if companion_running {
                CompanionAction::Stop
            } else {
                CompanionAction::None
            }
        }
    }
}

/// How often the live stats emitter republishes the `tunnels` projection region
/// while a tunnel is active (GAP 6, #1248; #2150).
const STATS_EMIT_INTERVAL: Duration = Duration::from_secs(1);

/// Whether one emit tick has anything to publish: at least one tunnel is active.
///
/// Pure helper (no locking, no IO) so it is unit-testable. `false` is the
/// signal the emitter task uses to stop once no tunnel is active.
fn has_active_tunnels(active: &HashMap<String, ActiveTunnel>) -> bool {
    !active.is_empty()
}

/// Spawn the single live-stats emitter loop (GAP 6, #1248) on the app-owned
/// task registry (ARCH-007, #3105).
///
/// Every [`STATS_EMIT_INTERVAL`] it checks for active tunnels and calls `emit`
/// (outside the lock), which republishes the `tunnels` projection region — the
/// only channel carrying live stats to the frontend since the legacy
/// per-tunnel stats event was retired (PERF2-007, #4344). It ends — and clears
/// `slot` so a later start re-spawns it — once no tunnel is active, or promptly
/// between ticks when the app cancellation token fires. `emit` is a closure so
/// the loop is testable without a live Tauri `AppHandle`.
fn spawn_stats_emitter(
    tasks: &AppTasks,
    active_tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
    slot: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    mut emit: impl FnMut() + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let cancel = tasks.cancellation_token();
    tasks.spawn(async move {
        loop {
            // App teardown wins over the next tick; nothing is in flight between
            // ticks, so stopping here cannot truncate an emit.
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(STATS_EMIT_INTERVAL) => {}
            }

            // Check under the lock, then release it before publishing so a
            // slow projection rebuild never blocks start/stop of other tunnels.
            let any_active = match active_tunnels.lock() {
                Ok(active) => has_active_tunnels(&active),
                Err(_) => break,
            };

            // No tunnel left active: stop emitting and clear the slot so a
            // later start re-spawns the task.
            if !any_active {
                break;
            }

            emit();
        }

        // Self-reap: drop our own handle from the tracking slot so
        // `ensure_stats_emitter` spawns a fresh task on the next start.
        if let Ok(mut slot) = slot.lock() {
            *slot = None;
        }
    })
}

/// The cancellation token for a new per-tunnel supervisor (#1243): a child of
/// the app token (ARCH-007, #3105), so app teardown stops every supervisor —
/// and, through `supervise`'s child `loop_cancel`, any reconnect backoff —
/// while an explicit per-tunnel Stop still cancels just its own.
fn supervisor_cancel_token(tasks: &AppTasks) -> CancellationToken {
    tasks.cancellation_token().child_token()
}

/// The tunnel side of the shared agent status poller (DUP-020).
///
/// Asks the agents which tunnels they forward, sends the stops they owe, lets
/// the manager start what waited (#6028), and republishes the `tunnels` region
/// (#2199): stats-only (#4574) on a plain tick, in full when a row changes.
struct AgentTunnelPoll<R: Runtime> {
    hosted: HostedServices<HostedTunnels>,
    app: AppHandle<R>,
}

impl<R: Runtime> AgentStatusPollDelegate for AgentTunnelPoll<R> {
    type Target = Target<HostedTunnel>;
    type Sample = Sample<HostedTunnel>;

    fn interval(&self) -> Duration {
        STATS_EMIT_INTERVAL
    }

    fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        agent_rpc_client(&self.app)
    }

    fn snapshot_targets(&self) -> (Vec<Self::Target>, bool) {
        (self.hosted.targets(), self.hosted.any())
    }

    fn on_tick(&self) {
        if !self.hosted.needs_tick() {
            return;
        }
        let Some(manager) = resolve_managed_arc::<TunnelManager<R>, _>(&self.app) else {
            return;
        };
        // A start blocks on the agent.
        tokio::task::spawn_blocking(move || manager.start_ready());
    }

    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[Self::Target]) -> Vec<Self::Sample> {
        HostedServices::<HostedTunnels>::poll(client.as_ref(), targets)
    }

    fn apply(&self, samples: Vec<Self::Sample>) {
        let changes = self.hosted.apply(samples, Instant::now());
        // Only the stats changed, as far as this call goes; a row that changed
        // publishes the whole view below.
        crate::tunnel::projection::publish_tunnel_stats(&self.app);
        if let Some(manager) = resolve_managed_arc::<TunnelManager<R>, _>(&self.app) {
            manager.show_changes(changes);
        }
    }
}

/// What to do about a tunnel whose agent says that it does not run there.
#[derive(Debug, Clone, PartialEq, Eq)]
enum GoneTunnel {
    /// It ended with its agent, and may come back by itself.
    StartAgain,
    /// It ended with its agent.
    Stopped,
    /// Its unanswered start did not start it.
    NotStarted,
}

/// Pure half of [`TunnelManager::show_changes`].
fn gone_tunnel(unanswered: bool, reconnect_on_disconnect: bool) -> GoneTunnel {
    match (unanswered, reconnect_on_disconnect) {
        (true, _) => GoneTunnel::NotStarted,
        (false, true) => GoneTunnel::StartAgain,
        (false, false) => GoneTunnel::Stopped,
    }
}

/// [`Reasons`] of this app.
struct AppReasons<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> Reasons for AppReasons<'_, R> {
    fn waiting(&self, on: &WaitFor, until: DateTime<Local>) -> Reason {
        waiting_reason(on, until)
    }
    fn stopping(&self, agent_id: &str) -> Reason {
        stopping_reason(self.0, agent_id)
    }
    fn not_reachable(&self, agent_id: &str, why: Away) -> Reason {
        not_reachable_reason(self.0, agent_id, why)
    }
}

/// An active tunnel instance.
struct ActiveTunnel {
    forwarder: ActiveForwarder,
    /// Pool references kept alive for the tunnel's lifetime; dropped on teardown
    /// to release the shared endpoint / gateway sessions.
    guards: PooledSessionGuards,
    /// Per-tunnel supervisor task that watches for forwarder / session death and
    /// drives the tunnel to `Error` (#1243). `None` only in the brief window
    /// before it is spawned. Dropped (detached) when the supervisor self-reaps on
    /// death; aborted by `stop_tunnel`/`stop_all`.
    supervisor: Option<tokio::task::JoinHandle<()>>,
    /// Cancelled by `stop_tunnel`/`stop_all` before teardown so the supervisor
    /// exits cleanly — a user stop must never be mistaken for a real death and
    /// launder the tunnel into `Error`.
    supervisor_cancel: CancellationToken,
}

/// The saved tunnels read from disk, before a [`TunnelManager`] is built over
/// them. Loading needs no `AppHandle` of a particular runtime (#5313).
pub struct LoadedTunnels {
    storage: TunnelStorage,
    store: TunnelStore,
    /// Recovery warnings from the load (a corrupt or newer-version file).
    pub warnings: Vec<RecoveryWarning>,
}

impl LoadedTunnels {
    /// Resolve the tunnel storage and load it with recovery: a corrupt file is
    /// backed up and salvaged into a warning rather than failing.
    pub fn load<R: Runtime>(app_handle: &AppHandle<R>) -> Result<Self> {
        let storage =
            TunnelStorage::new(app_handle).context("Failed to initialize tunnel storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load tunnels")?;
        Ok(Self {
            storage,
            store: result.data,
            warnings: result.warnings,
        })
    }
}

/// Central manager for SSH tunnels.
///
/// Handles CRUD operations on tunnel configurations, starting/stopping tunnels,
/// and tracking live tunnel state.
pub struct TunnelManager<R: Runtime = Wry> {
    tunnel_configs: Mutex<TunnelStore>,
    storage: TunnelStorage,
    /// `Arc`-shared so each per-tunnel supervisor task can hold a handle and
    /// self-reap its own entry on death (#1243) without a `&self` reference.
    active_tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
    /// Last error per tunnel id, making a failed start a durable, queryable
    /// resting state that survives a `loadTunnels` reload (GAP 3, #1238). An
    /// entry is set when a start fails and committed (not cancelled), and
    /// cleared on a successful start or an explicit stop. `Arc`-shared so the
    /// supervisor can record a death cause (#1243).
    last_errors: Arc<Mutex<HashMap<String, Reason>>>,
    /// Cancel tokens for in-flight reconnect-backoff loops, keyed by tunnel id
    /// (#1246, GAP 5). A tunnel with `reconnect_on_disconnect` on is NOT in
    /// `active_tunnels` while retrying, so `stop_tunnel`/`stop_all` cancel the
    /// backoff loop through this registry instead. `Arc`-shared so the supervisor
    /// task can register/deregister its own loop without `&self`.
    reconnecting: Arc<Mutex<HashMap<String, Reconnecting>>>,
    connecting: ConnectingTracker,
    /// What is known about the tunnels on agents, and about the automatic starts
    /// that wait (S3, #2185, #6028). Disjoint from `active_tunnels`, which holds
    /// the desktop-hosted forwarders. Shared with the `tunnel.status` poller.
    hosted: HostedServices<HostedTunnels>,
    /// Pool of SSH endpoint sessions shared by local/dynamic forwarders on the
    /// same connection. Jump-host gateway sessions are pooled separately in the
    /// process-wide [`shared_gateway_pool`](termihub_core::backends::ssh::session_pool::shared_gateway_pool).
    endpoint_pool: Arc<RefPool<Arc<LiveEndpoint>>>,
    app_handle: AppHandle<R>,
    /// Handle to the single periodic live-stats emitter task (GAP 6, #1248).
    /// `Some` while at least one tunnel is active; the task self-reaps and clears
    /// this slot once no tunnel remains, and `stop_all` aborts it on shutdown.
    stats_emitter: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// The single periodic agent `tunnel.status` poller (#2199). Runs while at
    /// least one agent-hosted tunnel exists, self-reaping once none remain.
    /// Distinct from `stats_emitter` because agent tunnels live in their own track
    /// (`hosted`) and are sampled over the agent RPC rather than from a
    /// local forwarder; the shared [`AgentStatusPoller`] owns the task lifecycle
    /// (DUP-020).
    agent_stats_poller: AgentStatusPoller,
    /// The app-wide owned-task registry (ARCH-007, #3105). The live-stats
    /// emitter, the agent `tunnel.status` poller, and every per-tunnel
    /// supervisor (death-watch + reconnect backoff) are spawned through it and
    /// stop on its cancellation token, so app teardown awaits them (bounded).
    tasks: AppTasks,
    /// The live saved-connection ids, for the tunnels whose SSH connection was
    /// deleted (#2850): such a tunnel is stopped, rests as `MissingConnection`
    /// and refuses to start until it is repointed.
    connection_refs: ConnectionRefs,
}

impl<R: Runtime> TunnelManager<R> {
    /// Build the manager over the tunnels [`LoadedTunnels::load`] read from
    /// disk (with recovery, so a corrupt file is handled gracefully). The
    /// `AppHandle`-bound half of startup, split from the load so the boot phase
    /// loads the file on a mock app (#5313). The caller reports
    /// `loaded.warnings` first; they are not kept on the manager.
    pub fn from_loaded(app_handle: &AppHandle<R>, loaded: LoadedTunnels) -> Self {
        let LoadedTunnels { storage, store, .. } = loaded;
        let tasks = AppTasks::for_app(app_handle);
        // Stops agents owed before the app ended are sent again (#6051).
        let hosted = HostedServices::stored(storage.owed_stops_path());

        Self {
            tunnel_configs: Mutex::new(store),
            storage,
            active_tunnels: Arc::new(Mutex::new(HashMap::new())),
            last_errors: Arc::new(Mutex::new(HashMap::new())),
            reconnecting: Arc::new(Mutex::new(HashMap::new())),
            connecting: ConnectingTracker::new(),
            hosted,
            endpoint_pool: RefPool::new(),
            app_handle: app_handle.clone(),
            stats_emitter: Arc::new(Mutex::new(None)),
            agent_stats_poller: AgentStatusPoller::with_tasks(tasks.clone()),
            tasks,
            connection_refs: ConnectionRefs::default(),
        }
    }

    /// Get all saved tunnel configurations.
    pub fn get_tunnels(&self) -> Result<Vec<TunnelConfig>, TerminalError> {
        let store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        Ok(store.tunnels.clone())
    }

    /// The id of the companion tunnel linked to `parent_id`, if a chained
    /// desktop hop exists for it (#2597). `None` when the tunnel is unchained or
    /// is itself a companion.
    fn companion_id_of(&self, parent_id: &str) -> Option<String> {
        let store = self.tunnel_configs.lock().ok()?;
        find_companion(&store.tunnels, parent_id).map(|c| c.id.clone())
    }

    /// Whether a tunnel currently has a live or in-flight presence — active
    /// (desktop or agent), waiting to start, reconnecting, or mid-connect. Used to gate the
    /// companion ordered-lifecycle so a steady pair emits no churn (#2597).
    fn is_tunnel_active(&self, tunnel_id: &str) -> bool {
        map_contains(&self.active_tunnels, tunnel_id)
            || self.hosted.is_engaged(tunnel_id)
            || map_contains(&self.reconnecting, tunnel_id)
            || self.connecting.is_connecting(tunnel_id)
    }

    /// Whether a tunnel is fully `Connected` — present in the desktop or agent
    /// active maps (as opposed to merely connecting / reconnecting). A chained
    /// companion may only start once its parent is connected (#2597).
    fn is_tunnel_connected(&self, tunnel_id: &str) -> bool {
        map_contains(&self.active_tunnels, tunnel_id) || self.hosted.is_running(tunnel_id)
    }

    /// Save (add or update) a tunnel configuration.
    ///
    /// A tunnel that is moved to another machine is stopped where it runs, so
    /// its port does not stay open there (#6028).
    pub fn save_tunnel(&self, config: TunnelConfig) -> Result<(), TerminalError> {
        let id = config.id.clone();
        let moved = {
            let mut store = self
                .tunnel_configs
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            let moved = store.upsert(config);
            self.storage.save(&store).map_err(|e| {
                TerminalError::TunnelError(format!("Failed to save tunnels: {}", e))
            })?;
            moved
        };
        if moved {
            self.stop_tunnel(&id)?;
        }
        Ok(())
    }

    /// Re-point every saved tunnel's SSH connection along `remap` (#3596),
    /// persisting only when a tunnel changed. The write is atomic and memory is
    /// updated only after it succeeded. A running tunnel keeps running: it holds
    /// its resolved session; a later start or reconnect re-reads the config.
    /// Returns whether anything changed.
    pub fn follow_connection_id_changes(
        &self,
        remap: &crate::connection::id_changes::ConnectionIdRemap,
    ) -> Result<bool, TerminalError> {
        let mut store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let mut next = store.clone();
        if !next.follow_connection_id_changes(remap) {
            return Ok(false);
        }
        self.storage
            .save(&next)
            .map_err(|e| TerminalError::TunnelError(format!("Failed to save tunnels: {}", e)))?;
        *store = next;
        Ok(true)
    }

    /// Delete a tunnel configuration. Stops the tunnel first if active.
    ///
    /// Deleting a chained parent **cascades**: its companion desktop hop is
    /// stopped (by `stop_tunnel` below) and its config is removed too, so no
    /// orphan desktop tunnel is left pointing at a now-gone agent port (#2597).
    /// Deleting a companion removes only itself, which clears the parent's
    /// derived link.
    pub fn delete_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        // Stop if active. `stop_tunnel` already stops a linked companion first,
        // so the whole pair is torn down before the configs are dropped.
        self.stop_tunnel(tunnel_id)?;

        let mut store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        // Remove the target plus its companion (if any) — a parent-delete cascade.
        let companion_id = find_companion(&store.tunnels, tunnel_id).map(|c| c.id.clone());
        store
            .tunnels
            .retain(|t| t.id != tunnel_id && Some(&t.id) != companion_id.as_ref());

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::TunnelError(format!("Failed to save tunnels: {}", e)))?;

        Ok(())
    }

    /// Reconcile the tunnels against the live saved-connection ids (#2850):
    /// every running tunnel whose SSH connection is gone is stopped, and every
    /// tunnel whose SSH connection is gone rests as `MissingConnection` until it
    /// is repointed. Returns the stopped tunnel ids. The caller republishes the
    /// `tunnels` region.
    pub fn reconcile_connections(&self, live: LiveConnections) -> Vec<String> {
        self.connection_refs.reconcile(live, self)
    }

    /// Get the current status of all tunnels.
    pub fn get_statuses(&self) -> Result<Vec<TunnelState>, TerminalError> {
        // Copied first: naming an agent below asks the connection manager, which
        // must not happen under a lock of this one.
        let tunnels = self.get_tunnels()?;
        let views: Vec<_> = tunnels
            .iter()
            .map(|config| {
                let host = match config.host.choice() {
                    HostChoice::Agent(agent_id) => Some(agent_id),
                    _ => None,
                };
                let view = self.hosted.view(&config.id, host)?;
                Some(tunnel_state(config, view, &AppReasons(&self.app_handle)))
            })
            .collect();
        let active = self
            .active_tunnels
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let reconnecting = self
            .reconnecting
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        let states = tunnels
            .iter()
            .zip(views)
            .map(|(config, view)| {
                if let Some(tunnel) = active.get(&config.id) {
                    TunnelState::desktop(
                        config.id.clone(),
                        TunnelStatus::Connected,
                        None,
                        tunnel.forwarder.get_stats(),
                    )
                } else if let Some(state) = view {
                    // Running on an agent, not reachable there, waiting, starting
                    // or stopping (#2185, #6028).
                    state
                } else if let Some(reconnecting) = reconnecting.get(&config.id) {
                    // In a reconnect-backoff loop (#1246) — report `Reconnecting`
                    // so a reload does not briefly launder it back to Error.
                    TunnelState::desktop(
                        config.id.clone(),
                        TunnelStatus::Reconnecting,
                        Some(reconnecting_reason(reconnecting.attempt, reconnecting.at).into()),
                        TunnelStats::default(),
                    )
                } else if let Some(status) = self.connection_refs.resting_status(config) {
                    // Its SSH connection was deleted (#2850): it rests in the
                    // explicit unresolved state until it is repointed.
                    TunnelState::desktop(config.id.clone(), status, None, TunnelStats::default())
                } else {
                    // A tunnel that is neither active nor connecting rests as
                    // either `Disconnected` (never failed) or `Error` (its last
                    // start failed) — the latter carries the recorded message so
                    // it survives a reload instead of being laundered back to
                    // `Disconnected` (GAP 3, #1238).
                    let (status, error) = resting_status(
                        self.connecting.is_connecting(&config.id),
                        last_error_for(&self.last_errors, &config.id),
                    );
                    TunnelState::desktop(config.id.clone(), status, error, TunnelStats::default())
                }
            })
            .collect();

        Ok(states)
    }

    /// The live traffic stats of every running tunnel, keyed by tunnel id
    /// (#4574).
    ///
    /// The stats-only slice of [`Self::get_statuses`], for the 1 Hz stats tick's
    /// projection delta: a desktop tunnel reports its forwarder's counters, an
    /// agent-hosted one the stats last sampled by the `tunnel.status` poller —
    /// with the same desktop-first precedence `get_statuses` applies. Locks
    /// `active_tunnels` first; a poisoned lock yields no samples for that track.
    /// A tunnel that is not reachable has no live stats (#6028).
    pub fn live_stats(&self) -> Vec<(String, TunnelStats)> {
        let mut out = Vec::new();
        if let Ok(active) = self.active_tunnels.lock() {
            out.extend(
                active
                    .iter()
                    .map(|(id, tunnel)| (id.clone(), tunnel.forwarder.get_stats())),
            );
        }
        for (id, tunnel) in self.hosted.running() {
            if !out.iter().any(|(seen, _)| *seen == id) {
                out.push((id, tunnel.stats));
            }
        }
        out
    }

    /// Start a tunnel by ID, on the user's request.
    pub fn start_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        self.start(tunnel_id, StartedBy::User)
    }

    /// Start a tunnel. An automatic start that is not possible yet waits (#6028).
    fn start(&self, tunnel_id: &str, by: StartedBy) -> Result<(), TerminalError> {
        // Get tunnel config
        let config = {
            let store = self
                .tunnel_configs
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            store
                .tunnels
                .iter()
                .find(|t| t.id == tunnel_id)
                .cloned()
                .ok_or_else(|| {
                    TerminalError::TunnelError(format!("Tunnel not found: {}", tunnel_id))
                })?
        };

        // A tunnel whose SSH connection was deleted cannot resolve its handshake;
        // refuse it until the user repoints it (#2850). Not recorded as a last
        // error: the tunnel keeps resting in its `MissingConnection` state.
        self.connection_refs.ensure_resolved(&config)?;

        // A chained companion cannot bind usefully until its parent's listen
        // socket exists, so starting a companion first ensures the parent is up
        // (#2597). If the parent is not yet connected, start it and return: the
        // parent reaching `Connected` brings the companion up through the
        // status-emit orchestration, in the correct order. If the parent is
        // already connected (e.g. the user restarts a companion they stopped
        // directly), fall through and start the companion now.
        if let Some(parent_id) = config.companion_of.clone() {
            if !self.is_tunnel_connected(&parent_id) {
                return self.start(&parent_id, by);
            }
        }

        // Route by run-location (S3, #2155/#2185). Desktop-hosted tunnels (the
        // default) take the existing local forwarder path below; agent-hosted
        // tunnels are forwarded on the agent over the agent RPC.
        let agent_id = match resolve_tunnel_host(&config.host) {
            Ok(ResolvedLocation::Local) => None,
            Ok(ResolvedLocation::Agent(agent_id)) => Some(agent_id),
            Err(message) => return Err(self.refuse(tunnel_id, message)),
        };

        // Only the user may undo the user's stop.
        if agent_id
            .as_deref()
            .is_some_and(|agent_id| self.hosted.stop_wins(agent_id, tunnel_id, by))
        {
            return Ok(());
        }
        if let Some(on) = self.not_ready(&config, agent_id.as_deref()) {
            if by != StartedBy::User {
                self.wait(tunnel_id, on);
                return Ok(());
            }
            // "Start now" on a waiting tunnel that still cannot: it goes on waiting.
            if let Some(until) = self.hosted.waits_until(tunnel_id) {
                return Err(TerminalError::TunnelError(waiting_reason(&on, until).text));
            }
        }

        // Check if already active
        {
            let active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            if active.contains_key(tunnel_id) {
                return Err(TerminalError::TunnelError(format!(
                    "Tunnel {} is already active",
                    tunnel_id
                )));
            }
        }

        let ticket = match by {
            StartedBy::User => self.hosted.begin(tunnel_id).map_err(|busy| {
                TerminalError::TunnelError(match busy {
                    Busy::Starting => format!("Tunnel {tunnel_id} is already connecting"),
                    Busy::Running => format!("Tunnel {tunnel_id} is already active"),
                })
            })?,
            // Started, or stopped, another way meanwhile.
            StartedBy::Itself => match self.hosted.begin(tunnel_id) {
                Ok(ticket) => ticket,
                Err(_) => return Ok(()),
            },
            StartedBy::Wait => match self.hosted.begin_waiting(tunnel_id) {
                Some(ticket) => ticket,
                None => return Ok(()),
            },
        };
        match agent_id {
            Some(agent_id) => self.start_agent_tunnel(ticket, &config, &agent_id, by),
            None => {
                let started = self.start_desktop_tunnel(tunnel_id, &config);
                if self.finish(ticket, Outcome::Failed, tunnel_id) {
                    if let Err(e) = &started {
                        // The failure was published while the start still
                        // counted as starting, so the UI kept "connecting"
                        // (#6139): publish where it rests now.
                        tracing::warn!("Tunnel {tunnel_id} did not start: {e}");
                        self.emit_status(tunnel_id, self.resting_status_of(tunnel_id));
                    }
                    started
                } else {
                    // A stop pressed while it started.
                    self.stop_tunnel(tunnel_id)
                }
            }
        }
    }

    /// The status `tunnel_id` rests in now, as the UI is sent it.
    fn resting_status_of(&self, tunnel_id: &str) -> TunnelStatus {
        self.get_statuses()
            .ok()
            .and_then(|states| states.into_iter().find(|s| s.tunnel_id == tunnel_id))
            .map_or(TunnelStatus::Disconnected, |state| state.status)
    }

    /// What an automatic start of `config` has to wait for, if anything.
    fn not_ready(&self, config: &TunnelConfig, agent_id: Option<&str>) -> Option<WaitFor> {
        if let Some(agent_id) = agent_id {
            // A removed agent never comes back: the start refuses it.
            if !agent_is_ready(&self.app_handle, agent_id)
                && !agent_is_removed(&self.app_handle, agent_id)
            {
                return Some(WaitFor::Agent(agent_id.to_string()));
            }
        }
        self.app_handle
            .try_state::<ConnectionManager>()
            .is_some_and(|connections| {
                connections.jump_hosts_need_unlock(&config.ssh_connection_id)
            })
            .then_some(WaitFor::CredentialStore)
    }

    /// Let the automatic start of `tunnel_id` wait for `on`.
    fn wait(&self, tunnel_id: &str, on: WaitFor) {
        if self.hosted.wait(tunnel_id, on, Instant::now()) {
            clear_last_error(&self.last_errors, tunnel_id);
            self.emit_status(tunnel_id, TunnelStatus::Waiting);
        }
        self.ensure_status_poller();
    }

    /// Stop and start a tunnel, on the user's request. When it cannot start yet
    /// it waits; the stop is done first either way.
    pub fn restart_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        if self.retry_reconnect_now(tunnel_id) {
            return Ok(());
        }
        self.stop_tunnel(tunnel_id)?;
        let config = self
            .get_tunnels()?
            .into_iter()
            .find(|t| t.id == tunnel_id)
            .ok_or_else(|| {
                TerminalError::TunnelError(format!("Tunnel not found: {}", tunnel_id))
            })?;
        if let HostChoice::Agent(agent_id) = config.host.choice() {
            if let Some(on) = self.not_ready(&config, Some(agent_id)) {
                if self.hosted.wait_to_restart(tunnel_id, on, Instant::now()) {
                    self.emit_status(tunnel_id, TunnelStatus::Waiting);
                }
                self.ensure_status_poller();
                return Ok(());
            }
        }
        self.start_tunnel(tunnel_id)
    }

    /// Start every waiting tunnel that can start now, and end the waits that
    /// took too long. Blocking: called on every tick of the poller.
    fn start_ready(&self) {
        self.start_ready_at(Instant::now());
    }

    fn start_ready_at(&self, now: Instant) {
        for (id, on) in self.hosted.take_expired(now) {
            let _ = self.refuse(&id, waited_too_long(&on));
        }
        for (id, _) in self.hosted.waiting() {
            if let Err(e) = self.start(&id, StartedBy::Wait) {
                tracing::warn!("Failed to start waiting tunnel {id}: {e}");
            }
        }
        let app = &self.app_handle;
        for id in self
            .hosted
            .forget_removed_agents(|agent_id| agent_is_removed(app, agent_id))
        {
            self.emit_status(&id, TunnelStatus::Disconnected);
        }
    }

    /// Show on the rows what a poll tick changed.
    fn show_changes(self: &Arc<Self>, changes: Vec<Change>) {
        for change in changes {
            match change {
                Change::Sampled { news: false, .. } => {}
                Change::Sampled { id, .. } => self.emit_status(&id, TunnelStatus::Connected),
                Change::Presence(id) => {
                    let status = if self.hosted.is_running(&id) {
                        TunnelStatus::Connected
                    } else {
                        TunnelStatus::NotReachable
                    };
                    self.emit_status(&id, status);
                }
                Change::Stopped(id) => self.emit_status(&id, TunnelStatus::Disconnected),
                Change::Gone { id, unanswered, .. } => {
                    let reconnect = self
                        .get_tunnels()
                        .unwrap_or_default()
                        .iter()
                        .any(|t| t.id == id && t.reconnect_on_disconnect);
                    match gone_tunnel(unanswered, reconnect) {
                        GoneTunnel::NotStarted => {
                            let _ = self.refuse(&id, unanswered_start_failed());
                        }
                        GoneTunnel::Stopped => self.emit_status(&id, TunnelStatus::Disconnected),
                        GoneTunnel::StartAgain => {
                            self.emit_status(&id, TunnelStatus::Disconnected);
                            let manager = Arc::clone(self);
                            tokio::task::spawn_blocking(move || {
                                if let Err(e) = manager.start(&id, StartedBy::Itself) {
                                    tracing::warn!("Failed to start tunnel {id} again: {e}");
                                }
                            });
                        }
                    }
                }
            }
        }
    }

    /// Record and announce why `tunnel_id` was not started, and build the error
    /// for the caller.
    fn refuse(&self, tunnel_id: &str, reason: impl Into<Reason>) -> TerminalError {
        let reason = reason.into();
        record_last_error(&self.last_errors, tunnel_id, reason.clone());
        self.emit_status(tunnel_id, TunnelStatus::Error);
        TerminalError::TunnelError(reason.text)
    }

    /// Why `config` did not start on this computer, as its row says it (#6063).
    fn local_start_reason(&self, config: &TunnelConfig, error: &TerminalError) -> Reason {
        let server = self
            .app_handle
            .try_state::<ConnectionManager>()
            .and_then(|connections| connections.saved_connection_name(&config.ssh_connection_id))
            .unwrap_or_else(|| "The SSH server".to_string());
        // Behind a jump host it may be that one that refused.
        let direct = self
            .resolve_ssh_config(&config.ssh_connection_id)
            .is_ok_and(|ssh| ssh.proxy_jump.is_empty());
        start_reason(&config.tunnel_type, &server, direct, error)
    }

    /// End a start: `true` when it counts, `false` when a stop was pressed
    /// meanwhile (what it started on an agent is stopped again).
    fn finish(&self, ticket: Ticket, outcome: Outcome<HostedTunnel>, tunnel_id: &str) -> bool {
        match self.hosted.finish(ticket, outcome, Instant::now()) {
            Finished::Done => true,
            Finished::Stopped => {
                self.emit_status(tunnel_id, TunnelStatus::Disconnected);
                false
            }
            Finished::StopThere(agent_id) => {
                self.settle_stop(&agent_id, tunnel_id);
                false
            }
        }
    }

    /// Start a tunnel on this computer.
    fn start_desktop_tunnel(
        &self,
        tunnel_id: &str,
        config: &TunnelConfig,
    ) -> Result<(), TerminalError> {
        // Mark as connecting so a Stop click during the handshake can cancel
        // this start before it is registered as active (#829). The returned
        // token is threaded into the SSH connect so a Stop aborts an in-flight
        // handshake promptly rather than waiting it out (#841).
        let cancel = self.connecting.begin(tunnel_id).ok_or_else(|| {
            TerminalError::TunnelError(format!("Tunnel {} is already connecting", tunnel_id))
        })?;

        // Emit connecting status
        self.emit_status(tunnel_id, TunnelStatus::Connecting);

        // Build the forwarder (resolves the SSH config and performs the
        // handshake). On failure, surface it as `error` status instead of
        // leaving the tunnel stuck in `connecting` (#829) — unless a Stop was
        // requested mid-connect, in which case it has already gone disconnected.
        let (forwarder, guards, liveness) = match self.build_forwarder(config, cancel) {
            Ok(built) => built,
            Err(e) => {
                match self.connecting.finish(tunnel_id) {
                    FinishOutcome::Cancel => {
                        self.emit_status(tunnel_id, TunnelStatus::Disconnected);
                    }
                    FinishOutcome::Commit => {
                        // Persist the failure so `Error` is a durable, queryable
                        // resting state, not just a fire-and-forget event that a
                        // reload launders away (GAP 3, #1238).
                        let reason = self.local_start_reason(config, &e);
                        return Err(self.refuse(tunnel_id, reason));
                    }
                }
                return Err(e);
            }
        };

        // Honour a Stop requested while connecting: tear the just-built
        // forwarder down rather than leaving an orphaned tunnel the user
        // thought they had stopped.
        if !matches!(self.connecting.finish(tunnel_id), FinishOutcome::Commit) {
            self.teardown_forwarder(forwarder, guards);
            self.emit_status(tunnel_id, TunnelStatus::Disconnected);
            tracing::info!("Tunnel {} start cancelled by stop request", tunnel_id);
            return Ok(());
        }

        // Register as active and spawn the per-tunnel supervisor (#1243), passing
        // the reconnect toggle so a later death enters the backoff loop (#1246).
        self.register_and_supervise(
            tunnel_id,
            forwarder,
            guards,
            liveness,
            config.reconnect_on_disconnect,
        )?;

        // A successful start clears any recorded failure so the tunnel no longer
        // rests in `Error` once it is running again (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

        // Emit connected status
        self.emit_status(tunnel_id, TunnelStatus::Connected);

        // Ensure the periodic live-stats emitter is running now that a tunnel is
        // active, so the sidebar's ↑/↓ bytes + conn count update live rather than
        // resting at the zeros of the initial status (GAP 6, #1248).
        self.ensure_stats_emitter();

        tracing::info!("Tunnel {} started", tunnel_id);
        Ok(())
    }

    /// Map a desktop [`TunnelType`] to the shared agent-wire [`TunnelForwardSpec`]
    /// sent as `tunnel.start`'s `forward` parameter (DUP-019).
    ///
    /// Both enums wrap the same core forward-config structs, so mapping through
    /// the shared [`TunnelForwardSpec`] makes its `#[serde(tag = "mode")]`
    /// discriminator the single source of truth for the `mode` string. This
    /// replaces the previous hand-poked `forward["mode"] = json!("local"/…)` where
    /// the literals were duplicated on the desktop and would desync **silently**
    /// if the agent enum's serde rename ever changed. Now a rename fails the
    /// golden/contract tests at build time instead of the CI-dark integration lane
    /// at runtime.
    ///
    /// Returns the typed spec (not a pre-serialized `Value`) so the caller can
    /// embed it directly in the shared [`TunnelStartParams`] DTO; the wire bytes
    /// are pinned by `agent_forward_wire_bytes_are_stable`.
    fn forward_spec(tunnel_type: &TunnelType) -> TunnelForwardSpec {
        match tunnel_type {
            TunnelType::Local(config) => TunnelForwardSpec::Local(config.clone()),
            TunnelType::Remote(config) => TunnelForwardSpec::Remote(config.clone()),
            TunnelType::Dynamic(config) => TunnelForwardSpec::Dynamic(config.clone()),
        }
    }

    /// Start a tunnel hosted on a remote agent (S3, #2185).
    ///
    /// The agent runs the SSH client; the desktop sends only control over the
    /// agent RPC. Forwards **local** (`ssh -L`) and **remote** (`ssh -R`)
    /// tunnels on the agent — for `-L` the listen socket binds on the agent, for
    /// `-R` the SSH server binds it and the target is resolved from the agent,
    /// and for `-D` the SOCKS5 proxy listen socket binds on the agent while each
    /// connection's target is resolved from the server (see the
    /// endpoint-semantics concept). On success the agent-reported `bound_address`
    /// / `reachable_from` are stored for the projection and the tunnel rests
    /// `Connected`.
    ///
    /// A start that gets no answer leaves the tunnel not reachable, not stopped
    /// (#6028): it may run there, and the poller asks until the agent says.
    fn start_agent_tunnel(
        &self,
        ticket: Ticket,
        config: &TunnelConfig,
        agent_id: &str,
        by: StartedBy,
    ) -> Result<(), TerminalError> {
        let tunnel_id = config.id.as_str();
        // Build the agent's internally-tagged `TunnelForwardSpec` (a `mode`
        // discriminator plus the flattened forward config) via the shared type, so
        // the `mode` string is sourced from the agent enum's serde and can never
        // silently desync (DUP-019). Local, remote, and dynamic all run on an
        // agent (#2185, #2198).
        let forward = Self::forward_spec(&config.tunnel_type);

        self.emit_status(tunnel_id, TunnelStatus::Connecting);

        let failed = |ticket: Ticket, reason: Reason| {
            if self.finish(ticket, Outcome::Failed, tunnel_id) {
                Err(self.refuse(tunnel_id, reason))
            } else {
                Ok(())
            }
        };

        // Resolve the SSH connection so the agent can open the session to the
        // "via" server itself; any inline jump-host chain is already expanded.
        let ssh_config = match self.resolve_ssh_config(&config.ssh_connection_id) {
            Ok(cfg) => cfg,
            Err(e) => return failed(ticket, plain_reason(&e).into()),
        };
        let client = match agent_for_start(&self.app_handle, agent_id) {
            Ok(client) => client,
            // The agent went away since it was ready: wait for it again.
            Err(_) if by != StartedBy::User && !agent_is_removed(&self.app_handle, agent_id) => {
                if self.finish(ticket, Outcome::Failed, tunnel_id) {
                    self.wait(tunnel_id, WaitFor::Agent(agent_id.to_string()));
                }
                return Ok(());
            }
            Err(reason) => return failed(ticket, reason),
        };

        // Build the tunnel.start request from the shared `TunnelStartParams` DTO
        // (DUP-001): the desktop and agent now share one definition of the params
        // wire shape. `forward` is the agent's internally-tagged
        // `TunnelForwardSpec` (built above): the forward-config fields plus a
        // `mode` discriminator.
        let params = match serde_json::to_value(TunnelStartParams {
            tunnel_id: tunnel_id.to_string(),
            ssh_config,
            forward,
        }) {
            Ok(params) => params,
            Err(e) => {
                let reason = format!("Failed to serialize tunnel.start params: {e}");
                return failed(ticket, reason.into());
            }
        };

        // An older stop the agent has not confirmed comes first: it would refuse
        // the start of a tunnel that still runs.
        if !self
            .hosted
            .send_owed_stop(client.as_ref(), agent_id, tunnel_id, Instant::now())
        {
            let reason = stopping_reason(&self.app_handle, agent_id).text;
            if !self.finish(ticket, Outcome::Failed, tunnel_id) {
                return Ok(());
            }
            self.emit_status(tunnel_id, TunnelStatus::Stopping);
            return Err(TerminalError::TunnelError(reason));
        }

        let agent = agent_id.to_string();
        let reply = match client.send_request(agent_id, TUNNEL_START, params) {
            // It still runs there from before an app restart (#6051): it is
            // that one, and the poller reads what it binds.
            Err(e) if already_runs_there(&e) => Ok(serde_json::Value::Null),
            reply => reply,
        };
        match reply {
            Ok(result) => {
                let state = if result.is_null() {
                    HostedTunnel::default()
                } else {
                    HostedTunnel::from_start_reply(result)
                };
                tracing::info!(
                    "Tunnel {} started on agent {} (bound {} on the agent, reachable from {:?})",
                    tunnel_id,
                    agent_id,
                    state.bound_address,
                    state.reachable_from
                );
                let outcome = Outcome::Started {
                    agent_id: agent,
                    state,
                };
                if !self.finish(ticket, outcome, tunnel_id) {
                    return Ok(());
                }
                clear_last_error(&self.last_errors, tunnel_id);
                self.emit_status(tunnel_id, TunnelStatus::Connected);
            }
            Err(e) if is_unanswered(&e) => {
                tracing::warn!(%tunnel_id, %agent_id, error = %e, "start got no answer");
                let outcome = Outcome::Unanswered {
                    agent_id: agent,
                    state: HostedTunnel::default(),
                };
                if !self.finish(ticket, outcome, tunnel_id) {
                    return Ok(());
                }
                clear_last_error(&self.last_errors, tunnel_id);
                self.emit_status(tunnel_id, TunnelStatus::NotReachable);
            }
            Err(e) => {
                let reason = agent_start_error(&e);
                return failed(ticket, reason);
            }
        }
        // Ask the agent from now on: the live stats (#2199), and whether it still
        // runs there.
        self.ensure_status_poller();
        // Moved or deleted while the agent was starting it: not there.
        let still_there = self
            .get_tunnels()?
            .iter()
            .any(|t| t.id == tunnel_id && t.host.choice() == HostChoice::Agent(agent_id));
        if !still_there {
            self.stop_tunnel(tunnel_id)?;
            return Err(TerminalError::TunnelError(format!(
                "Tunnel {tunnel_id} was moved or deleted while it was starting"
            )));
        }
        Ok(())
    }

    /// Send the stop that agent `agent_id` owes for `tunnel_id`, off this thread
    /// (a Stop runs on the UI thread). What the agent does not confirm now, the
    /// poller sends again.
    fn settle_stop(&self, agent_id: &str, tunnel_id: &str) {
        self.emit_status(tunnel_id, TunnelStatus::Stopping);
        let hosted = self.hosted.clone();
        let app = self.app_handle.clone();
        let (agent_id, tunnel_id) = (agent_id.to_string(), tunnel_id.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            let confirmed = agent_rpc_client(&app).is_some_and(|client| {
                hosted.send_owed_stop(client.as_ref(), &agent_id, &tunnel_id, Instant::now())
            });
            if confirmed {
                tracing::info!("Tunnel {tunnel_id} stopped on agent {agent_id}");
                emit_tunnel_status(&app, &tunnel_id, TunnelStatus::Disconnected);
            } else {
                tracing::warn!("Agent {agent_id} has not confirmed the stop of {tunnel_id}");
            }
        });
        self.ensure_status_poller();
    }

    /// Ensure the single periodic live-stats emitter task is running.
    ///
    /// Idempotent: if a task is already tracked in `stats_emitter` it is left
    /// alone. Otherwise a new task is spawned that, every [`STATS_EMIT_INTERVAL`],
    /// republishes the `tunnels` projection region, whose statuses carry every
    /// active tunnel's live [`ForwarderStats`]. The task self-terminates (and
    /// clears the tracking slot) as soon as no tunnel is active, so a dead/errored
    /// tunnel reaped by its supervisor (#1243) naturally stops emitting.
    fn ensure_stats_emitter(&self) {
        let mut slot = match self.stats_emitter.lock() {
            Ok(slot) => slot,
            Err(_) => return,
        };
        // Already running (and not yet finished) — nothing to do.
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }

        let app_handle = self.app_handle.clone();
        let handle = spawn_stats_emitter(
            &self.tasks,
            Arc::clone(&self.active_tunnels),
            Arc::clone(&self.stats_emitter),
            move || {
                // Project live stats onto the `tunnels` region (#2150): the
                // per-tick ↑/↓ + conn counts reach the frontend only this way.
                // A stats-only delta (#4574) — status/config changes still go
                // through the full `publish_tunnels`. The active-tunnels lock is
                // already released here, so the re-lock inside is safe.
                crate::tunnel::projection::publish_tunnel_stats(&app_handle);
            },
        );

        *slot = Some(handle);
    }

    /// Ensure the single periodic agent `tunnel.status` poller is running
    /// (#2199). Idempotent; the shared [`AgentStatusPoller`] owns the task
    /// lifecycle and the [`AgentTunnelPoll`] delegate supplies the tunnel-specific
    /// poll + stats write-back / projection republish (DUP-020).
    fn ensure_status_poller(&self) {
        self.agent_stats_poller.ensure(self.status_poll());
    }

    fn status_poll(&self) -> AgentTunnelPoll<R> {
        AgentTunnelPoll {
            hosted: self.hosted.clone(),
            app: self.app_handle.clone(),
        }
    }

    /// Take back the stop of a tunnel that its agent has not got (#6076).
    pub fn keep_running(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        let host = self
            .get_tunnels()?
            .into_iter()
            .find(|tunnel| tunnel.id == tunnel_id)
            .map(|tunnel| tunnel.host);
        let agent = host.as_ref().map(|host| host.choice());
        if let Some(HostChoice::Agent(agent_id)) = agent {
            if self.hosted.keep(agent_id, tunnel_id) {
                self.emit_status(tunnel_id, TunnelStatus::NotReachable);
                self.ensure_status_poller();
            }
        }
        Ok(())
    }

    /// Ask the agents about their tunnels now, instead of on the next tick.
    /// Blocking.
    pub fn check_again(&self) {
        poll_now(&self.status_poll());
    }

    /// Build the forwarder for a tunnel config, performing the SSH handshake.
    ///
    /// Returns the forwarder together with the pool references it depends on
    /// (endpoint and/or jump-host gateway). The references are returned rather
    /// than released here: the caller stores them on the [`ActiveTunnel`] (RAII)
    /// so they live exactly as long as the tunnel. If the forwarder fails to
    /// start, the `?` propagation drops the guards and releases the references,
    /// so the pool ref counts never leak.
    ///
    /// The handshake runs named after the tunnel (#5943), so a host-key prompt
    /// it raises tells the user which tunnel asks — a tunnel has no tab.
    fn build_forwarder(
        &self,
        config: &TunnelConfig,
        cancel: CancellationToken,
    ) -> Result<(ActiveForwarder, PooledSessionGuards, Option<LivenessWatch>), TerminalError> {
        let here = ensure_runs_here(&config.host)?;
        in_tunnel_prompt_scope(config, || self.build_forwarder_named(config, cancel, here))
    }

    /// [`build_forwarder`](Self::build_forwarder) inside the tunnel's
    /// prompt-name scope. `_here` proves that the tunnel belongs on this
    /// computer (#6028): nothing can open a forwarder here without it.
    fn build_forwarder_named(
        &self,
        config: &TunnelConfig,
        cancel: CancellationToken,
        _here: RunsHere,
    ) -> Result<(ActiveForwarder, PooledSessionGuards, Option<LivenessWatch>), TerminalError> {
        let ssh_config = self.resolve_ssh_config(&config.ssh_connection_id)?;
        let conn_id = &config.ssh_connection_id;
        let jumped = !ssh_config.proxy_jump.is_empty();
        // Where a start waits, for a start that does not end (#6139).
        tracing::info!(
            tunnel = %config.id,
            host = %ssh_config.host,
            port = ssh_config.port,
            jumped,
            timeout_secs = ssh_config.connect_timeout().as_secs(),
            "Tunnel start: connecting"
        );
        let connecting_since = Instant::now();
        let built = self.build_forwarder_over(config, conn_id, &ssh_config, cancel, jumped);
        match &built {
            Ok(_) => tracing::info!(
                tunnel = %config.id,
                elapsed_ms = connecting_since.elapsed().as_millis() as u64,
                "Tunnel start: forwarder up"
            ),
            Err(e) => tracing::info!(
                tunnel = %config.id,
                elapsed_ms = connecting_since.elapsed().as_millis() as u64,
                "Tunnel start: ended without a forwarder: {e}"
            ),
        }
        built
    }

    /// The forwarder of `config` over the SSH session of `ssh_config`.
    fn build_forwarder_over(
        &self,
        config: &TunnelConfig,
        conn_id: &str,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
        jumped: bool,
    ) -> Result<(ActiveForwarder, PooledSessionGuards, Option<LivenessWatch>), TerminalError> {
        // The returned [`LivenessWatch`] is the native, event-driven session-death
        // signal the supervisor selects over so a dead SSH session surfaces as
        // `Error` even while the local listener keeps accepting (#1243/#1297, GAP 1).
        // Remote forwards own a dedicated session driven purely by the forwarder
        // death signal, so they get no watch here (`None`).
        match &config.tunnel_type {
            TunnelType::Local(local_config) => {
                let (session, guards, liveness) =
                    self.acquire_endpoint(conn_id, ssh_config, cancel, jumped)?;
                let f = LocalForwarder::start(local_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start local forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Local(f), guards, Some(liveness)))
            }
            TunnelType::Dynamic(dynamic_config) => {
                let (session, guards, liveness) =
                    self.acquire_endpoint(conn_id, ssh_config, cancel, jumped)?;
                let f = DynamicForwarder::start(dynamic_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start dynamic forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Dynamic(f), guards, Some(liveness)))
            }
            TunnelType::Remote(remote_config) => {
                // Remote forwarding needs tcpip_forward (&mut SshSession), so it always gets
                // a dedicated connection rather than a pooled shared Arc<SshSession>.
                let (session, registry, guards) =
                    self.acquire_dedicated(ssh_config, cancel, jumped)?;
                let f = RemoteForwarder::start(remote_config, session, registry).map_err(|e| {
                    TerminalError::TunnelError(format!("{REMOTE_FORWARD_FAILED}{e}"))
                })?;
                Ok((ActiveForwarder::Remote(f), guards, None))
            }
        }
    }

    /// Acquire the SSH session a local/dynamic forwarder runs over.
    ///
    /// Without a jump host the session is pooled by connection id and shared with
    /// the other local/dynamic forwarders on the same connection. With a jump
    /// host the target is reached over a shared, pooled gateway session (held by
    /// the returned guards) — the gateway is shared across connections, while the
    /// per-tunnel endpoint session itself is dedicated.
    fn acquire_endpoint(
        &self,
        conn_id: &str,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
        jumped: bool,
    ) -> Result<(Arc<SshSession>, PooledSessionGuards, LivenessWatch), TerminalError> {
        if jumped {
            let (session, _registry, gateway, liveness) =
                self.connect_through_gateway(ssh_config, cancel)?;
            Ok((
                Arc::new(session),
                PooledSessionGuards::gateway(gateway),
                liveness,
            ))
        } else {
            let endpoint = block_on_runtime(self.endpoint_pool.get_or_create_live(
                conn_id,
                // Never adopt a pooled endpoint whose session has already died —
                // its cloned watch is already `true`, which would drive the new
                // tunnel straight to Error. Evict it and dial a fresh one (#1315).
                |ep| !ep.liveness.is_dead(),
                || async move {
                    core_connect_cancellable_with_liveness(ssh_config, Some(cancel))
                        .await
                        .map(|(session, _registry, liveness)| {
                            Arc::new(LiveEndpoint {
                                session: Arc::new(session),
                                liveness,
                            })
                        })
                        // What failed stays known for the row (#6028, slice 10).
                        .map_err(TerminalError::from_session_ssh)
                },
            ))?;
            // Each supervisor gets its own watch receiver clone, so one shared
            // pooled session's death fans out to every tunnel riding it (#1297).
            let session = endpoint.session.clone();
            let liveness = endpoint.liveness.clone();
            Ok((session, PooledSessionGuards::endpoint(endpoint), liveness))
        }
    }

    /// Acquire a dedicated (non-pooled) SSH session for a remote forwarder,
    /// connecting through a shared pooled gateway when a jump host is configured.
    fn acquire_dedicated(
        &self,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
        jumped: bool,
    ) -> Result<(SshSession, ForwardedChannelRegistry, PooledSessionGuards), TerminalError> {
        if jumped {
            // Remote forwards rely on the forwarder death signal, not the session
            // liveness watch, so the watch is dropped here.
            let (session, registry, gateway, _liveness) =
                self.connect_through_gateway(ssh_config, cancel)?;
            Ok((session, registry, PooledSessionGuards::gateway(gateway)))
        } else {
            let (session, registry) = connect_with_registry_cancellable(ssh_config, cancel)?;
            Ok((session, registry, PooledSessionGuards::default()))
        }
    }

    /// Connect to the target through its pooled jump-host gateway, abortable via
    /// `cancel` (#841) so a Stop during the handshake is honoured promptly.
    fn connect_through_gateway(
        &self,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
    ) -> Result<GatewayConnect, TerminalError> {
        block_on_runtime(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    Err(TerminalError::TunnelError("SSH connect cancelled".to_string()))
                }
                res = connect_target_through_pooled_gateway_with_liveness(ssh_config, Some(&cancel)) => {
                    res.map_err(TerminalError::from_session_ssh)
                }
            }
        })
    }

    /// Stop a forwarder and release the pool references it held.
    fn teardown_forwarder(&self, forwarder: ActiveForwarder, guards: PooledSessionGuards) {
        teardown_parts(forwarder, guards);
    }

    /// Spawn the per-tunnel supervisor task (#1243). Holds `Arc` clones of the
    /// shared state so it can self-reap its tunnel on death without `&self`.
    /// Register a freshly-built forwarder as active and spawn its supervisor.
    /// Shared by `start_tunnel` and the reconnect loop (#1246); `reconnect_on_disconnect`
    /// is threaded to the supervisor so a later death enters backoff vs. `Error`.
    fn register_and_supervise(
        &self,
        tunnel_id: &str,
        mut forwarder: ActiveForwarder,
        guards: PooledSessionGuards,
        liveness: Option<LivenessWatch>,
        reconnect_on_disconnect: bool,
    ) -> Result<(), TerminalError> {
        let death = forwarder.take_death_signal();
        let supervisor_cancel = supervisor_cancel_token(&self.tasks);
        let mut active = self
            .active_tunnels
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let supervisor = self.spawn_supervisor(
            tunnel_id.to_string(),
            death,
            liveness,
            supervisor_cancel.clone(),
            reconnect_on_disconnect,
        );
        active.insert(
            tunnel_id.to_string(),
            ActiveTunnel {
                forwarder,
                guards,
                supervisor: Some(supervisor),
                supervisor_cancel,
            },
        );
        Ok(())
    }

    /// One reconnect attempt driven by the backoff loop (#1246): re-resolve the
    /// config, rebuild the forwarder, and re-register + re-supervise it. Returns
    /// `true` on success (the tunnel is `Connected` again), `false` if the build
    /// failed (the loop then backs off and retries). Runs on `&self` — the
    /// supervisor task reaches it via `resolve_managed_arc::<TunnelManager>`,
    /// which resolves the app-managed `Arc<TunnelManager>` (#2168).
    fn attempt_reconnect(&self, tunnel_id: &str) -> bool {
        let config = {
            match self.tunnel_configs.lock() {
                Ok(store) => store.tunnels.iter().find(|t| t.id == tunnel_id).cloned(),
                Err(_) => None,
            }
        };
        let Some(config) = config else {
            return false;
        };
        // A fresh, un-cancelled token: the backoff loop owns Stop via the
        // `reconnecting` registry, not this connect token.
        let cancel = CancellationToken::new();
        let built = match self.build_forwarder(&config, cancel) {
            Ok(built) => built,
            Err(e) => {
                tracing::warn!("Reconnect attempt for tunnel {tunnel_id} failed to build: {e}");
                return false;
            }
        };
        let (forwarder, guards, liveness) = built;
        if self
            .register_and_supervise(
                tunnel_id,
                forwarder,
                guards,
                liveness,
                config.reconnect_on_disconnect,
            )
            .is_err()
        {
            return false;
        }
        clear_last_error(&self.last_errors, tunnel_id);
        self.emit_status(tunnel_id, TunnelStatus::Connected);
        tracing::info!("Tunnel {tunnel_id} reconnected");
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_supervisor(
        &self,
        tunnel_id: String,
        death: Option<tokio::sync::oneshot::Receiver<()>>,
        liveness: Option<LivenessWatch>,
        cancel: CancellationToken,
        reconnect_on_disconnect: bool,
    ) -> tokio::task::JoinHandle<()> {
        let active_tunnels = Arc::clone(&self.active_tunnels);
        let last_errors = Arc::clone(&self.last_errors);
        let reconnecting = Arc::clone(&self.reconnecting);
        let app_handle = self.app_handle.clone();
        // App-owned (ARCH-007, #3105): `cancel` is a child of the app token (see
        // `supervisor_cancel_token`), so teardown ends the death-watch — and any
        // reconnect backoff it entered — and awaits the task, bounded.
        self.tasks.spawn(async move {
            supervise(
                active_tunnels,
                last_errors,
                reconnecting,
                app_handle,
                tunnel_id,
                death,
                liveness,
                cancel,
                reconnect_on_disconnect,
            )
            .await;
        })
    }

    /// Stop an active tunnel by ID.
    pub fn stop_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        // Stop a chained companion before its parent (#2597): the companion's
        // forward target is the parent's listen socket, so it must go down first
        // or it would dangle at a dead port. A companion has no companion of its
        // own, so this recurses at most one level.
        if let Some(companion_id) = self.companion_id_of(tunnel_id) {
            let _ = self.stop_tunnel(&companion_id);
        }

        // An explicit stop dismisses any recorded failure, returning the tunnel
        // from the `Error` resting state to `Disconnected` (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

        // A tunnel on an agent (S3, #2185) or on its way there: its stop is owed
        // until the agent confirms it, however long it is away (#6028).
        let plan = self.hosted.stop(tunnel_id);
        tracing::info!("Tunnel {tunnel_id} stop requested ({plan:?})");
        let start_will_stop = matches!(plan, StopPlan::StartWillStop);
        match plan {
            StopPlan::StopThere(agent_id) => {
                self.settle_stop(&agent_id, tunnel_id);
                return Ok(());
            }
            // A start on this computer is cancelled below; one on an agent stops
            // what it started when it ends.
            StopPlan::StartWillStop => self.emit_status(tunnel_id, TunnelStatus::Stopping),
            StopPlan::StoppedWaiting => self.emit_status(tunnel_id, TunnelStatus::Disconnected),
            StopPlan::Nothing => {}
        }

        let tunnel = {
            let mut active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            active.remove(tunnel_id)
        };

        if let Some(tunnel) = tunnel {
            let ActiveTunnel {
                forwarder,
                guards,
                supervisor,
                supervisor_cancel,
            } = tunnel;
            // Cancel + abort the supervisor first so the teardown-induced forwarder
            // death is not mistaken for a real death that would re-emit `Error`
            // over this `Disconnected` (#1243).
            supervisor_cancel.cancel();
            if let Some(handle) = supervisor {
                handle.abort();
            }
            self.teardown_forwarder(forwarder, guards);
            self.emit_status(tunnel_id, TunnelStatus::Disconnected);
            tracing::info!("Tunnel {} stopped", tunnel_id);
            return Ok(());
        }

        // Not active — it may be in a reconnect-backoff loop (#1246). Cancel it;
        // the loop's supervisor observes the token and emits `Disconnected` on the
        // Cancelled outcome. Stop always wins the Stop-vs-backoff race.
        if self.cancel_reconnect(tunnel_id) {
            tracing::info!("Tunnel {} reconnect cancelled by stop", tunnel_id);
            return Ok(());
        }

        // Not active yet — it may still be mid-connect. Flag the in-flight start
        // to cancel and tell the UI it has stopped so the Stop click is not lost
        // (#829). The start path tears the forwarder down once the blocking
        // handshake completes.
        if self.connecting.request_cancel(tunnel_id) {
            self.emit_status(tunnel_id, TunnelStatus::Disconnected);
            tracing::info!("Tunnel {} stop requested while connecting", tunnel_id);
        } else if !start_will_stop {
            // Nothing ran: the stop still dismissed a recorded failure, which
            // the UI must be sent (#6139).
            self.emit_status(tunnel_id, self.resting_status_of(tunnel_id));
        }

        Ok(())
    }

    /// Cancel an in-flight reconnect-backoff loop for `tunnel_id` (#1246).
    /// Returns true if one was cancelled; the loop's supervisor emits
    /// `Disconnected` and deregisters itself.
    fn cancel_reconnect(&self, tunnel_id: &str) -> bool {
        let token = match self.reconnecting.lock() {
            Ok(map) => map.get(tunnel_id).map(|entry| entry.cancel.clone()),
            Err(_) => None,
        };
        match token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// Make the next try of a reconnecting tunnel now (#6063). Returns true if
    /// there is one; the loop goes on when that try fails, too.
    fn retry_reconnect_now(&self, tunnel_id: &str) -> bool {
        let Ok(map) = self.reconnecting.lock() else {
            return false;
        };
        match map.get(tunnel_id) {
            Some(entry) => {
                entry.retry_now.notify_one();
                true
            }
            None => false,
        }
    }

    /// Stop all active tunnels (used during app shutdown).
    pub fn stop_all(&self) {
        // Cancel every in-flight reconnect-backoff loop so no zombie backoff task
        // survives shutdown (#1246).
        if let Ok(map) = self.reconnecting.lock() {
            for entry in map.values() {
                entry.cancel.cancel();
            }
        }

        let tunnels: Vec<String> = {
            let active = match self.active_tunnels.lock() {
                Ok(a) => a,
                Err(_) => return,
            };
            active.keys().cloned().collect()
        };

        for tunnel_id in tunnels {
            if let Err(e) = self.stop_tunnel(&tunnel_id) {
                tracing::error!("Failed to stop tunnel {}: {}", tunnel_id, e);
            }
        }

        // Tear down agent-hosted tunnels too (#2185), on this thread: nothing
        // that runs later would still run.
        let client = agent_rpc_client(&self.app_handle);
        for tunnel_id in self.hosted.live_ids() {
            if let StopPlan::StopThere(agent_id) = self.hosted.stop(&tunnel_id) {
                if let Some(client) = &client {
                    self.hosted.send_owed_stop(
                        client.as_ref(),
                        &agent_id,
                        &tunnel_id,
                        Instant::now(),
                    );
                }
            }
        }

        // Abort the live-stats emitter promptly on shutdown rather than waiting
        // for its next tick to observe the now-empty active set (GAP 6, #1248).
        self.stop_stats_emitter();
        // Likewise abort the agent `tunnel.status` poller (#2199).
        self.agent_stats_poller.stop();
    }

    /// Abort the live-stats emitter task (if any) and clear its tracking slot.
    fn stop_stats_emitter(&self) {
        if let Ok(mut slot) = self.stats_emitter.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
    }

    /// Start all tunnels marked with `auto_start: true`.
    pub fn start_auto_tunnels(&self) {
        let tunnels = match self.get_tunnels() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!("Failed to load tunnels for auto-start: {}", e);
                return;
            }
        };

        // What still runs on an agent after the app ended is taken over (#6051).
        for tunnel in &tunnels {
            if let HostChoice::Agent(agent_id) = tunnel.host.choice() {
                self.hosted.expect(&tunnel.id, agent_id);
            }
        }
        if self.hosted.any() {
            self.ensure_status_poller();
        }
        for tunnel in tunnels {
            if tunnel.auto_start {
                if let Err(e) = self.start(&tunnel.id, StartedBy::Itself) {
                    tracing::warn!("Failed to auto-start tunnel {}: {}", tunnel.name, e);
                }
            }
        }
    }

    /// Start every tunnel bound to `connection_id` with `start_with_connection`
    /// set, skipping any that are already active, connecting or reconnecting
    /// (PROD-023).
    ///
    /// Called when a terminal session for that saved SSH connection connects, so
    /// the per-connection forwards come up with the session. Idempotent: a second
    /// session for the same connection (or a reconnect) does not restart a tunnel
    /// that is already up. Returns the ids a start was attempted for. Each start
    /// runs through [`start_tunnel`](Self::start_tunnel), so status, errors and
    /// the tunnels projection behave exactly as for a manual start.
    pub fn start_connection_tunnels(&self, connection_id: &str) -> Vec<String> {
        let tunnels = match self.get_tunnels() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!("Failed to load tunnels for connection start: {}", e);
                return Vec::new();
            }
        };

        let mut started = Vec::new();
        for id in connection_bound_tunnel_ids(&tunnels, connection_id) {
            if self.is_tunnel_active(&id) {
                continue;
            }
            if let Err(e) = self.start(&id, StartedBy::Itself) {
                tracing::warn!(
                    tunnel_id = %id,
                    connection_id,
                    "Failed to start connection-bound tunnel: {}",
                    e
                );
            }
            started.push(id);
        }
        started
    }

    /// Resolve an SSH connection ID to its SshConfig.
    fn resolve_ssh_config(
        &self,
        connection_id: &str,
    ) -> Result<crate::terminal::backend::SshConfig, TerminalError> {
        let conn_mgr = self
            .app_handle
            .try_state::<ConnectionManager>()
            .ok_or_else(|| {
                TerminalError::TunnelError("ConnectionManager not available".to_string())
            })?;

        // Look the connection up where the Tunnel editor found it: the main store
        // plus every enabled external connection file, under the same rule as
        // jump-host references (unique id resolves, ambiguous id refused) — #3619.
        let conn = conn_mgr
            .resolve_saved_connection(connection_id, ReferenceRole::TunnelHost)
            .map_err(|e| TerminalError::TunnelError(e.to_string()))?;

        // Gate on the declared tunnel-hosting capability rather than a hardcoded
        // `type_id == "ssh"` string (PARITY-001): whether a backend can host a
        // port forward is a capability, not a name. Only SSH advertises it today
        // (the forward is built on an SSH session, and agent-hosted tunnels still
        // require an SSH connection), so behaviour is unchanged — but a future
        // forwarding backend just sets the flag instead of touching this gate.
        let session_mgr = self
            .app_handle
            .try_state::<SessionManager>()
            .ok_or_else(|| {
                TerminalError::TunnelError("SessionManager not available".to_string())
            })?;
        if !type_supports_tunneling(&session_mgr.available_types(), &conn.config.type_id) {
            return Err(TerminalError::TunnelError(format!(
                "Connection {} (type '{}') does not support tunnel hosting / port forwarding",
                connection_id, conn.config.type_id
            )));
        }

        // Expand any saved-connection jump-host references to inline hops before
        // core parses the chain (it only connects with inline hops) — #940.
        let mut settings = conn.config.settings.clone();
        conn_mgr
            .resolve_jump_host_refs(&mut settings, Some(connection_id))
            .map_err(|e| TerminalError::TunnelError(e.to_string()))?;

        tunnel_host_ssh_config(connection_id, &settings)
    }

    /// Emit a tunnel status change event to the frontend.
    fn emit_status(&self, tunnel_id: &str, status: TunnelStatus) {
        emit_tunnel_status(&self.app_handle, tunnel_id, status);
    }
}

impl<R: Runtime> TunnelControl for TunnelManager<R> {
    fn tunnel_configs(&self) -> Vec<TunnelConfig> {
        self.get_tunnels().unwrap_or_default()
    }

    fn is_running(&self, tunnel_id: &str) -> bool {
        self.is_tunnel_active(tunnel_id)
    }

    fn stop(&self, tunnel_id: &str) {
        if let Err(e) = self.stop_tunnel(tunnel_id) {
            tracing::warn!("Failed to stop tunnel {tunnel_id} of a deleted connection: {e}");
        }
    }
}

/// Build the [`SshConfig`] a tunnel connects with from a saved SSH connection's
/// settings bag.
///
/// Parsed with the SSH backend's own lenient settings parser
/// ([`parse_ssh_settings`]) — the same one a terminal session uses — rather than
/// a strict `serde` decode of [`SshConfig`]: the saved bag is the *form* shape,
/// whose `env` is a key/value list (`[]` by default), and a strict decode
/// rejected it ("invalid type: sequence, expected a map"), so no tunnel on a
/// form-created SSH connection could ever start (#4017). `~`/`${VAR}` are
/// expanded as for a terminal session, so a `~/.ssh/...` key path works too.
fn tunnel_host_ssh_config(
    connection_id: &str,
    settings: &serde_json::Value,
) -> Result<SshConfig, TerminalError> {
    let config = parse_ssh_settings(settings).expand();
    if config.host.is_empty() {
        return Err(TerminalError::TunnelError(format!(
            "SSH connection {connection_id} has no host configured"
        )));
    }
    Ok(config)
}

/// Whether the connection type identified by `type_id` advertises the
/// tunnel-hosting capability.
///
/// Replaces the old hardcoded `type_id == "ssh"` gate (PARITY-001): whether a
/// backend can host a port forward is a declared
/// [`Capabilities::tunneling`](termihub_core::connection::Capabilities::tunneling)
/// flag, not a name. An unknown `type_id` (absent from the registry) is treated
/// as not tunnel-capable. Free function so it can be unit-tested against a
/// fabricated type list without a live Tauri `AppHandle`.
fn type_supports_tunneling(types: &[ConnectionTypeInfo], type_id: &str) -> bool {
    types
        .iter()
        .find(|t| t.type_id == type_id)
        .is_some_and(|t| t.capabilities.tunneling)
}

/// The ids of the tunnels that should start when a session for the saved SSH
/// connection `connection_id` connects (PROD-023): bound to that connection and
/// flagged `start_with_connection`.
///
/// Chained companions (`companion_of`) are excluded — their lifecycle follows
/// their parent's (#2597), which brings them up in order once it connects. Pure
/// so the selection is unit-testable without a live `AppHandle`.
fn connection_bound_tunnel_ids(tunnels: &[TunnelConfig], connection_id: &str) -> Vec<String> {
    tunnels
        .iter()
        .filter(|t| {
            t.start_with_connection
                && t.companion_of.is_none()
                && t.ssh_connection_id == connection_id
        })
        .map(|t| t.id.clone())
        .collect()
}

/// Why a supervised tunnel died, for the recorded `Error` message.
enum DeathCause {
    Forwarder,
    Session,
}

/// Stop a forwarder and drop its pool guards (RAII drains the pool). Free
/// function so the supervisor task can tear a dead tunnel down without `&self`.
fn teardown_parts(mut forwarder: ActiveForwarder, guards: PooledSessionGuards) {
    forwarder.stop();
    drop(guards);
}

/// Emit a tunnel status change event to the frontend (free function so the
/// supervisor task can emit without `&self`).
fn emit_tunnel_status<R: Runtime>(
    app_handle: &AppHandle<R>,
    tunnel_id: &str,
    status: TunnelStatus,
) {
    // Project the change onto the stateless-UI `tunnels` region (#2150) — the
    // only status channel since the legacy `tunnel-status-changed` event was
    // retired (DEAD2-004, #4344). This is the single status-emit choke point,
    // and every caller emits outside the manager's locks, so the re-lock inside
    // `publish_tunnels` cannot deadlock.
    crate::tunnel::projection::publish_tunnels(app_handle);
    // Drive the chained companion's ordered lifecycle off the same choke point:
    // when a parent settles into `Connected` bring its desktop hop up, otherwise
    // hold it down (#2597). A no-op for tunnels that are not a chained parent.
    orchestrate_companion(app_handle, tunnel_id, &status);
}

/// React to a parent tunnel's status transition by bringing its chained
/// companion up (parent `Connected`) or holding it down (any other state), so
/// the desktop hop never dangles pointing at a dead listen port (#2597).
///
/// Cheap-gated: resolves the managed [`TunnelManager`] and returns immediately
/// unless `parent_id` actually has a linked companion. The companion's own
/// start/stop runs on a blocking task so it never executes inside the status-emit
/// path or under any manager lock, preserving the choke point's deadlock
/// discipline. The companion is not itself a parent, so its resulting emits do
/// not recurse here.
fn orchestrate_companion<R: Runtime>(
    app_handle: &AppHandle<R>,
    parent_id: &str,
    parent_status: &TunnelStatus,
) {
    let Some(manager) = resolve_managed_arc::<TunnelManager<R>, _>(app_handle) else {
        return;
    };
    let Some(companion_id) = manager.companion_id_of(parent_id) else {
        return;
    };
    let action = companion_action(parent_status, manager.is_tunnel_active(&companion_id));
    match action {
        CompanionAction::None => {}
        CompanionAction::Start => {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = manager.start_tunnel(&companion_id);
            });
        }
        CompanionAction::Stop => {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = manager.stop_tunnel(&companion_id);
            });
        }
    }
}

/// Per-tunnel supervisor loop (#1243, GAP 1 + GAP 2).
///
/// Waits for the first of: an explicit stop (cancel token — NOT a death), the
/// forwarder death signal, or the native session-liveness watch firing (#1297).
/// On a real death it reaps the tunnel from `active_tunnels` (dropping its pool
/// guards so the shared session drains exactly once), records the cause as the
/// durable last-error (#1238), and emits the `Error` resting state.
#[allow(clippy::too_many_arguments)]
async fn supervise<R: Runtime>(
    active_tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
    last_errors: Arc<Mutex<HashMap<String, Reason>>>,
    reconnecting: Arc<Mutex<HashMap<String, Reconnecting>>>,
    app_handle: AppHandle<R>,
    tunnel_id: String,
    death: Option<tokio::sync::oneshot::Receiver<()>>,
    liveness: Option<LivenessWatch>,
    cancel: CancellationToken,
    reconnect_on_disconnect: bool,
) {
    let cause = tokio::select! {
        biased;
        // An explicit stop wins the race so a user stop is never laundered into
        // Error; the other branches are dropped.
        _ = cancel.cancelled() => return,
        _ = wait_forwarder_death(death) => DeathCause::Forwarder,
        _ = wait_session_death(liveness) => DeathCause::Session,
    };

    let removed = match active_tunnels.lock() {
        Ok(mut map) => map.remove(&tunnel_id),
        Err(_) => None,
    };
    // If a concurrent stop already removed the entry, it owns the resting state.
    let Some(ActiveTunnel {
        forwarder, guards, ..
    }) = removed
    else {
        return;
    };
    teardown_parts(forwarder, guards);

    let reason = match cause {
        DeathCause::Forwarder => "Connection lost: the forwarding stopped.",
        DeathCause::Session => "Connection lost: the SSH session was closed.",
    };

    // With reconnect off, death is a terminal Error resting state (#1243).
    if !reconnect_on_disconnect {
        record_last_error(&last_errors, &tunnel_id, reason);
        emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Error);
        tracing::warn!("Tunnel {tunnel_id} died — transitioned to Error");
        return;
    }

    // With reconnect on, enter the capped-backoff reconnect loop (#1246, GAP 5).
    // Register a loop cancel token so Stop reaches the backoff even though the
    // tunnel is no longer in `active_tunnels`.
    tracing::info!("Tunnel {tunnel_id} died ({reason}) — reconnecting under backoff");
    // A child of the supervisor token so app teardown (which cancels it via the
    // app token, ARCH-007) also ends the backoff; an explicit Stop still reaches
    // it through the `reconnecting` registry.
    let loop_cancel = cancel.child_token();
    let retry_now = Arc::new(Notify::new());
    if let Ok(mut map) = reconnecting.lock() {
        let entry = Reconnecting {
            cancel: loop_cancel.clone(),
            retry_now: Arc::clone(&retry_now),
            attempt: 1,
            at: Local::now(),
        };
        map.insert(tunnel_id.clone(), entry);
    }

    let mut jitter = system_jitter;
    let outcome = run_reconnect_loop(
        &loop_cancel,
        &retry_now,
        &TUNNEL_RECONNECT_POLICY,
        &mut jitter,
        |attempt, delay| {
            note_attempt(&reconnecting, &tunnel_id, attempt, Local::now() + delay);
            tracing::info!(
                "Tunnel {tunnel_id} reconnecting — attempt {attempt} of \
                 {RECONNECT_MAX_ATTEMPTS} (retry in {}s)",
                delay.as_secs()
            );
            emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Reconnecting);
        },
        |_attempt| match resolve_managed_arc::<TunnelManager<R>, _>(&app_handle) {
            Some(mgr) => mgr.attempt_reconnect(&tunnel_id),
            None => false,
        },
    )
    .await;

    if let Ok(mut map) = reconnecting.lock() {
        map.remove(&tunnel_id);
    }

    match outcome {
        // `attempt_reconnect` already re-registered + re-supervised + emitted Connected.
        ReconnectOutcome::Reconnected => {}
        ReconnectOutcome::Cancelled => {
            emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Disconnected);
            tracing::info!("Tunnel {tunnel_id} reconnect cancelled by stop");
        }
        ReconnectOutcome::Exhausted => {
            let msg = format!(
                "Connection lost, and {RECONNECT_MAX_ATTEMPTS} tries to get it back failed."
            );
            record_last_error(&last_errors, &tunnel_id, msg);
            emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Error);
            tracing::warn!("Tunnel {tunnel_id} reconnect exhausted — transitioned to Error");
        }
    }
}

/// The tunnel reconnect-on-disconnect policy — the shared `RECONNECT_POLICY`
/// (SM-020, #3730): a 1 s first retry doubling to a 30 s ceiling, 10 attempts,
/// with bounded jitter so tunnels dropped by the same outage do not re-dial in
/// lockstep. Driven through the shared [`reconnect_reducer`] engine. (Before
/// #3730 tunnels gave up after 5 jitterless attempts.)
const TUNNEL_RECONNECT_POLICY: BackoffConfig = policy_for(ReconnectKind::Tunnel);

/// Max reconnect attempts before giving up to `Error` (#1246) — the shared
/// policy's budget.
const RECONNECT_MAX_ATTEMPTS: u32 = TUNNEL_RECONNECT_POLICY.max_attempts as u32;

/// A tunnel in its reconnect-backoff loop (#1246).
struct Reconnecting {
    cancel: CancellationToken,
    retry_now: Arc<Notify>,
    /// Which try comes next, or runs.
    attempt: u32,
    /// When it was planned for, on the clock.
    at: DateTime<Local>,
}

/// Keep which try of `tunnel_id` comes next, and when, for its row.
fn note_attempt(
    reconnecting: &Mutex<HashMap<String, Reconnecting>>,
    tunnel_id: &str,
    attempt: u32,
    at: DateTime<Local>,
) {
    if let Ok(mut map) = reconnecting.lock() {
        if let Some(entry) = map.get_mut(tunnel_id) {
            entry.attempt = attempt;
            entry.at = at;
        }
    }
}

/// What the row of a reconnecting tunnel says.
fn reconnecting_reason(attempt: u32, at: DateTime<Local>) -> String {
    let then = if attempt >= RECONNECT_MAX_ATTEMPTS {
        ", then start it yourself"
    } else {
        ""
    };
    let at = at.format("%H:%M:%S");
    format!("Connection lost. Try {attempt} of {RECONNECT_MAX_ATTEMPTS} at {at}{then}.")
}

/// What a remote forwarder that the server turned down says first.
const REMOTE_FORWARD_FAILED: &str = "Failed to start remote forwarder: ";

/// Why a tunnel did not start on this computer: what is taken, who refused, or
/// which part of the path failed, in words for its row and with the cause that
/// picks its remedy (#6063; #6028, slice 10). Pure but for the look at the port.
fn start_reason(tunnel: &TunnelType, server: &str, direct: bool, error: &TerminalError) -> Reason {
    use crate::utils::errors::IpcErrorCode as C;
    let listens_on = match tunnel {
        TunnelType::Local(c) => Some((&c.local_host, c.local_port)),
        TunnelType::Dynamic(c) => Some((&c.local_host, c.local_port)),
        TunnelType::Remote(_) => None,
    };
    let detail = error.display_message();
    let said = |text: String, cause| Reason::new(text, Some(cause));
    match error.code() {
        C::AuthFailed | C::AgentAuthFailed | C::InteractionRequired => said(
            format!("{server} refused the sign-in."),
            ServiceCause::SignInRefused,
        ),
        C::HostKeyUntrusted => said(
            format!("The host key of {server} is not trusted. It may have changed."),
            ServiceCause::HostKeyUntrusted,
        ),
        C::Timeout => said(
            format!("{server} did not answer in time."),
            ServiceCause::ServerSilent,
        ),
        C::Refused if direct => said(
            format!("{server} refused the connection. Is its SSH server running?"),
            ServiceCause::Connection,
        ),
        C::Refused | C::Unreachable | C::Dns | C::ConnectionFailed | C::SshError => {
            if direct && is_refused(&detail) {
                return said(
                    format!("{server} refused the connection. Is its SSH server running?"),
                    ServiceCause::Connection,
                );
            }
            let what = detail.strip_prefix("SSH error: ").unwrap_or(&detail);
            let what = what.strip_prefix("Connection failed: ").unwrap_or(what);
            said(
                format!("Could not connect to {server}: {what}"),
                ServiceCause::Connection,
            )
        }
        _ => match (tunnel, listens_on, error) {
            (TunnelType::Remote(c), _, TerminalError::TunnelError(what))
                if what.starts_with(REMOTE_FORWARD_FAILED) =>
            {
                said(
                    format!("{server} did not allow port {}.", c.remote_port),
                    ServiceCause::RemotePortRefused,
                )
            }
            (_, Some((host, port)), _) if tcp_port_in_use(host, port) => {
                said(port_in_use_here(port), ServiceCause::PortInUse)
            }
            _ => plain_reason(error).into(),
        },
    }
}

/// Whether an agent refused a start because the tunnel already runs there, as an
/// agent that outlived the app says (#6051).
fn already_runs_there(error: &TerminalError) -> bool {
    error
        .display_message()
        .contains("is already running on this agent")
}

/// Whether the machine answered that nothing listens there. By the number the
/// system gives it, which no language changes.
fn is_refused(error: &str) -> bool {
    ["(os error 61)", "(os error 111)", "(os error 10061)"]
        .iter()
        .any(|code| error.contains(code))
}

/// What `error` says, without the prefix that says it is about a tunnel.
fn plain_reason(error: &TerminalError) -> String {
    match error {
        TerminalError::TunnelError(reason) => reason.clone(),
        other => other.to_string(),
    }
}

/// Outcome of a reconnect-backoff loop (#1246).
#[derive(Debug, PartialEq, Eq)]
enum ReconnectOutcome {
    /// A retry succeeded — the tunnel is `Connected` again.
    Reconnected,
    /// A user Stop cancelled the loop — the tunnel returns to `Disconnected`.
    Cancelled,
    /// All attempts failed — the tunnel falls through to `Error`.
    Exhausted,
}

/// Resolve an app-managed `Arc<T>` from any Tauri [`Manager`].
///
/// Managed state is keyed by exact `TypeId`. `lib.rs` registers the tunnel
/// manager as `app.manage(Arc::new(manager))`, so it lives under
/// `TypeId::of::<Arc<TunnelManager>>()`. A bare `try_state::<TunnelManager>()`
/// therefore never matches it and silently yields `None` — which had turned
/// every reconnect attempt into a no-op `false`, so `reconnectOnDisconnect`
/// (#1246) never actually reconnected (#2168). Always resolve the manager
/// through this helper so the lookup type matches the registration.
fn resolve_managed_arc<T, R>(manager: &impl Manager<R>) -> Option<Arc<T>>
where
    T: Send + Sync + 'static,
    R: Runtime,
{
    manager.try_state::<Arc<T>>().map(|state| (*state).clone())
}

/// Run the reconnect-backoff loop (#1246, GAP 5) on the canonical reconnect
/// engine (SM-020). The loop drives [`reconnect_reducer`] with the given
/// [`BackoffConfig`] and jitter source (`rand`, injectable so tests are
/// deterministic): a `Drop` arms the first backoff window, each
/// failed attempt arms the next, and the reducer reaches
/// [`ReconnectPhase::Gaveup`] once the attempt budget is spent.
///
/// Before each attempt it calls `on_attempt(attempt, delay)` (to emit
/// `Reconnecting`), waits `delay` (racing the cancel token so a Stop wins
/// immediately and clears the pending timer), then runs `attempt(n)` — returning
/// `Reconnected` on the first success, `Cancelled` if the token fires, or
/// `Exhausted` once the reducer gives up. `attempt` is synchronous (the
/// manager's connect blocks internally).
///
/// `retry_now` ends a wait at once ("Retry now", #6063); the try then counts like
/// any other.
async fn run_reconnect_loop(
    cancel: &CancellationToken,
    retry_now: &Notify,
    config: &BackoffConfig,
    rand: &mut (dyn FnMut() -> f64 + Send),
    mut on_attempt: impl FnMut(u32, Duration),
    mut attempt: impl FnMut(u32) -> bool,
) -> ReconnectOutcome {
    // A fresh drop arms the first backoff window.
    let mut state = reconnect_reducer(
        &INITIAL_RECONNECT_STATE,
        ReconnectEvent::Drop,
        config,
        &mut *rand,
    );
    while state.phase == ReconnectPhase::Waiting {
        // The armed backoff delay for the attempt about to start.
        let delay = Duration::from_millis(state.delay_ms.max(0) as u64);
        // The backoff timer fires: begin an attempt (advances the attempt count).
        state = reconnect_reducer(&state, ReconnectEvent::Attempt, config, &mut *rand);
        let n = state.attempt as u32;
        on_attempt(n, delay);
        tokio::select! {
            biased;
            // Stop always wins the Stop-vs-backoff race and clears the pending timer.
            _ = cancel.cancelled() => return ReconnectOutcome::Cancelled,
            _ = retry_now.notified() => {}
            _ = tokio::time::sleep(delay) => {}
        }
        // A stop that fired exactly as the timer elapsed still wins.
        if cancel.is_cancelled() {
            return ReconnectOutcome::Cancelled;
        }
        if attempt(n) {
            return ReconnectOutcome::Reconnected;
        }
        // The attempt failed: arm the next backoff window or give up.
        state = reconnect_reducer(&state, ReconnectEvent::Failure, config, &mut *rand);
    }
    ReconnectOutcome::Exhausted
}

/// Resolve when the forwarder's accept/forward loop ends. The oneshot resolves
/// on `Ok` (never sent explicitly) or `Err` (its sender dropped when the task
/// ended — a `break` or an `abort()`), so either way signals the loop is gone.
async fn wait_forwarder_death(death: Option<tokio::sync::oneshot::Receiver<()>>) {
    match death {
        Some(rx) => {
            let _ = rx.await;
        }
        // No signal wired (should not happen) — never resolve so the session
        // liveness watch alone governs liveness.
        None => std::future::pending::<()>().await,
    }
}

/// Resolve once the SSH session is dead, via the native russh liveness watch
/// (#1297) — event-driven, no polling. russh fires the watch from its
/// `disconnected` callback on a transport failure, a peer disconnect, or
/// keepalive exhaustion (30 s × 3).
///
/// `None` (a remote forward, which has no shared endpoint session) never
/// resolves — the forwarder death signal governs liveness for that tunnel.
async fn wait_session_death(liveness: Option<LivenessWatch>) {
    match liveness {
        Some(mut watch) => watch.dead().await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    //! Regression tests for the Stop-during-connect teardown path (GAP 8 of the
    //! SSH tunnel state-machine audit, umbrella #1141).
    //!
    //! Driving the full [`TunnelManager::start_tunnel`] path in a unit test is not
    //! feasible: it needs a live Tauri `AppHandle` (for `ConnectionManager`
    //! resolution + event emission) and a real SSH handshake (`build_forwarder`
    //! ultimately dials a russh session — `SshSession` is
    //! `russh::client::Handle<..>` and cannot be fabricated without a server), and
    //! `src-tauri` has no Tauri-mock harness. So these tests reproduce the exact
    //! Stop-during-connect **teardown sequence** the manager performs, using the
    //! same production building blocks it holds — the [`ConnectingTracker`]
    //! cancellation decision and the [`RefPool`] pooled-session guards whose RAII
    //! `Drop` drains the pool in [`TunnelManager::teardown_forwarder`].
    //!
    //! GAP 8 asks specifically: after a Stop issued while a tunnel is still
    //! `connecting`, `active_tunnels` and any pooled endpoint/gateway ref counts
    //! must return to zero. The audit concluded the behavior is already correct;
    //! these tests lock it in so a future refactor of the connect/teardown wiring
    //! cannot silently reintroduce a leak.

    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::super::connecting::{ConnectingTracker, FinishOutcome};
    use super::{
        clear_last_error, companion_action, connection_bound_tunnel_ids, find_companion,
        gone_tunnel, has_active_tunnels, last_error_for, reconnecting_reason, record_last_error,
        resolve_managed_arc, resting_status, run_reconnect_loop, start_reason,
        tunnel_host_ssh_config, type_supports_tunneling, wait_forwarder_death, wait_session_death,
        ActiveTunnel, CompanionAction, GoneTunnel, Reason, ReconnectOutcome, ServiceCause,
        TUNNEL_RECONNECT_POLICY,
    };
    use crate::tunnel::config::{LocalForwardConfig, TunnelConfig, TunnelStatus, TunnelType};
    use crate::utils::errors::TerminalError;
    use chrono::{Local, TimeZone};
    use tauri::Manager;
    use termihub_core::backends::ssh::session_pool::{PooledRef, RefPool};
    use termihub_core::connection::{Capabilities, ConnectionTypeInfo, SettingsSchema};
    use termihub_core::reconnect_backoff::{
        reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, INITIAL_RECONNECT_STATE,
    };
    use termihub_core::tunnel::local_forward::ForwarderStats;
    use tokio_util::sync::CancellationToken;

    /// Stand-in for a pooled `Arc<SshSession>` that records when the underlying
    /// value is dropped, so we can assert the session is actually torn down (not
    /// merely un-referenced by the map) after teardown.
    struct TrackedSession {
        live: Arc<AtomicUsize>,
    }

    impl TrackedSession {
        fn new(live: &Arc<AtomicUsize>) -> Arc<Self> {
            live.fetch_add(1, Ordering::SeqCst);
            Arc::new(Self { live: live.clone() })
        }
    }

    impl Drop for TrackedSession {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// Minimal stand-in for the pool guards the manager attaches to an
    /// `ActiveTunnel`, mirroring `PooledSessionGuards`: dropping it releases the
    /// pooled endpoint reference (RAII), exactly like `teardown_forwarder`.
    struct EndpointGuard {
        _endpoint: PooledRef<Arc<TrackedSession>>,
    }

    const CONN_ID: &str = "conn-1";
    const TUNNEL_ID: &str = "tunnel-1";

    /// Acquire a pooled endpoint reference the way `acquire_endpoint` does for the
    /// non-jumped local/dynamic path (single-flight `get_or_create` keyed by
    /// connection id), wrapping it in a guard whose drop releases it.
    async fn acquire_guard(
        pool: &Arc<RefPool<Arc<TrackedSession>>>,
        live: &Arc<AtomicUsize>,
    ) -> EndpointGuard {
        let endpoint = pool
            .get_or_create(CONN_ID, || async {
                Ok::<_, std::convert::Infallible>(TrackedSession::new(live))
            })
            .await
            .expect("infallible connect");
        EndpointGuard {
            _endpoint: endpoint,
        }
    }

    /// GAP 8: a Stop cancel that arrives *before* the forwarder finishes building
    /// must make `finish()` report `Cancel`, so the start never inserts into
    /// `active_tunnels` — the active set stays empty and the pool never grows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_before_build_completes_leaves_active_and_pool_empty() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        // Stand-in for TunnelManager::active_tunnels — only membership matters here.
        // On the cancel branch nothing is ever inserted, so no `mut` is needed.
        let active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        // start_tunnel: mark connecting, then a Stop arrives mid-handshake.
        let _cancel = tracker.begin(TUNNEL_ID).expect("first begin");
        assert!(tracker.is_connecting(TUNNEL_ID));

        // stop_tunnel while still connecting: not in the active map, so it cancels
        // the in-flight connect via the tracker instead.
        assert!(
            !active_tunnels.contains_key(TUNNEL_ID),
            "not active yet during connect"
        );
        assert!(
            tracker.request_cancel(TUNNEL_ID),
            "stop must flag the in-flight start"
        );

        // The connect aborts before build_forwarder produces anything; the start
        // path observes Cancel and does NOT insert into active_tunnels.
        assert_eq!(tracker.finish(TUNNEL_ID), FinishOutcome::Cancel);
        // (no active insert on the Cancel branch)

        assert!(
            active_tunnels.is_empty(),
            "active_tunnels must stay empty after Stop-during-connect"
        );
        assert!(
            pool.is_empty(),
            "pool must never grow when the connect was cancelled before building"
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(live.load(Ordering::SeqCst), 0, "no session was created");
        assert!(
            !tracker.is_connecting(TUNNEL_ID),
            "finish clears the tracker"
        );
    }

    /// GAP 8 residual-risk case: `build_forwarder` *wins the race* and produces a
    /// forwarder (with a pooled endpoint session already created) before the Stop
    /// cancel is observed. `start_tunnel` then sees `finish() != Commit`, calls
    /// `teardown_forwarder` (dropping the guards) and returns without inserting
    /// into `active_tunnels`. Assert both counts return to zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_after_build_wins_race_tears_pool_back_to_zero() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        // On the cancel branch the forwarder is torn down, never inserted here.
        let active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        // start_tunnel: begin connecting.
        let cancel = tracker.begin(TUNNEL_ID).expect("first begin");

        // build_forwarder wins the race: it acquires a pooled endpoint session and
        // produces the guard *before* the cancel is observed.
        let guard = acquire_guard(&pool, &live).await;
        assert_eq!(pool.ref_count(CONN_ID), 1, "endpoint acquired during build");
        assert_eq!(live.load(Ordering::SeqCst), 1, "session created");

        // Meanwhile a Stop arrived while connecting (cancel requested).
        assert!(tracker.request_cancel(TUNNEL_ID));
        cancel.cancel(); // idempotent; mirrors request_cancel firing the token

        // start_tunnel checks finish(): cancelled -> Cancel, so it tears the
        // just-built forwarder down instead of inserting it as active.
        assert_ne!(tracker.finish(TUNNEL_ID), FinishOutcome::Commit);
        // teardown_forwarder: dropping guards releases pooled refs. The
        // active_tunnels insert is skipped on this branch.
        drop(guard);

        assert!(
            active_tunnels.is_empty(),
            "active_tunnels must be empty after Stop-during-connect teardown"
        );
        assert!(
            pool.is_empty(),
            "pooled endpoint ref count must return to zero after teardown"
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "the pooled SSH session must actually be dropped, not just unreferenced"
        );
    }

    /// Sanity contrast: without a Stop the same sequence commits and the tunnel
    /// *does* land in the active map holding its pooled ref — so the zero-after
    /// assertions above are meaningful (they aren't trivially always-empty).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_stop_the_endpoint_stays_held_while_active() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let mut active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        tracker.begin(TUNNEL_ID).expect("first begin");
        let guard = acquire_guard(&pool, &live).await;

        // No Stop: finish() commits, so the forwarder is registered as active.
        assert_eq!(tracker.finish(TUNNEL_ID), FinishOutcome::Commit);
        active_tunnels.insert(TUNNEL_ID.to_string(), guard);

        assert_eq!(
            pool.ref_count(CONN_ID),
            1,
            "active tunnel holds its endpoint"
        );
        assert_eq!(live.load(Ordering::SeqCst), 1);

        // A later stop_tunnel removes it from active and drops the guard.
        let removed = active_tunnels.remove(TUNNEL_ID).expect("was active");
        drop(removed); // teardown_forwarder
        assert!(
            pool.is_empty(),
            "pool drains once the active tunnel is stopped"
        );
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    // --- GAP 3: persisted, queryable `Error` resting state (#1238) ---------
    //
    // Driving the full `get_statuses` path in a unit test needs a live Tauri
    // `AppHandle` (for storage + event emission), which `src-tauri` has no mock
    // harness for. So — exactly like the teardown tests above — these exercise
    // the production building blocks the manager uses directly: the
    // `last_errors` map helpers (`record_last_error` / `clear_last_error` /
    // `last_error_for`) and the `resting_status` decision that `get_statuses`
    // applies to every non-active tunnel.

    /// GAP 3: after a failure is recorded, the resting status a reload computes
    /// is `Error` carrying the recorded message — not `Disconnected`.
    #[test]
    fn resting_status_reports_error_after_recorded_failure() {
        let errors = Mutex::new(HashMap::new());
        let tracker = ConnectingTracker::new();

        record_last_error(&errors, TUNNEL_ID, "connect refused".to_string());

        let (status, error) = resting_status(
            tracker.is_connecting(TUNNEL_ID),
            last_error_for(&errors, TUNNEL_ID),
        );
        assert_eq!(status, TunnelStatus::Error);
        assert_eq!(error, Some("connect refused".into()));
    }

    /// GAP 3: "never started" (no map entry) stays `Disconnected` — distinct
    /// from "died with an error" (entry present).
    #[test]
    fn never_started_tunnel_reports_disconnected_not_error() {
        let errors = Mutex::new(HashMap::new());
        let (status, error) = resting_status(false, last_error_for(&errors, "never-started"));
        assert_eq!(status, TunnelStatus::Disconnected);
        assert!(error.is_none());
    }

    /// GAP 3: an in-flight connect wins over a stale recorded error.
    #[test]
    fn connecting_takes_precedence_over_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "old failure".to_string());

        let (status, error) = resting_status(true, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Connecting);
        assert!(error.is_none());
    }

    /// GAP 3: a successful start clears the recorded error, so a later resting
    /// read reports `Disconnected` (not the stale `Error`).
    #[test]
    fn successful_start_clears_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "boom".to_string());
        assert!(last_error_for(&errors, TUNNEL_ID).is_some());

        // start_tunnel clears the id on a successful insert.
        clear_last_error(&errors, TUNNEL_ID);

        let (status, error) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Disconnected);
        assert!(error.is_none());
    }

    /// GAP 3: an explicit stop clears the recorded error.
    #[test]
    fn explicit_stop_clears_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "boom".to_string());

        // stop_tunnel clears the id.
        clear_last_error(&errors, TUNNEL_ID);
        assert!(last_error_for(&errors, TUNNEL_ID).is_none());

        let (status, _) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Disconnected);
    }

    /// GAP 3 core regression: repeated status reads (a simulated `loadTunnels`
    /// reload) must NOT launder `Error` back to `Disconnected` — the second read
    /// still reports `Error` with its message because reading never mutates the
    /// persisted map.
    #[test]
    fn error_survives_repeated_status_reads() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "session died".to_string());

        let first = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(first.0, TunnelStatus::Error);

        let second = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(second.0, TunnelStatus::Error);
        assert_eq!(second.1, Some("session died".into()));
    }

    // ── Supervisor: liveness signals + death-driven Error (S2, GAP 1 + GAP 2, #1243) ──
    //
    // As with the GAP-8 tests above, the full `supervise` task cannot run in a
    // unit test (it needs a Tauri `AppHandle` to emit and a real `SshSession`),
    // so these lock in its constituent behaviours with the same production
    // building blocks: the real `wait_forwarder_death` / `wait_session_death`
    // futures and the RefPool guard-drain that the death path performs (the
    // native `LivenessWatch` firing itself is unit-tested in `core`). The
    // end-to-end Connected → Error on a killed sshd is the Docker system test.

    /// The forwarder death oneshot resolves when its sender is dropped — i.e. when
    /// the accept/forward task ends (a `break` or a `stop()`-abort), so the
    /// supervisor observes forwarder death however the loop exits (GAP 2).
    #[tokio::test]
    async fn forwarder_death_resolves_when_task_ends() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let waiter = tokio::spawn(wait_forwarder_death(Some(rx)));
        drop(tx); // the accept task "ended"
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("death wait must resolve when the forwarder task ends")
            .expect("join");
    }

    /// With no death signal wired, the wait never resolves — the session
    /// liveness watch alone governs liveness (defensive default).
    #[tokio::test]
    async fn no_forwarder_signal_never_resolves() {
        let r = tokio::time::timeout(Duration::from_millis(100), wait_forwarder_death(None)).await;
        assert!(r.is_err(), "no death signal ⇒ the wait must never resolve");
    }

    /// A remote-forward tunnel has no liveness watch; `wait_session_death(None)`
    /// must never resolve so the forwarder death signal governs (no spurious
    /// Error). The watch-fires case is covered by the `LivenessWatch` unit tests
    /// in `core` (a real `SshSession` can't be fabricated here).
    #[tokio::test]
    async fn session_death_without_watch_never_resolves() {
        let r = tokio::time::timeout(Duration::from_millis(100), wait_session_death(None)).await;
        assert!(
            r.is_err(),
            "no liveness watch ⇒ the session-death wait must never resolve"
        );
    }

    /// A user Stop cancels the supervisor token *and* (via teardown/abort) ends
    /// the forwarder task, so both signals fire. The supervisor's biased select
    /// must let the cancel win so the stop is never laundered into `Error`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_cancel_wins_the_race_over_forwarder_death() {
        let cancel = CancellationToken::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        cancel.cancel();
        drop(tx); // teardown-induced forwarder death also fires

        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => "stopped",
            _ = wait_forwarder_death(Some(rx)) => "died",
        };
        assert_eq!(
            outcome, "stopped",
            "a user stop must win over the teardown-induced forwarder death"
        );
    }

    /// The supervisor death path reaps the tunnel from the active set, dropping
    /// its pool guards (RAII drains the shared session) and recording the cause as
    /// the durable `Error` resting state (#1238). Reproduced with the same
    /// RefPool building blocks the manager holds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn death_reap_drains_pool_and_records_error() {
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let errors = Mutex::new(HashMap::new());

        let mut active: HashMap<String, EndpointGuard> = HashMap::new();
        active.insert(TUNNEL_ID.to_string(), acquire_guard(&pool, &live).await);
        assert_eq!(pool.ref_count(CONN_ID), 1);
        assert_eq!(live.load(Ordering::SeqCst), 1);

        // Supervisor on death: remove the entry (drops guards → RAII pool drain)
        // and record the cause as the resting Error.
        let removed = active.remove(TUNNEL_ID).expect("was active");
        drop(removed);
        record_last_error(
            &errors,
            TUNNEL_ID,
            "connection lost: SSH session closed".to_string(),
        );

        assert!(active.is_empty(), "dead tunnel reaped from the active set");
        assert_eq!(pool.ref_count(CONN_ID), 0, "pool ref count drained to zero");
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "shared session dropped exactly once"
        );
        let (status, msg) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Error);
        assert_eq!(msg, Some("connection lost: SSH session closed".into()));
    }

    /// A shared pooled session backing two tunnels: when it dies, each tunnel's
    /// supervisor reaps its own guard and records `Error`, and the underlying
    /// session drains exactly once (ref-count → 0), not once per tunnel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_session_death_errors_both_tunnels_and_drains_once() {
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let errors = Mutex::new(HashMap::new());

        let g1 = acquire_guard(&pool, &live).await;
        let g2 = acquire_guard(&pool, &live).await;
        assert_eq!(pool.ref_count(CONN_ID), 2);
        assert_eq!(live.load(Ordering::SeqCst), 1, "one shared session");

        // First tunnel's supervisor reaps; the session lives while a ref remains.
        drop(g1);
        record_last_error(
            &errors,
            "tunnel-a",
            "connection lost: SSH session closed".to_string(),
        );
        assert_eq!(
            live.load(Ordering::SeqCst),
            1,
            "session stays alive while one ref remains"
        );

        // Second tunnel's supervisor reaps; now the shared session drains once.
        drop(g2);
        record_last_error(
            &errors,
            "tunnel-b",
            "connection lost: SSH session closed".to_string(),
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "shared session drained exactly once"
        );
        assert_eq!(
            resting_status(false, last_error_for(&errors, "tunnel-a")).0,
            TunnelStatus::Error
        );
        assert_eq!(
            resting_status(false, last_error_for(&errors, "tunnel-b")).0,
            TunnelStatus::Error
        );
    }

    // ── Reconnect backoff loop (S3, GAP 5, #1246) ──
    //
    // As with the #1243 supervisor, the full reconnect (a real `attempt_reconnect`
    // via the managed TunnelManager) needs an AppHandle + SSH and can't run in a
    // unit test. These lock in the risky part — the backoff schedule and the loop's
    // success/exhaustion/cancel control flow — with injected closures + paused time.

    // ── Golden vector: the tunnel on the shared policy (SM-020, #3730) ──
    //
    // Pins the delay sequence + give-up the tunnel reconnect produces: the shared
    // policy's nominal (worst-case) 1,2,4,8,16,30,30,30,30,30 s schedule, give up
    // after 10 attempts, and jitter that only ever shortens a window.

    /// The tunnel's nominal (worst-case) reconnect delays, in whole ms.
    const TUNNEL_GOLDEN_DELAYS_MS: [i64; 10] = [
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ];

    /// Walk the `Drop → (Attempt → Failure)*` sequence on the tunnel policy.
    fn walk_tunnel_schedule(
        rand: &mut dyn FnMut() -> f64,
    ) -> (Vec<i64>, termihub_core::reconnect_backoff::ReconnectState) {
        let mut state = reconnect_reducer(
            &INITIAL_RECONNECT_STATE,
            ReconnectEvent::Drop,
            &TUNNEL_RECONNECT_POLICY,
            rand,
        );
        let mut delays = Vec::new();
        while state.phase == ReconnectPhase::Waiting {
            delays.push(state.delay_ms);
            state = reconnect_reducer(
                &state,
                ReconnectEvent::Attempt,
                &TUNNEL_RECONNECT_POLICY,
                rand,
            );
            state = reconnect_reducer(
                &state,
                ReconnectEvent::Failure,
                &TUNNEL_RECONNECT_POLICY,
                rand,
            );
        }
        (delays, state)
    }

    #[test]
    fn tunnel_follows_the_shared_reconnect_policy() {
        use termihub_core::reconnect_backoff::RECONNECT_POLICY;
        assert_eq!(TUNNEL_RECONNECT_POLICY, RECONNECT_POLICY);
        assert_eq!(super::RECONNECT_MAX_ATTEMPTS, 10);
    }

    #[test]
    fn golden_vector_tunnel_backoff_sequence_then_give_up() {
        let (delays, state) = walk_tunnel_schedule(&mut || 0.0);
        assert_eq!(
            delays,
            TUNNEL_GOLDEN_DELAYS_MS.to_vec(),
            "tunnel backoff must be at most 1,2,4,8,16,30,30,30,30,30 s"
        );
        assert_eq!(
            state.phase,
            ReconnectPhase::Gaveup,
            "after 10 failed attempts the engine gives up (`Exhausted`)"
        );
    }

    #[test]
    fn tunnel_jittered_schedule_stays_within_the_shared_bounds() {
        use termihub_core::reconnect_backoff::{SeededJitter, RECONNECT_GIVE_UP_WINDOW_MS};
        for seed in 0..64u64 {
            let mut jitter = SeededJitter::new(seed);
            let (delays, _) = walk_tunnel_schedule(&mut || jitter.next_f64());
            assert_eq!(delays.len(), TUNNEL_GOLDEN_DELAYS_MS.len());
            for (d, nominal) in delays.iter().zip(TUNNEL_GOLDEN_DELAYS_MS) {
                assert!(
                    *d <= nominal && *d >= nominal / 2,
                    "seed {seed}: {d} vs {nominal}"
                );
            }
            assert!(delays.iter().sum::<i64>() <= RECONNECT_GIVE_UP_WINDOW_MS);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_loop_sleeps_the_jittered_delay_it_announces() {
        // The delay passed to `on_attempt` (the "retry in Ns" status) is exactly
        // the window the loop then sleeps, and follows the injected jitter.
        let cancel = CancellationToken::new();
        let mut announced: Vec<Duration> = Vec::new();
        let mut draw = || 0.999_999;
        let start = tokio::time::Instant::now();
        let outcome = run_reconnect_loop(
            &cancel,
            &tokio::sync::Notify::new(),
            &TUNNEL_RECONNECT_POLICY,
            &mut draw,
            |_, delay| announced.push(delay),
            |n| n == 2,
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Reconnected);
        // Fully shortened windows: 1 s → 500 ms, 2 s → 1 s.
        assert_eq!(
            announced,
            vec![Duration::from_millis(500), Duration::from_millis(1_000)]
        );
        assert_eq!(start.elapsed(), Duration::from_millis(1_500));
    }

    /// The tunnel policy with fast (sub-ms) timings and a 5-attempt budget, so
    /// the loop tests below don't actually sleep seconds.
    fn fast_backoff() -> BackoffConfig {
        BackoffConfig {
            base_delay_ms: 1.0,
            factor: 2.0,
            max_delay_ms: 20.0,
            max_attempts: 5,
            ..TUNNEL_RECONNECT_POLICY
        }
    }

    #[tokio::test]
    async fn reconnect_loop_succeeds_on_a_later_attempt() {
        let cancel = CancellationToken::new();
        let mut emitted: Vec<u32> = Vec::new();
        let mut tries = 0u32;
        let outcome = run_reconnect_loop(
            &cancel,
            &tokio::sync::Notify::new(),
            &fast_backoff(),
            &mut || 0.5,
            |n, _delay| emitted.push(n),
            |n| {
                tries += 1;
                n == 3 // succeeds on the 3rd attempt
            },
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Reconnected);
        assert_eq!(
            emitted,
            vec![1, 2, 3],
            "emits Reconnecting once per attempt"
        );
        assert_eq!(tries, 3);
    }

    #[tokio::test]
    async fn reconnect_loop_exhausts_to_error() {
        let cancel = CancellationToken::new();
        let mut emitted: Vec<u32> = Vec::new();
        let outcome = run_reconnect_loop(
            &cancel,
            &tokio::sync::Notify::new(),
            &fast_backoff(),
            &mut || 0.5,
            |n, _delay| emitted.push(n),
            |_| false, // every attempt fails
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Exhausted);
        assert_eq!(emitted, vec![1, 2, 3, 4, 5], "exhausts after max attempts");
    }

    #[tokio::test]
    async fn reconnect_loop_stop_wins_over_backoff() {
        let cancel = CancellationToken::new();
        cancel.cancel(); // a user Stop arrived before/during backoff
        let mut tries = 0u32;
        let outcome = run_reconnect_loop(
            &cancel,
            &tokio::sync::Notify::new(),
            &fast_backoff(),
            &mut || 0.5,
            |_, _| {},
            |_| {
                tries += 1;
                true
            },
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Cancelled);
        assert_eq!(tries, 0, "Stop wins the race — no reconnect attempt runs");
    }

    /// "Retry now" (#6063) ends the wait, not the retries: a minute of waiting is
    /// skipped, and a try that fails is followed by the next one.
    #[tokio::test(start_paused = true)]
    async fn reconnect_loop_retries_now_when_asked() {
        let cancel = CancellationToken::new();
        let retry_now = Arc::new(tokio::sync::Notify::new());
        let policy = BackoffConfig {
            base_delay_ms: 60_000.0,
            max_delay_ms: 60_000.0,
            ..fast_backoff()
        };
        let started = tokio::time::Instant::now();
        let mut tries = 0u32;
        let ask = Arc::clone(&retry_now);
        let outcome = run_reconnect_loop(
            &cancel,
            &retry_now,
            &policy,
            &mut || 0.5,
            |_, _| ask.notify_one(),
            |_| {
                tries += 1;
                tries == 3
            },
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Reconnected);
        assert_eq!(tries, 3);
        assert!(started.elapsed() < Duration::from_secs(1), "did not wait");
    }

    #[test]
    fn a_reconnecting_row_says_which_try_and_that_the_last_one_is_the_last() {
        let at = Local.with_ymd_and_hms(2026, 11, 25, 14, 32, 8).unwrap();
        assert_eq!(
            reconnecting_reason(3, at),
            "Connection lost. Try 3 of 10 at 14:32:08."
        );
        assert_eq!(
            reconnecting_reason(10, at),
            "Connection lost. Try 10 of 10 at 14:32:08, then start it yourself."
        );
    }

    fn local_on(port: u16) -> TunnelType {
        TunnelType::Local(LocalForwardConfig {
            local_host: "127.0.0.1".into(),
            local_port: port,
            remote_host: "db".into(),
            remote_port: 5432,
        })
    }

    /// The reason names the port or the server, in words, and what its button is
    /// chosen by (#6063).
    #[test]
    fn a_failed_start_says_what_is_taken_or_who_refused() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let bind = TerminalError::TunnelError("Failed to start local forwarder: x".into());
        assert_eq!(
            start_reason(&local_on(port), "Build Box", true, &bind),
            Reason::new(
                format!("Port {port} is already in use on this computer."),
                Some(ServiceCause::PortInUse)
            )
        );
        // The connection comes before the port: that is what failed.
        for code in [61, 111, 10061] {
            let refused = TerminalError::SshError(format!("Verbindung (os error {code})"));
            assert_eq!(
                start_reason(&local_on(port), "Build Box", true, &refused),
                Reason::new(
                    "Build Box refused the connection. Is its SSH server running?",
                    Some(ServiceCause::Connection)
                )
            );
        }
        // Who refused behind a jump host is not known.
        let refused = TerminalError::SshError("Connection refused (os error 61)".into());
        assert_eq!(
            start_reason(&local_on(port), "Build Box", false, &refused).text,
            "Could not connect to Build Box: Connection refused (os error 61)"
        );
        let other = TerminalError::SshError("Connection failed: no route to host".into());
        assert_eq!(
            start_reason(&local_on(port), "Build Box", true, &other),
            Reason::new(
                "Could not connect to Build Box: no route to host",
                Some(ServiceCause::Connection)
            )
        );
        // Nothing is taken: what was said, without the prefix.
        drop(taken);
        assert_eq!(
            start_reason(&local_on(port), "Build Box", true, &bind),
            "Failed to start local forwarder: x".into()
        );
    }

    /// Which part of the path failed picks the remedy (#6028, slice 10).
    #[test]
    fn a_failed_start_says_which_part_failed() {
        use termihub_core::errors::{ConnectFailureKind, SessionError};
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let kind = |kind, message: &str| {
            TerminalError::from_session_ssh(SessionError::Classified {
                kind,
                message: message.into(),
            })
        };
        let cases = [
            (
                TerminalError::from_session_ssh(SessionError::AuthFailed),
                "Build Box refused the sign-in.",
                ServiceCause::SignInRefused,
            ),
            (
                kind(ConnectFailureKind::InteractionRequired, "asks for a code"),
                "Build Box refused the sign-in.",
                ServiceCause::SignInRefused,
            ),
            (
                kind(ConnectFailureKind::HostKeyUntrusted, "not trusted"),
                "The host key of Build Box is not trusted. It may have changed.",
                ServiceCause::HostKeyUntrusted,
            ),
            (
                kind(ConnectFailureKind::Timeout, "after 15 s"),
                "Build Box did not answer in time.",
                ServiceCause::ServerSilent,
            ),
            (
                kind(ConnectFailureKind::Refused, "Connection refused"),
                "Build Box refused the connection. Is its SSH server running?",
                ServiceCause::Connection,
            ),
            (
                TerminalError::from_session_ssh(SessionError::ConnectionFailed(
                    "no route to host".into(),
                )),
                "Could not connect to Build Box: no route to host",
                ServiceCause::Connection,
            ),
            (
                kind(ConnectFailureKind::Dns, "no such host"),
                "Could not connect to Build Box: no such host",
                ServiceCause::Connection,
            ),
        ];
        for (error, text, cause) in cases {
            assert_eq!(
                start_reason(&local_on(port), "Build Box", true, &error),
                Reason::new(text, Some(cause)),
                "{error:?}"
            );
        }
        let remote = TunnelType::Remote(RemoteForwardConfig {
            remote_host: "localhost".into(),
            remote_port: 9000,
            local_host: "localhost".into(),
            local_port: 3000,
        });
        let turned_down =
            TerminalError::TunnelError(format!("{}denied", super::REMOTE_FORWARD_FAILED));
        assert_eq!(
            start_reason(&remote, "shop-web", true, &turned_down),
            Reason::new(
                "shop-web did not allow port 9000.",
                Some(ServiceCause::RemotePortRefused)
            )
        );
        // Another failure of a remote one is not about its port.
        let other = TerminalError::TunnelError("Lock error: poisoned".into());
        assert_eq!(start_reason(&remote, "shop-web", true, &other).cause, None);
        // A local one has no remote port to blame.
        assert_eq!(
            start_reason(&local_on(port), "shop-web", true, &turned_down).cause,
            None
        );
    }

    // --- App teardown (ARCH-007, #3105) ---------------------------------------
    //
    // The emitter, the per-tunnel supervisors and their reconnect backoff are
    // spawned on the app-owned `AppTasks` registry. These paused-clock tests
    // show each stops on the app cancellation token — not on its own next tick
    // or backoff deadline — and that teardown completes within its bound.

    /// The live-stats emitter stops mid-sleep on app cancellation: teardown
    /// completes before its first tick would fire, nothing is emitted, and the
    /// tracking slot is cleared.
    #[tokio::test(start_paused = true)]
    async fn stats_emitter_stops_on_app_cancellation() {
        let tasks = crate::app_tasks::AppTasks::new();
        let active: Arc<Mutex<HashMap<String, ActiveTunnel>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let slot = Arc::new(Mutex::new(None));
        let emits = Arc::new(AtomicUsize::new(0));
        let counter = emits.clone();
        let handle = super::spawn_stats_emitter(&tasks, active, slot.clone(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        *slot.lock().unwrap() = Some(handle);
        // Let the loop reach its first sleep.
        tokio::task::yield_now().await;

        let started = tokio::time::Instant::now();
        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;

        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);
        assert!(
            started.elapsed() < super::STATS_EMIT_INTERVAL,
            "stopped on cancellation, not on its first tick"
        );
        assert_eq!(emits.load(Ordering::SeqCst), 0);
        assert!(
            slot.lock().unwrap().is_none(),
            "the emitter self-reaps its slot"
        );
    }

    /// A supervisor's death-watch (no death signal, no liveness watch — it would
    /// wait forever) ends on app cancellation through its child token, exactly
    /// as `supervise` races `cancel` first.
    #[tokio::test(start_paused = true)]
    async fn supervisor_death_watch_stops_on_app_cancellation() {
        let tasks = crate::app_tasks::AppTasks::new();
        let cancel = super::supervisor_cancel_token(&tasks);
        let watch = tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => true,
                _ = wait_forwarder_death(None) => false,
                _ = wait_session_death(None) => false,
            }
        });

        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;

        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);
        assert!(
            watch.await.expect("join"),
            "the cancel branch ended the watch"
        );
    }

    /// A supervisor that entered reconnect backoff (the real tunnel policy,
    /// every attempt failing) is cancelled by app teardown via the
    /// `loop_cancel` child of its supervisor token — well before its backoff
    /// budget would be spent — so teardown completes within its bound.
    #[tokio::test(start_paused = true)]
    async fn supervisor_reconnect_backoff_stops_on_app_cancellation() {
        let tasks = crate::app_tasks::AppTasks::new();
        let loop_cancel = super::supervisor_cancel_token(&tasks).child_token();
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let backoff = tasks.spawn(async move {
            run_reconnect_loop(
                &loop_cancel,
                &tokio::sync::Notify::new(),
                &TUNNEL_RECONNECT_POLICY,
                &mut || 0.5,
                |_, _| {},
                |_| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    false
                },
            )
            .await
        });
        // Let a couple of backoff windows elapse.
        tokio::time::sleep(Duration::from_secs(4)).await;

        let started = tokio::time::Instant::now();
        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;

        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(backoff.await.expect("join"), ReconnectOutcome::Cancelled);
        let before = attempts.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            before,
            "no reconnect attempt runs after teardown"
        );
    }

    /// #2168 regression: `lib.rs` registers the tunnel manager as
    /// `app.manage(Arc::new(manager))`, and the reconnect-backoff loop resolves
    /// it via [`resolve_managed_arc`]. Tauri keys managed state by exact
    /// `TypeId`, so an `Arc<T>` registration is reachable **only** through an
    /// `Arc<T>` lookup — the original bare `try_state::<TunnelManager>()`
    /// silently returned `None`, turning every reconnect attempt into a no-op
    /// `false`. A live mock `Manager` (the only way to exercise real Tauri state
    /// resolution off the `Wry` app) locks the contract: the production resolver
    /// sees the `Arc` registration and yields a real, callable handle, while the
    /// bare-type lookup that caused the bug does not.
    #[test]
    fn resolve_managed_arc_matches_the_arc_registration() {
        /// Stand-in for the managed manager. `attempt` mirrors a real
        /// `attempt_reconnect` on the resolved handle — proving resolution
        /// drives an actual call, not the no-op `false` of the missed lookup.
        struct FakeManager {
            reconnects: AtomicUsize,
        }
        impl FakeManager {
            fn attempt(&self) -> bool {
                self.reconnects.fetch_add(1, Ordering::SeqCst);
                true
            }
        }

        let app = tauri::test::mock_app();
        let managed = Arc::new(FakeManager {
            reconnects: AtomicUsize::new(0),
        });
        // Register exactly as `lib.rs` does for the tunnel manager.
        app.manage(managed.clone());

        // The production resolver matches the `Arc<T>` registration…
        let resolved = resolve_managed_arc::<FakeManager, _>(app.handle())
            .expect("Arc<T> registration must resolve through the Arc<T> lookup");
        assert!(
            Arc::ptr_eq(&managed, &resolved),
            "resolver returns the very manager that was registered",
        );

        // …and drives a real call on it (the #2168 no-op path returned `false`
        // without ever reaching the manager).
        assert!(resolved.attempt());
        assert_eq!(managed.reconnects.load(Ordering::SeqCst), 1);

        // The original bare-type lookup can never match an `Arc<T>`
        // registration — this is the exact miss that broke reconnect.
        assert!(
            app.try_state::<FakeManager>().is_none(),
            "#2168: a bare `try_state::<TunnelManager>()` misses the Arc registration",
        );
    }

    // --- GAP 6: live tunnel-stats emitter (#1248) --------------------------
    //
    // Driving the full periodic emitter loop needs a live Tauri `AppHandle`
    // (for `emit`) plus real forwarders (an `ActiveTunnel` holds an SSH-backed
    // `ActiveForwarder` that cannot be fabricated without a server), which
    // `src-tauri` has no mock harness for. So — like the GAP-3 / GAP-8 tests
    // above — these exercise the production building blocks the emitter uses
    // directly: the shared `ForwarderStats` atomics the forwarders update under
    // traffic, and the `has_active_tunnels` "nothing active -> nothing to
    // publish" predicate that stops the task.

    /// GAP 6: after simulated traffic the forwarder's live counters read back
    /// non-zero — so the emitter ships real ↑/↓ bytes and connection counts,
    /// not the frozen `TunnelStats::default()` zeros of the status event.
    #[test]
    fn forwarder_stats_reflect_simulated_traffic() {
        let stats = ForwarderStats::new();
        // Two connections opened, one already closed.
        stats.increment_active();
        stats.increment_active();
        stats.decrement_active();
        stats.add_bytes_sent(1500);
        stats.add_bytes_received(4096);

        let snapshot = stats.to_tunnel_stats();
        assert_eq!(snapshot.bytes_sent, 1500);
        assert_eq!(snapshot.bytes_received, 4096);
        assert_eq!(snapshot.active_connections, 1, "one of two still open");
        assert_eq!(snapshot.total_connections, 2, "total never decrements");
    }

    /// GAP 6: with no tunnel active the emit tick has nothing to publish — the
    /// signal the emitter task uses to stop itself once the last tunnel goes
    /// away (a dead/errored tunnel reaped by its supervisor #1243).
    #[test]
    fn empty_active_set_stops_emitter() {
        let active: HashMap<String, ActiveTunnel> = HashMap::new();
        assert!(
            !has_active_tunnels(&active),
            "no active tunnel must stop the emitter"
        );
    }

    /// A tunnel's connect runs named after the tunnel (#5943): a host-key
    /// prompt raised by the handshake — which blocks on the calling thread —
    /// names the tunnel, and nothing leaks past the connect.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tunnel_connect_names_the_tunnel_for_its_prompts() {
        use crate::session::prompt_connection_name::current_prompt_connection_name;
        let config = tunnel("web-db", None);
        let seen = super::in_tunnel_prompt_scope(&config, || {
            super::block_on_runtime(async { current_prompt_connection_name() })
        });
        assert_eq!(seen.as_deref(), Some("web-db (tunnel)"));
        assert_eq!(current_prompt_connection_name(), None);
    }

    // ── Companion chained-pair helpers (#2597) ──────────────────────────────

    /// Build a minimal desktop `-L` config, optionally linked to a parent.
    fn tunnel(id: &str, companion_of: Option<&str>) -> TunnelConfig {
        TunnelConfig {
            description: None,
            id: id.to_string(),
            name: id.to_string(),
            ssh_connection_id: "conn-1".to_string(),
            tunnel_type: TunnelType::Local(LocalForwardConfig {
                local_host: "127.0.0.1".to_string(),
                local_port: 5432,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 5432,
            }),
            host: Default::default(),
            auto_start: false,
            start_with_connection: false,
            reconnect_on_disconnect: false,
            companion_of: companion_of.map(str::to_string),
            extra: Default::default(),
        }
    }

    #[test]
    fn connection_bound_tunnel_ids_selects_flagged_tunnels_of_that_connection() {
        let mut bound = tunnel("bound", None);
        bound.start_with_connection = true;
        // Same connection, but not flagged: stays manual.
        let manual = tunnel("manual", None);
        // Flagged, but bound to a different SSH connection.
        let mut other = tunnel("other", None);
        other.start_with_connection = true;
        other.ssh_connection_id = "conn-2".to_string();
        // Flagged companion: follows its parent, never started directly.
        let mut companion = tunnel("companion", Some("bound"));
        companion.start_with_connection = true;
        // App-launch auto-start alone does not bind a tunnel to the session.
        let mut launch_only = tunnel("launch-only", None);
        launch_only.auto_start = true;

        let tunnels = vec![bound, manual, other, companion, launch_only];
        assert_eq!(
            connection_bound_tunnel_ids(&tunnels, "conn-1"),
            vec!["bound".to_string()]
        );
        assert_eq!(
            connection_bound_tunnel_ids(&tunnels, "conn-2"),
            vec!["other".to_string()]
        );
        assert!(connection_bound_tunnel_ids(&tunnels, "conn-missing").is_empty());
    }

    #[test]
    fn find_companion_matches_only_the_linked_child() {
        let tunnels = vec![
            tunnel("parent", None),
            tunnel("companion", Some("parent")),
            tunnel("unrelated", None),
        ];
        // The parent resolves to its companion...
        assert_eq!(
            find_companion(&tunnels, "parent").map(|c| c.id.as_str()),
            Some("companion")
        );
        // ...but a tunnel with no linked child (or the companion itself) has none.
        assert!(find_companion(&tunnels, "unrelated").is_none());
        assert!(find_companion(&tunnels, "companion").is_none());
    }

    #[test]
    fn companion_action_starts_only_once_parent_is_connected() {
        // Parent connected + companion down → start it (ordered bring-up).
        assert_eq!(
            companion_action(&TunnelStatus::Connected, false),
            CompanionAction::Start
        );
        // Parent connected + companion already up → nothing to do (steady state).
        assert_eq!(
            companion_action(&TunnelStatus::Connected, true),
            CompanionAction::None
        );
    }

    #[test]
    fn companion_action_holds_companion_down_while_parent_is_not_connected() {
        // Any non-connected parent state tears a running companion down so it
        // never dangles at a dead listen port.
        for status in [
            TunnelStatus::Connecting,
            TunnelStatus::Reconnecting,
            TunnelStatus::Disconnected,
            TunnelStatus::Error,
            TunnelStatus::Waiting,
            TunnelStatus::Stopping,
            TunnelStatus::MissingConnection,
        ] {
            assert_eq!(
                companion_action(&status, true),
                CompanionAction::Stop,
                "running companion held down for parent {status:?}"
            );
            // Already-down companion needs no action for the same states.
            assert_eq!(
                companion_action(&status, false),
                CompanionAction::None,
                "down companion left alone for parent {status:?}"
            );
        }
    }

    /// #6028: an agent that loses the desktop does not lose its tunnel, so the
    /// hop to it keeps its connections; nor does a down hop come up on a guess.
    #[test]
    fn companion_action_leaves_the_companion_alone_while_the_parent_is_not_reachable() {
        for running in [true, false] {
            assert_eq!(
                companion_action(&TunnelStatus::NotReachable, running),
                CompanionAction::None
            );
        }
    }

    /// #6028: the agent is back without the tunnel.
    #[test]
    fn a_tunnel_that_is_gone_starts_again_only_when_it_reconnects() {
        assert_eq!(gone_tunnel(false, false), GoneTunnel::Stopped);
        assert_eq!(gone_tunnel(false, true), GoneTunnel::StartAgain);
        // Its start got no answer: it did not run, so there is nothing to resume.
        assert_eq!(gone_tunnel(true, true), GoneTunnel::NotStarted);
        assert_eq!(gone_tunnel(true, false), GoneTunnel::NotStarted);
    }

    // ── DUP-019: typed agent-tunnel forward-spec wire bridge ─────────────
    //
    // `start_agent_tunnel` sends the tunnel mode to the agent through the shared
    // `TunnelForwardSpec` type (`forward_spec`) instead of poking a
    // hard-coded `"local"/"remote"/"dynamic"` string into a `Value`. These tests
    // pin the exact wire bytes (they must NOT change — the agent parses them) and
    // assert the desktop discriminator stays identical to the agent enum's serde,
    // so a rename on either side fails here at build time rather than silently on
    // the CI-dark agent-integration lane.

    use crate::terminal::backend::SshConfig;
    use crate::tunnel::config::{DynamicForwardConfig, ReachableFrom, RemoteForwardConfig};
    use termihub_core::protocol::methods::{
        TunnelForwardSpec, TunnelStartParams, TunnelStartResult, TunnelStatusParams,
        TunnelStatusResult, TunnelStopParams,
    };

    fn sample_local() -> LocalForwardConfig {
        LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 5432,
            remote_host: "db.internal".to_string(),
            remote_port: 5433,
        }
    }

    fn sample_remote() -> RemoteForwardConfig {
        RemoteForwardConfig {
            remote_host: "0.0.0.0".to_string(),
            remote_port: 8080,
            local_host: "127.0.0.1".to_string(),
            local_port: 3000,
        }
    }

    fn sample_dynamic() -> DynamicForwardConfig {
        DynamicForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 1080,
        }
    }

    #[test]
    fn agent_forward_wire_bytes_are_stable() {
        // Golden: byte-for-byte the payload produced before DUP-019's typed
        // refactor. Object keys are alphabetical (serde_json has no
        // `preserve_order`), so the internally-tagged `mode` key lands exactly
        // where the old appended literal did. Changing any of these strings is a
        // WIRE BREAK — the agent deserializes them.
        let local = serde_json::to_value(super::TunnelManager::<tauri::Wry>::forward_spec(
            &TunnelType::Local(sample_local()),
        ))
        .expect("serialize local forward");
        assert_eq!(
            serde_json::to_string(&local).unwrap(),
            r#"{"localHost":"127.0.0.1","localPort":5432,"mode":"local","remoteHost":"db.internal","remotePort":5433}"#
        );

        let remote = serde_json::to_value(super::TunnelManager::<tauri::Wry>::forward_spec(
            &TunnelType::Remote(sample_remote()),
        ))
        .expect("serialize remote forward");
        assert_eq!(
            serde_json::to_string(&remote).unwrap(),
            r#"{"localHost":"127.0.0.1","localPort":3000,"mode":"remote","remoteHost":"0.0.0.0","remotePort":8080}"#
        );

        let dynamic = serde_json::to_value(super::TunnelManager::<tauri::Wry>::forward_spec(
            &TunnelType::Dynamic(sample_dynamic()),
        ))
        .expect("serialize dynamic forward");
        assert_eq!(
            serde_json::to_string(&dynamic).unwrap(),
            r#"{"localHost":"127.0.0.1","localPort":1080,"mode":"dynamic"}"#
        );
    }

    #[test]
    fn agent_forward_wire_matches_legacy_string_poke() {
        // Equivalence with the exact pre-refactor construction (serialize the
        // inner config, then append the mode literal), proving the migration
        // preserves the wire for every mode.
        let cases: [(TunnelType, &str); 3] = [
            (TunnelType::Local(sample_local()), "local"),
            (TunnelType::Remote(sample_remote()), "remote"),
            (TunnelType::Dynamic(sample_dynamic()), "dynamic"),
        ];
        for (tunnel_type, mode) in cases {
            let mut legacy = match &tunnel_type {
                TunnelType::Local(c) => serde_json::to_value(c).unwrap(),
                TunnelType::Remote(c) => serde_json::to_value(c).unwrap(),
                TunnelType::Dynamic(c) => serde_json::to_value(c).unwrap(),
            };
            legacy["mode"] = serde_json::json!(mode);
            let typed = serde_json::to_value(super::TunnelManager::<tauri::Wry>::forward_spec(
                &tunnel_type,
            ))
            .unwrap();
            assert_eq!(
                serde_json::to_string(&typed).unwrap(),
                serde_json::to_string(&legacy).unwrap(),
                "typed forward wire diverged from legacy string-poke for {mode}"
            );
        }
    }

    #[test]
    fn desktop_discriminator_matches_agent_spec_mode() {
        // Cross-side contract: the desktop's `mode` string equals the agent
        // `TunnelForwardSpec` enum's own serialized discriminator, and the agent
        // parses the desktop payload back to the matching variant. A serde rename
        // on either side breaks this (and the golden test) at build time.
        let cases: [(TunnelType, TunnelForwardSpec, &str); 3] = [
            (
                TunnelType::Local(sample_local()),
                TunnelForwardSpec::Local(sample_local()),
                "local",
            ),
            (
                TunnelType::Remote(sample_remote()),
                TunnelForwardSpec::Remote(sample_remote()),
                "remote",
            ),
            (
                TunnelType::Dynamic(sample_dynamic()),
                TunnelForwardSpec::Dynamic(sample_dynamic()),
                "dynamic",
            ),
        ];
        for (tunnel_type, agent_spec, expected_mode) in cases {
            let wire = serde_json::to_value(super::TunnelManager::<tauri::Wry>::forward_spec(
                &tunnel_type,
            ))
            .unwrap();
            let agent_mode = serde_json::to_value(&agent_spec).unwrap()["mode"].clone();
            assert_eq!(
                wire["mode"], agent_mode,
                "desktop discriminator diverged from agent spec for {expected_mode}"
            );
            assert_eq!(wire["mode"], serde_json::json!(expected_mode));

            // The agent parses the exact desktop payload back to the right variant.
            let parsed: TunnelForwardSpec = serde_json::from_value(wire).unwrap();
            let round_tripped = matches!(
                (&tunnel_type, &parsed),
                (TunnelType::Local(_), TunnelForwardSpec::Local(_))
                    | (TunnelType::Remote(_), TunnelForwardSpec::Remote(_))
                    | (TunnelType::Dynamic(_), TunnelForwardSpec::Dynamic(_))
            );
            assert!(
                round_tripped,
                "agent parsed the wrong variant for {expected_mode}"
            );
        }
    }

    // ── DUP-001: shared tunnel.* request/response DTOs ───────────────────
    //
    // The desktop now builds every `tunnel.start`/`tunnel.stop`/`tunnel.status`
    // request from the shared `Tunnel*Params` DTOs and parses replies into the
    // shared `Tunnel*Result` DTOs, instead of hand-building `serde_json::json!`
    // params and reading `Value["key"]`. These tests pin the request wire bytes
    // byte-for-byte against the pre-migration hand-built JSON (a change here is a
    // WIRE BREAK — the agent deserializes them) and prove the reply parse.

    #[test]
    fn tunnel_start_params_wire_matches_hand_built_json() {
        // The forward + ssh_config values are serialized identically on both
        // sides, so the only thing this pins is the top-level camelCase wrapper
        // (`tunnelId`/`sshConfig`/`forward`) the desktop used to build by hand.
        let ssh_config = SshConfig::default();
        let forward =
            super::TunnelManager::<tauri::Wry>::forward_spec(&TunnelType::Local(sample_local()));

        // Pre-migration hand-built shape.
        let legacy = serde_json::json!({
            "tunnelId": "tunnel-1",
            "sshConfig": serde_json::to_value(&ssh_config).unwrap(),
            "forward": serde_json::to_value(&forward).unwrap(),
        });

        let typed = serde_json::to_value(TunnelStartParams {
            tunnel_id: "tunnel-1".to_string(),
            ssh_config,
            forward,
        })
        .unwrap();

        assert_eq!(
            serde_json::to_string(&typed).unwrap(),
            serde_json::to_string(&legacy).unwrap(),
            "tunnel.start params wire diverged from the hand-built json!"
        );
    }

    #[test]
    fn tunnel_stop_and_status_params_wire_match_hand_built_json() {
        // Both were `json!({ "tunnelId": tunnel_id })` before the migration.
        let stop = serde_json::to_value(TunnelStopParams {
            tunnel_id: "tunnel-1".to_string(),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&stop).unwrap(),
            r#"{"tunnelId":"tunnel-1"}"#
        );

        let status = serde_json::to_value(TunnelStatusParams {
            tunnel_id: "tunnel-1".to_string(),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"tunnelId":"tunnel-1"}"#
        );
    }

    #[test]
    fn tunnel_start_result_parses_agent_reply() {
        // The exact reply shape the agent sends for `tunnel.start`; the desktop
        // now deserializes it into the shared `TunnelStartResult` instead of
        // reading `result["boundAddress"]`/`result["reachableFrom"]` by hand.
        let reply = serde_json::json!({
            "boundAddress": "127.0.0.1:5432",
            "reachableFrom": "agentOnly"
        });
        let parsed: TunnelStartResult = serde_json::from_value(reply).unwrap();
        assert_eq!(parsed.bound_address, "127.0.0.1:5432");
        assert!(matches!(parsed.reachable_from, ReachableFrom::AgentOnly));
    }

    #[test]
    fn tunnel_status_result_parses_running_and_stopped_replies() {
        // Running reply carries live stats + endpoint fields.
        let running = serde_json::json!({
            "running": true,
            "stats": {
                "bytesSent": 2048,
                "bytesReceived": 4096,
                "activeConnections": 3,
                "totalConnections": 7
            },
            "boundAddress": "127.0.0.1:5432",
            "reachableFrom": "agentOnly"
        });
        let parsed: TunnelStatusResult = serde_json::from_value(running).unwrap();
        assert!(parsed.running);
        assert_eq!(parsed.bound_address.as_deref(), Some("127.0.0.1:5432"));
        assert!(matches!(
            parsed.reachable_from,
            Some(ReachableFrom::AgentOnly)
        ));
        let stats = parsed.stats.expect("running reply carries stats");
        assert_eq!(stats.bytes_sent, 2048);
        assert_eq!(stats.total_connections, 7);

        // Stopped reply: the optional endpoint/stats fields are absent.
        let stopped: TunnelStatusResult =
            serde_json::from_value(serde_json::json!({ "running": false })).unwrap();
        assert!(!stopped.running);
        assert!(stopped.stats.is_none());
        assert!(stopped.bound_address.is_none());
    }

    /// Build a `ConnectionTypeInfo` for the tunnel-capability gate tests,
    /// varying only the `tunneling` flag.
    fn type_info(type_id: &str, tunneling: bool) -> ConnectionTypeInfo {
        ConnectionTypeInfo {
            type_id: type_id.to_string(),
            display_name: type_id.to_string(),
            icon: "terminal".to_string(),
            schema: SettingsSchema { groups: vec![] },
            capabilities: Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: false,
                persistent: false,
                terminal: true,
                tunneling,
            },
        }
    }

    /// PARITY-001: the tunnel-host gate admits a type that advertises the
    /// `tunneling` capability (SSH) and rejects one that does not (telnet),
    /// replacing the former hardcoded `type_id == "ssh"` string check.
    #[test]
    fn tunnel_gate_admits_tunnel_capable_type_rejects_others() {
        let types = vec![
            type_info("ssh", true),
            type_info("telnet", false),
            type_info("serial", false),
        ];

        // SSH advertises the capability → admitted.
        assert!(type_supports_tunneling(&types, "ssh"));
        // Non-forwarding backends → rejected, regardless of name.
        assert!(!type_supports_tunneling(&types, "telnet"));
        assert!(!type_supports_tunneling(&types, "serial"));
        // An unknown / unregistered type is never tunnel-capable.
        assert!(!type_supports_tunneling(&types, "does-not-exist"));
    }

    /// A registered type is gated purely on its declared capability: the same
    /// `type_id` flips from rejected to admitted when it advertises `tunneling`,
    /// proving the gate is capability-driven, not name-driven.
    #[test]
    fn tunnel_gate_follows_declared_capability_not_name() {
        let without = vec![type_info("agent-ssh", false)];
        assert!(!type_supports_tunneling(&without, "agent-ssh"));

        let with = vec![type_info("agent-ssh", true)];
        assert!(type_supports_tunneling(&with, "agent-ssh"));
    }

    /// #4017: a saved SSH connection made in the editor carries the form shape —
    /// `env` as a key/value list (`[]` by default) — which the old strict
    /// `SshConfig` decode rejected ("invalid type: sequence, expected a map"), so
    /// every tunnel on such a connection failed to start.
    #[test]
    fn tunnel_host_config_accepts_the_saved_form_shape() {
        let settings = serde_json::json!({
            "host": "127.0.0.1",
            "port": 2207,
            "username": "testuser",
            "authMethod": "key",
            "keyPath": "/keys/id_ed25519",
            "password": null,
            "env": [],
            "enableX11Forwarding": false,
            "shell": null,
            "proxyJump": [],
        });
        let cfg = tunnel_host_ssh_config("conn-1", &settings).expect("form shape parses");
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 2207);
        assert_eq!(cfg.username, "testuser");
        assert_eq!(cfg.auth_method, "key");
        assert_eq!(cfg.key_path.as_deref(), Some("/keys/id_ed25519"));
        assert!(cfg.env.is_empty());
        assert!(cfg.proxy_jump.is_empty());

        let with_env = serde_json::json!({
            "host": "h", "username": "u", "authMethod": "key",
            "env": [{"key": "LANG", "value": "C.UTF-8"}],
        });
        let cfg = tunnel_host_ssh_config("conn-2", &with_env).unwrap();
        assert_eq!(cfg.env.get("LANG").map(String::as_str), Some("C.UTF-8"));
    }

    #[test]
    fn tunnel_host_config_expands_the_key_path_and_rejects_a_missing_host() {
        let settings = serde_json::json!({
            "host": "h", "username": "u", "authMethod": "key", "keyPath": "~/.ssh/id",
        });
        let cfg = tunnel_host_ssh_config("conn-3", &settings).unwrap();
        assert!(!cfg.key_path.unwrap().starts_with('~'));

        let err = tunnel_host_ssh_config("conn-4", &serde_json::json!({"username": "u"}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("conn-4") && err.contains("no host"), "{err}");
    }
}

#[cfg(test)]
#[path = "tunnel_manager_agent_tests.rs"]
mod agent_tests;

#[cfg(test)]
#[path = "tunnel_manager_desktop_tests.rs"]
mod desktop_tests;
