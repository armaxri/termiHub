//! Embedded server lifted onto the core [`Service`] trait.
//!
//! # S2 relocation — embedded servers on the core `Service` trait (#2154, #2192)
//!
//! Following the HTTP-monitor pilot (#2157/#2172), each embedded HTTP/FTP/TFTP
//! server is an [`EmbeddedServerService`] implementing the core
//! [`Service`](crate::service::Service) trait (the S1 substrate from #2148). A
//! server's lifecycle — spawn its listener thread, confirm the bind, track live
//! stats, stop — is owned by the service, which emits status transitions as
//! [`ServiceEvent`](crate::service::ServiceEvent)s on the core-owned
//! [`EventChannel`](crate::service::EventChannel) instead of a host-specific
//! emitter. The desktop host bridges that channel to the existing
//! `embedded-server-status-changed` Tauri event, and the agent bridges it to its
//! RPC event stream, so both hosts run the same implementation unchanged.
//!
//! Decoupling the servers from `AppHandle` (#2154) is what let the *same* service
//! run on the desktop **or** a remote agent; #2192 relocated the implementations
//! here so the agent crate can compile and host them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use thiserror::Error;

use crate::connection::schema::{FieldType, SettingsField, SettingsGroup};
use crate::connection::SettingsSchema;
use crate::service::{
    EventChannel, Service, ServiceCapabilities, ServiceError, ServiceEvent, ServiceEventReceiver,
    ServiceStatus,
};

use super::config::{
    AtomicServerStats, EmbeddedServerConfig, ServerState, ServerStats, ServerStatus, ServerType,
};
use super::ftp_server::start_ftp_server;
use super::http_server::start_http_server;
use super::tftp_server::start_tftp_server;

/// Error from an embedded-server lifecycle operation.
///
/// A thin string newtype so the desktop can map it onto its `TerminalError`
/// (and the async [`Service`] trait onto [`ServiceError`]) while preserving the
/// exact user-facing message text the servers produced before the #2192
/// relocation.
#[derive(Debug, Clone, Error)]
#[error("{0}")]
pub struct EmbeddedServerError(pub String);

impl EmbeddedServerError {
    /// Build an error from any displayable value.
    fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

/// Machine-readable service id for the embedded HTTP server.
pub const SERVICE_ID_HTTP: &str = "http_server";
/// Machine-readable service id for the embedded FTP server.
pub const SERVICE_ID_FTP: &str = "ftp_server";
/// Machine-readable service id for the embedded TFTP server.
pub const SERVICE_ID_TFTP: &str = "tftp_server";

/// Event kind emitted on the [`EventChannel`] for each status transition.
///
/// The payload is a [`ServerState`], matching the `embedded-server-status-changed`
/// Tauri event the desktop host bridges it to.
pub const STATUS_EVENT_KIND: &str = "status";

/// How long the service waits for a server thread to confirm its bind before
/// treating the start as failed. Binding a local socket is near-instant, so a
/// generous timeout only guards against a wedged thread (GAP G3, #1145).
const BIND_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// The core [`service_id`](Service::service_id) for a [`ServerType`].
pub fn service_id_for(server_type: &ServerType) -> &'static str {
    match server_type {
        ServerType::Http => SERVICE_ID_HTTP,
        ServerType::Ftp => SERVICE_ID_FTP,
        ServerType::Tftp => SERVICE_ID_TFTP,
    }
}

/// Human-readable [`display_name`](Service::display_name) for a [`ServerType`].
pub fn display_name_for(server_type: &ServerType) -> &'static str {
    match server_type {
        ServerType::Http => "HTTP Server",
        ServerType::Ftp => "FTP Server",
        ServerType::Tftp => "TFTP Server",
    }
}

/// One-shot handle a server thread uses to report whether its listening socket
/// bound successfully.
///
/// The service holds the receiving end and only reports `Running` once
/// [`BindSignal::confirm`] arrives; a [`BindSignal::fail`] (or a dropped sender)
/// keeps the server out of the active slot so it never shows a stuck "Running"
/// before flipping to `Error` (GAP G3, #1145).
pub struct BindSignal {
    tx: SyncSender<Result<(), String>>,
}

impl BindSignal {
    /// Report that the listening socket bound successfully.
    pub fn confirm(&self) {
        // A full/closed channel means the service already gave up waiting; the
        // send failure is harmless because the thread will still shut down.
        let _ = self.tx.send(Ok(()));
    }

    /// Report that binding failed, carrying the reason for the UI.
    pub fn fail(&self, reason: &str) {
        let _ = self.tx.send(Err(reason.to_string()));
    }
}

/// Decision the service makes from a server thread's bind signal.
#[derive(Debug)]
enum BindOutcome {
    /// The socket bound — keep the active entry and report `Running`.
    Running,
    /// The bind failed (explicit error, dropped sender, or timeout) — drop the
    /// active entry and report `Error` with this reason.
    Failed(String),
}

/// Map a server thread's bind signal (received over the confirm channel) to the
/// service's next action, so `Running` is only ever produced after a *confirmed*
/// bind (GAP G3, #1145).
///
/// Pure and `AppHandle`-free so the start-flow decision can be unit-tested.
fn decide_bind_outcome(signal: Result<Result<(), String>, RecvTimeoutError>) -> BindOutcome {
    match signal {
        Ok(Ok(())) => BindOutcome::Running,
        Ok(Err(reason)) => BindOutcome::Failed(reason),
        Err(RecvTimeoutError::Disconnected) => {
            BindOutcome::Failed("server exited before confirming it was listening".to_string())
        }
        Err(RecvTimeoutError::Timeout) => {
            BindOutcome::Failed("server did not confirm it was listening in time".to_string())
        }
    }
}

/// A running server instance.
struct ActiveServer {
    shutdown: Arc<AtomicBool>,
    #[allow(dead_code)]
    thread_handle: thread::JoinHandle<()>,
    stats: Arc<AtomicServerStats>,
    started_at: String,
    /// Shared status updated by the server thread on error.
    error: Arc<Mutex<Option<String>>>,
}

/// A single embedded HTTP/FTP/TFTP server lifted onto the core [`Service`] trait.
///
/// Created stopped for a given [`ServerType`]; a call to
/// [`start_with`](Self::start_with) (or the trait's async
/// [`start`](Service::start)) spawns the listener thread and, once the bind is
/// confirmed, emits a [`ServiceStatus::Running`] transition on the
/// [`EventChannel`]. The server implementations themselves
/// ([`start_http_server`] etc.) are unchanged and fully `AppHandle`-free.
pub struct EmbeddedServerService {
    /// Which protocol this service hosts.
    server_type: ServerType,
    /// Config, set once the service is started. `None` before the first start.
    config: Option<EmbeddedServerConfig>,
    /// The live listener thread + its shared state, when running.
    active: Option<ActiveServer>,
    /// Current lifecycle status.
    status: ServiceStatus,
    /// Core event channel status transitions are emitted through.
    events: EventChannel,
}

impl EmbeddedServerService {
    /// Create a new, stopped embedded server service for `server_type`.
    pub fn new(server_type: ServerType) -> Self {
        Self {
            server_type,
            config: None,
            active: None,
            status: ServiceStatus::Stopped,
            events: EventChannel::new(),
        }
    }

    /// Emit a [`ServerState`] on the event channel as a `status` [`ServiceEvent`].
    fn emit_state(&self, state: ServerState) {
        self.events
            .emit(ServiceEvent::new(STATUS_EVENT_KIND, state));
    }

    /// Attempt a quick bind to check whether a config's port is available.
    ///
    /// Static so the pre-flight check can be exercised without a live service.
    pub fn check_port_config(config: &EmbeddedServerConfig) -> Result<(), EmbeddedServerError> {
        let addr = format!("{}:{}", config.bind_host, config.port);
        match config.server_type {
            ServerType::Tftp => {
                let socket = std::net::UdpSocket::bind(&addr).map_err(|e| {
                    EmbeddedServerError::new(format!("Port {} is already in use: {e}", config.port))
                })?;
                drop(socket);
            }
            _ => {
                let listener = std::net::TcpListener::bind(&addr).map_err(|e| {
                    EmbeddedServerError::new(format!("Port {} is already in use: {e}", config.port))
                })?;
                drop(listener);
            }
        }
        Ok(())
    }

    /// Start the server for `config` synchronously.
    ///
    /// Spawns the listener thread, waits for its bind to confirm, and emits the
    /// `Starting` → `Running` (or `Error`) transitions on the [`EventChannel`].
    /// The desktop host calls this directly from a synchronous Tauri command; the
    /// trait's async [`start`](Service::start) parses a JSON config and delegates
    /// here.
    pub fn start_with(&mut self, config: EmbeddedServerConfig) -> Result<(), EmbeddedServerError> {
        // A live server genuinely blocks a second start; a dead husk from a prior
        // runtime failure does not (so a start acts as a Retry — GAP G2/G9).
        if self.is_live() {
            return Err(EmbeddedServerError::new(format!(
                "Server {} is already running",
                config.id
            )));
        }
        self.active = None;

        // Pre-flight bind check so we can return immediately for the common
        // "port already in use" case.
        Self::check_port_config(&config)?;

        self.status = ServiceStatus::Starting;
        self.config = Some(config.clone());
        self.emit_state(build_status_state(
            &config.id,
            ServerStatus::Starting,
            None,
            ServerStats::default(),
            None,
        ));

        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = AtomicServerStats::new();
        let error_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // One-slot channel the server thread uses to confirm (or reject) its real
        // bind. `Running` is only emitted after this confirmation, so a late bind
        // failure never leaves the item stuck green (GAP G3, #1145).
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let cfg = config.clone();
        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);
        let error_clone = Arc::clone(&error_slot);
        let events = self.events.clone();
        let id = config.id.clone();

        let thread_handle = thread::spawn(move || {
            let ready = BindSignal { tx: ready_tx };
            let result = match cfg.server_type {
                ServerType::Http => start_http_server(&cfg, shutdown_clone, stats_clone, ready),
                ServerType::Ftp => start_ftp_server(&cfg, shutdown_clone, stats_clone, ready),
                ServerType::Tftp => start_tftp_server(&cfg, shutdown_clone, stats_clone, ready),
            };

            if let Err(e) = result {
                let msg = e.to_string();
                tracing::error!(%id, "Embedded server error: {msg}");
                if let Ok(mut slot) = error_clone.lock() {
                    *slot = Some(msg.clone());
                }
                events.emit(ServiceEvent::new(
                    STATUS_EVENT_KIND,
                    build_status_state(
                        &id,
                        ServerStatus::Error,
                        Some(msg),
                        ServerStats::default(),
                        None,
                    ),
                ));
            }
        });

        // Wait for the thread to confirm its bind before declaring Running.
        match decide_bind_outcome(ready_rx.recv_timeout(BIND_CONFIRM_TIMEOUT)) {
            BindOutcome::Running => {
                let started_at = chrono::Utc::now().to_rfc3339();
                let snapshot = stats.snapshot();
                self.active = Some(ActiveServer {
                    shutdown,
                    thread_handle,
                    stats,
                    started_at: started_at.clone(),
                    error: error_slot,
                });
                self.status = ServiceStatus::Running;
                self.emit_state(build_status_state(
                    &config.id,
                    ServerStatus::Running,
                    None,
                    snapshot,
                    Some(started_at),
                ));
                tracing::info!(server_id = %config.id, "Embedded server started");
                Ok(())
            }
            BindOutcome::Failed(reason) => {
                // Bind never confirmed. Signal the thread to unwind (in case it
                // did bind but timed out) and leave nothing active, so the server
                // is reported as Error rather than a stuck Running.
                shutdown.store(true, Ordering::Relaxed);
                self.status = ServiceStatus::Failed(reason.clone());
                tracing::warn!(server_id = %config.id, "Embedded server failed to start: {reason}");
                self.emit_state(build_status_state(
                    &config.id,
                    ServerStatus::Error,
                    Some(reason.clone()),
                    ServerStats::default(),
                    None,
                ));
                Err(EmbeddedServerError::new(reason))
            }
        }
    }

    /// Stop the running server, emitting a `Stopped` transition.
    ///
    /// The server thread exits on its own after its next poll cycle (we do not
    /// join, to avoid blocking the caller). Synchronous counterpart of the
    /// trait's async [`stop`](Service::stop).
    pub fn shutdown(&mut self) {
        if let Some(active) = self.active.take() {
            active.shutdown.store(true, Ordering::Relaxed);
            if let Some(config) = &self.config {
                self.status = ServiceStatus::Stopped;
                self.events.emit(ServiceEvent::new(
                    STATUS_EVENT_KIND,
                    build_status_state(
                        &config.id,
                        ServerStatus::Stopped,
                        None,
                        ServerStats::default(),
                        None,
                    ),
                ));
                tracing::info!(server_id = %config.id, "Embedded server stopped");
            }
        }
        self.status = ServiceStatus::Stopped;
    }

    /// Whether the server is currently live (running, with no recorded runtime
    /// error). A dead husk left by a runtime failure is not live, so a fresh
    /// start acts as a Retry (GAP G2/G9, #1145).
    pub fn is_live(&self) -> bool {
        self.active
            .as_ref()
            .map(|a| active_entry_is_live(&a.error))
            .unwrap_or(false)
    }

    /// Snapshot this server's runtime [`ServerState`] for listing.
    ///
    /// Returns `None` for a service that was never started (no config).
    pub fn state(&self) -> Option<ServerState> {
        let config = self.config.as_ref()?;
        Some(match &self.active {
            Some(active) => {
                let error = active.error.lock().ok().and_then(|e| e.clone());
                let status = if error.is_some() {
                    ServerStatus::Error
                } else {
                    ServerStatus::Running
                };
                ServerState {
                    server_id: config.id.clone(),
                    status,
                    error,
                    stats: active.stats.snapshot(),
                    started_at: Some(active.started_at.clone()),
                }
            }
            None => ServerState {
                server_id: config.id.clone(),
                status: ServerStatus::Stopped,
                error: None,
                stats: ServerStats::default(),
                started_at: None,
            },
        })
    }

    /// The settings schema for a server type (keys match [`EmbeddedServerConfig`]'s
    /// camelCase fields). Backs the run-location / server-config discovery UI.
    fn schema_for(server_type: &ServerType) -> SettingsSchema {
        let mut fields = vec![
            field("name", "Name", FieldType::Text, true, None),
            field(
                "rootDirectory",
                "Root directory",
                FieldType::Text,
                true,
                None,
            ),
            field(
                "bindHost",
                "Bind host",
                FieldType::Text,
                true,
                Some(Value::from("127.0.0.1")),
            ),
            field(
                "port",
                "Port",
                FieldType::Number {
                    min: Some(1.0),
                    max: Some(65_535.0),
                },
                true,
                None,
            ),
            field(
                "autoStart",
                "Start on launch",
                FieldType::Boolean,
                false,
                Some(Value::Bool(false)),
            ),
            field(
                "readOnly",
                "Read-only",
                FieldType::Boolean,
                false,
                Some(Value::Bool(false)),
            ),
        ];
        if *server_type == ServerType::Http {
            fields.push(field(
                "directoryListing",
                "Directory listing",
                FieldType::Boolean,
                false,
                Some(Value::Bool(true)),
            ));
        }
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "server".to_string(),
                label: display_name_for(server_type).to_string(),
                fields,
            }],
        }
    }

    /// Test-only: construct a service in the `Running` state with `config` but
    /// **without** spawning a real listener thread, so host-level bookkeeping
    /// tests need no real socket.
    #[cfg(test)]
    pub(crate) fn test_running(config: EmbeddedServerConfig) -> Self {
        let mut svc = Self::new(config.server_type.clone());
        svc.active = Some(ActiveServer {
            shutdown: Arc::new(AtomicBool::new(false)),
            thread_handle: thread::spawn(|| {}),
            stats: AtomicServerStats::new(),
            started_at: chrono::Utc::now().to_rfc3339(),
            error: Arc::new(Mutex::new(None)),
        });
        svc.status = ServiceStatus::Running;
        svc.config = Some(config);
        svc
    }
}

#[async_trait]
impl Service for EmbeddedServerService {
    fn service_id(&self) -> &str {
        service_id_for(&self.server_type)
    }

    fn display_name(&self) -> &str {
        display_name_for(&self.server_type)
    }

    fn settings_schema(&self) -> SettingsSchema {
        Self::schema_for(&self.server_type)
    }

    fn capabilities(&self) -> ServiceCapabilities {
        ServiceCapabilities {
            configurable: true,
            emits_events: true,
            // Serving files from a remote vantage point is a natural agent
            // run-location; embedded servers are not in the permanent
            // desktop-only set (credentials, spawn rendezvous, file watch,
            // OS-window management).
            desktop_only: false,
        }
    }

    async fn start(&mut self, config: Value) -> Result<(), ServiceError> {
        let config: EmbeddedServerConfig = serde_json::from_value(config)
            .map_err(|e| ServiceError::InvalidConfig(e.to_string()))?;
        if config.server_type != self.server_type {
            return Err(ServiceError::InvalidConfig(format!(
                "config is for a {:?} server but this service hosts {:?}",
                config.server_type, self.server_type
            )));
        }
        self.start_with(config)
            .map_err(|e| ServiceError::StartFailed(e.to_string()))
    }

    async fn stop(&mut self) -> Result<(), ServiceError> {
        self.shutdown();
        Ok(())
    }

    fn status(&self) -> ServiceStatus {
        self.status.clone()
    }

    fn subscribe_events(&self) -> ServiceEventReceiver {
        self.events.subscribe()
    }
}

/// Build a settings field with sensible defaults for the parts we don't use.
fn field(
    key: &str,
    label: &str,
    field_type: FieldType,
    required: bool,
    default: Option<Value>,
) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: None,
        help_text: None,
        field_type,
        required,
        default,
        placeholder: None,
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: None,
    }
}

/// Assemble the [`ServerState`] broadcast on `embedded-server-status-changed`.
///
/// Kept as a free function so the payload contract (real stats + `started_at`
/// carried through, not zeroed — GAP G6, #1145) can be unit-tested.
pub(super) fn build_status_state(
    server_id: &str,
    status: ServerStatus,
    error: Option<String>,
    stats: ServerStats,
    started_at: Option<String>,
) -> ServerState {
    ServerState {
        server_id: server_id.to_string(),
        status,
        error,
        stats,
        started_at,
    }
}

/// Decide whether an active entry represents a *live* server (as opposed to a
/// dead husk left behind by a runtime failure).
///
/// A live entry (empty error slot) must block a second concurrent start; a
/// failed entry (error slot set) must NOT, so a subsequent start acts as a Retry
/// rather than being rejected as "already running" (GAP G2/G9, #1145).
fn active_entry_is_live(error: &Arc<Mutex<Option<String>>>) -> bool {
    // If the lock is poisoned we cannot prove the server is healthy, so treat it
    // as not-live and allow a fresh start to recover.
    error.lock().map(|slot| slot.is_none()).unwrap_or(false)
}

/// Build the `Error` [`ServerState`] surfaced when a server marked `auto_start`
/// fails to start at launch (e.g. its port is already in use) (GAP G7, #1145).
pub fn auto_start_error_state(server_id: &str, error: &str) -> ServerState {
    ServerState {
        server_id: server_id.to_string(),
        status: ServerStatus::Error,
        error: Some(error.to_string()),
        stats: ServerStats::default(),
        started_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::ServiceEventReceiver;
    use std::sync::mpsc;

    fn http_config(port: u16) -> EmbeddedServerConfig {
        EmbeddedServerConfig {
            id: "srv-http".to_string(),
            name: "Test HTTP".to_string(),
            server_type: ServerType::Http,
            root_directory: ".".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port,
            auto_start: false,
            read_only: true,
            directory_listing: Some(true),
            ftp_auth: None,
        }
    }

    async fn recv_state(rx: &mut ServiceEventReceiver) -> ServerState {
        let event = rx
            .recv()
            .await
            .expect("a status event must arrive on the channel");
        assert_eq!(event.kind, STATUS_EVENT_KIND);
        serde_json::from_value(event.payload).expect("payload is a ServerState")
    }

    // ── bind-outcome decision (GAP G3, #1145) ─────────────────────────────────

    #[test]
    fn bind_success_signal_yields_running() {
        assert!(matches!(
            decide_bind_outcome(Ok(Ok(()))),
            BindOutcome::Running
        ));
    }

    #[test]
    fn bind_failure_signal_yields_failed_with_reason() {
        match decide_bind_outcome(Ok(Err("Port 8080 is already in use".to_string()))) {
            BindOutcome::Failed(reason) => assert!(reason.contains("already in use")),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn bind_disconnected_signal_yields_failed() {
        assert!(matches!(
            decide_bind_outcome(Err(mpsc::RecvTimeoutError::Disconnected)),
            BindOutcome::Failed(_)
        ));
    }

    #[test]
    fn bind_timeout_signal_yields_failed() {
        assert!(matches!(
            decide_bind_outcome(Err(mpsc::RecvTimeoutError::Timeout)),
            BindOutcome::Failed(_)
        ));
    }

    // ── liveness (GAP G2/G9) ──────────────────────────────────────────────────

    #[test]
    fn active_entry_without_error_is_live() {
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        assert!(active_entry_is_live(&error));
    }

    #[test]
    fn errored_active_entry_is_not_live_so_start_is_allowed() {
        let error: Arc<Mutex<Option<String>>> =
            Arc::new(Mutex::new(Some("Port 8080 is already in use".to_string())));
        assert!(!active_entry_is_live(&error));
    }

    // ── status payload contract (GAP G6) ──────────────────────────────────────

    #[test]
    fn status_state_carries_real_stats_and_started_at() {
        let stats = ServerStats {
            active_connections: 2,
            total_connections: 7,
            bytes_sent: 4096,
            bytes_received: 512,
        };
        let started_at = "2024-01-01T00:00:00+00:00".to_string();
        let state = build_status_state(
            "srv-1",
            ServerStatus::Running,
            None,
            stats,
            Some(started_at.clone()),
        );
        assert_eq!(state.stats.total_connections, 7);
        assert_eq!(state.stats.active_connections, 2);
        assert_eq!(state.stats.bytes_sent, 4096);
        assert_eq!(state.stats.bytes_received, 512);
        assert_eq!(state.started_at, Some(started_at));
    }

    #[test]
    fn status_state_defaults_when_no_active_entry() {
        let state = build_status_state(
            "srv-1",
            ServerStatus::Stopped,
            None,
            ServerStats::default(),
            None,
        );
        assert_eq!(state.status, ServerStatus::Stopped);
        assert_eq!(state.stats.total_connections, 0);
        assert!(state.started_at.is_none());
    }

    // ── Service metadata / schema ─────────────────────────────────────────────

    #[test]
    fn service_metadata_and_capabilities() {
        for (ty, id) in [
            (ServerType::Http, SERVICE_ID_HTTP),
            (ServerType::Ftp, SERVICE_ID_FTP),
            (ServerType::Tftp, SERVICE_ID_TFTP),
        ] {
            let svc = EmbeddedServerService::new(ty);
            assert_eq!(svc.service_id(), id);
            let caps = svc.capabilities();
            assert!(caps.configurable);
            assert!(caps.emits_events);
            // Serving files may run on an agent — not desktop-only.
            assert!(!caps.desktop_only);
            // The schema exposes the core config fields.
            let keys: Vec<String> = svc
                .settings_schema()
                .groups
                .iter()
                .flat_map(|g| g.fields.iter().map(|f| f.key.clone()))
                .collect();
            for expected in ["name", "rootDirectory", "bindHost", "port"] {
                assert!(keys.contains(&expected.to_string()), "missing {expected}");
            }
        }
    }

    #[test]
    fn http_schema_has_directory_listing_but_tftp_does_not() {
        let http_keys: Vec<String> = EmbeddedServerService::new(ServerType::Http)
            .settings_schema()
            .groups
            .iter()
            .flat_map(|g| g.fields.iter().map(|f| f.key.clone()))
            .collect();
        assert!(http_keys.contains(&"directoryListing".to_string()));

        let tftp_keys: Vec<String> = EmbeddedServerService::new(ServerType::Tftp)
            .settings_schema()
            .groups
            .iter()
            .flat_map(|g| g.fields.iter().map(|f| f.key.clone()))
            .collect();
        assert!(!tftp_keys.contains(&"directoryListing".to_string()));
    }

    #[test]
    fn new_service_is_stopped_with_no_state() {
        let svc = EmbeddedServerService::new(ServerType::Http);
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        assert!(!svc.is_live());
        assert!(svc.state().is_none());
    }

    #[test]
    fn test_running_service_reports_live_running_state() {
        // A service constructed in the Running state (no real socket) lists as a
        // live, running server — the shape the host uses for bookkeeping.
        let svc = EmbeddedServerService::test_running(http_config(0));
        assert_eq!(svc.status(), ServiceStatus::Running);
        assert!(svc.is_live());
        let state = svc.state().expect("a started service has a state");
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(state.server_id, "srv-http");
    }

    // ── real lifecycle over a live socket ─────────────────────────────────────

    #[tokio::test]
    async fn start_runs_and_emits_status_through_event_channel() {
        // An ephemeral port the HTTP server can bind.
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let mut svc = EmbeddedServerService::new(ServerType::Http);
        let mut rx = svc.subscribe_events();
        let cfg = http_config(port);
        svc.start(serde_json::to_value(&cfg).unwrap())
            .await
            .expect("start should succeed");

        assert_eq!(svc.status(), ServiceStatus::Running);
        assert!(svc.is_live());

        // Starting → Running transitions arrive on the core EventChannel (not a
        // Tauri emitter).
        let starting = recv_state(&mut rx).await;
        assert_eq!(starting.status, ServerStatus::Starting);
        let running = recv_state(&mut rx).await;
        assert_eq!(running.status, ServerStatus::Running);
        assert_eq!(running.server_id, cfg.id);

        svc.stop().await.expect("stop");
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        assert!(!svc.is_live());
        let stopped = recv_state(&mut rx).await;
        assert_eq!(stopped.status, ServerStatus::Stopped);
    }

    #[tokio::test]
    async fn start_rejects_invalid_config() {
        let mut svc = EmbeddedServerService::new(ServerType::Http);
        let err = svc.start(serde_json::json!({ "id": "x" })).await;
        assert!(matches!(err, Err(ServiceError::InvalidConfig(_))));
        assert_eq!(svc.status(), ServiceStatus::Stopped);
    }

    #[tokio::test]
    async fn start_rejects_mismatched_server_type() {
        // An FTP config handed to an HTTP service is a config error, not a start.
        let mut svc = EmbeddedServerService::new(ServerType::Http);
        let mut cfg = http_config(0);
        cfg.server_type = ServerType::Ftp;
        let err = svc.start(serde_json::to_value(&cfg).unwrap()).await;
        assert!(matches!(err, Err(ServiceError::InvalidConfig(_))));
    }

    #[test]
    fn start_with_rejects_busy_port() {
        // Hold a port, then a start against it must fail the pre-flight bind check
        // and return an error (matching the original manager: the interactive
        // caller surfaces the returned error; no listener is left running).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let busy = listener.local_addr().unwrap().port();

        let mut svc = EmbeddedServerService::new(ServerType::Http);
        let err = svc
            .start_with(http_config(busy))
            .expect_err("busy port must fail the pre-flight bind");
        assert!(err.to_string().contains("already in use"));
        assert!(
            !svc.is_live(),
            "a failed start must not leave a live server"
        );
        drop(listener);
    }
}
