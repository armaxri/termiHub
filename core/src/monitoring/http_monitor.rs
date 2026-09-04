//! Periodic HTTP monitor — checks a URL at a fixed interval and emits events.
//!
//! # Hosted on the desktop or a remote agent (#2592)
//!
//! The monitor lives on the core [`Service`](crate::service::Service) trait (the
//! S1 substrate from #2148; lifted onto the trait in #2157/#2172): its poll loop
//! is decoupled from any host-specific emitter and instead emits
//! [`ServiceEvent`](crate::service::ServiceEvent)s carrying an [`HttpCheckResult`]
//! on the core-owned [`EventChannel`](crate::service::EventChannel). Because it is
//! `AppHandle`-free, the **same** implementation runs on the desktop host **or** a
//! remote agent — #2592 relocated it here (out of `src-tauri/`) behind the
//! `http-monitor` cargo feature so the agent crate can compile and host it, exactly
//! as #2192 did for the embedded servers. The desktop host bridges the channel to
//! the `network-http-monitor-check` Tauri event; the agent bridges it to its
//! `service.status` RPC stream, so the frontend cannot tell where a monitor runs.
//!
//! The poll loop is driven on a dedicated OS thread with its own current-thread
//! tokio runtime (`reqwest` needs a reactor). This makes the service host-agnostic:
//! the desktop can start it from a synchronous Tauri command thread that has no
//! ambient runtime, and the agent can start it from its async dispatcher, both
//! without a "no reactor running" panic.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use uuid::Uuid;

use crate::connection::schema::{FieldType, SelectOption, SettingsField, SettingsGroup};
use crate::connection::SettingsSchema;
use crate::service::{
    EventChannel, Service, ServiceCapabilities, ServiceError, ServiceEvent, ServiceEventReceiver,
    ServiceRegistry, ServiceStatus,
};

/// Machine-readable service id used in the [`ServiceRegistry`] and run-location
/// routing.
pub const SERVICE_ID: &str = "http_monitor";

/// Human-readable service name.
pub const DISPLAY_NAME: &str = "HTTP Monitor";

/// Icon identifier for the run-location / service-discovery UI.
pub const ICON: &str = "activity";

/// Event kind emitted on the [`EventChannel`] for each completed check.
pub const CHECK_EVENT_KIND: &str = "check";

/// Minimum poll interval, in milliseconds.
///
/// The frontend's `min={5}` on the interval field is only a soft HTML hint —
/// an empty field yields `Number("")` → `NaN` → `0`, which would otherwise be
/// forwarded verbatim and turn the poll loop into a tight busy-loop of
/// requests. Clamping to this floor server-side guarantees a sane cadence
/// regardless of what the UI (or any future caller) sends.
pub const MIN_INTERVAL_MS: u64 = 1_000;

/// Register the HTTP-monitor factory in a [`ServiceRegistry`].
///
/// Shared by the desktop host ([`NetworkManager`]) and the agent so both offer
/// the monitor with an identical id, schema, capabilities, and icon — the single
/// source of truth for what "an HTTP monitor" is (mirroring
/// [`crate::embedded_servers::build_service_registry`]).
///
/// [`NetworkManager`]: https://docs.rs/termihub
pub fn register_http_monitor(registry: &mut ServiceRegistry) {
    registry.register(
        SERVICE_ID,
        DISPLAY_NAME,
        ICON,
        Box::new(|| Box::new(HttpMonitorService::new())),
    );
}

/// Configuration for a single HTTP monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpMonitorConfig {
    pub id: String,
    pub url: String,
    pub interval_ms: u64,
    pub method: String,
    pub expected_status: u16,
    pub timeout_ms: u64,
}

/// The result of a single HTTP check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpCheckResult {
    pub monitor_id: String,
    pub status_code: Option<u16>,
    pub latency_ms: Option<u64>,
    pub ok: bool,
    pub error: Option<String>,
    pub timestamp_ms: u64,
}

/// Current state of a monitor (for listing).
///
/// The lifecycle is derived from two booleans:
/// - `running`  — the poll loop is alive (`false` == stopped-but-listed).
/// - `paused`   — the loop is alive but its poll body is suspended.
///
/// (`running: false` implies `paused: false`.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpMonitorState {
    pub config: HttpMonitorConfig,
    pub running: bool,
    pub paused: bool,
    pub last_result: Option<HttpCheckResult>,
}

impl HttpMonitorConfig {
    /// Create a new config with a generated ID.
    ///
    /// `interval_ms` is clamped to at least [`MIN_INTERVAL_MS`] so a `0` or
    /// tiny value can never turn the poll loop into a request busy-loop.
    pub fn new(
        url: String,
        interval_ms: u64,
        method: String,
        expected_status: u16,
        timeout_ms: u64,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            url,
            interval_ms: interval_ms.max(MIN_INTERVAL_MS),
            method,
            expected_status,
            timeout_ms,
        }
    }
}

/// The HTTP monitor lifted onto the core [`Service`] trait.
///
/// One instance drives one URL's poll loop. Created stopped; a call to
/// [`start`](Service::start) with a JSON [`HttpMonitorConfig`] spawns the loop,
/// which emits a [`CHECK_EVENT_KIND`] [`ServiceEvent`] (payload:
/// [`HttpCheckResult`]) on the [`EventChannel`] after every check.
///
/// Beyond the trait lifecycle it keeps the monitor-specific
/// [`pause`](Self::pause) / [`resume`](Self::resume) controls the desktop
/// manager needs; these are not part of the generic [`Service`] surface.
pub struct HttpMonitorService {
    /// Config, set once the service is started. `None` before the first start.
    config: Option<HttpMonitorConfig>,
    /// Current lifecycle status.
    status: ServiceStatus,
    /// Cancellation token for the running poll loop (fresh on each start).
    cancel: CancellationToken,
    /// When set, the poll loop stays alive but skips the HTTP check (Pause).
    paused: Arc<AtomicBool>,
    /// Latest check result, shared with the poll loop.
    last_result: Arc<Mutex<Option<HttpCheckResult>>>,
    /// Core event channel the poll loop emits `check` events through.
    events: EventChannel,
}

impl HttpMonitorService {
    /// Create a new, stopped HTTP monitor service.
    pub fn new() -> Self {
        Self {
            config: None,
            status: ServiceStatus::Stopped,
            cancel: CancellationToken::new(),
            paused: Arc::new(AtomicBool::new(false)),
            last_result: Arc::new(Mutex::new(None)),
            events: EventChannel::new(),
        }
    }

    /// The settings schema for the HTTP monitor form (keys match
    /// [`HttpMonitorConfig`]'s camelCase fields).
    fn schema() -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "monitor".to_string(),
                label: "HTTP Monitor".to_string(),
                fields: vec![
                    field("url", "URL", FieldType::Text, true, None),
                    field(
                        "intervalMs",
                        "Interval (ms)",
                        FieldType::Number {
                            min: Some(MIN_INTERVAL_MS as f64),
                            max: None,
                        },
                        true,
                        Some(Value::from(30_000)),
                    ),
                    field(
                        "method",
                        "Method",
                        FieldType::Select {
                            options: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]
                                .iter()
                                .map(|m| SelectOption {
                                    value: (*m).to_string(),
                                    label: (*m).to_string(),
                                })
                                .collect(),
                        },
                        true,
                        Some(Value::from("GET")),
                    ),
                    field(
                        "expectedStatus",
                        "Expected status",
                        FieldType::Number {
                            min: Some(100.0),
                            max: Some(599.0),
                        },
                        true,
                        Some(Value::from(200)),
                    ),
                    field(
                        "timeoutMs",
                        "Timeout (ms)",
                        FieldType::Number {
                            min: Some(1.0),
                            max: None,
                        },
                        true,
                        Some(Value::from(5_000)),
                    ),
                ],
            }],
        }
    }

    /// Spawn (or re-spawn) the poll loop for `config`, replacing any prior run.
    ///
    /// Resets the cancellation token and pause flag, sets status to
    /// [`ServiceStatus::Running`], and stores the config so [`resume`](Self::resume)
    /// and [`state`](Self::state) can see it.
    fn spawn_loop(&mut self, config: HttpMonitorConfig) {
        // A fresh token so a previous stop's cancellation does not immediately
        // kill the new loop.
        self.cancel = CancellationToken::new();
        self.paused.store(false, Ordering::SeqCst);
        self.status = ServiceStatus::Running;
        self.config = Some(config.clone());

        let cancel = self.cancel.clone();
        let paused = Arc::clone(&self.paused);
        let last_result = Arc::clone(&self.last_result);
        let events = self.events.clone();

        // Drive the async poll loop on a dedicated OS thread with its own
        // current-thread tokio runtime. `reqwest` needs a reactor, and a
        // host-owned runtime is not guaranteed: the desktop starts the monitor
        // from a synchronous Tauri command thread with no ambient runtime (a bare
        // `tokio::spawn` there panics — see #828/#982), while the agent starts it
        // from its async dispatcher. An owned runtime works from either, so the
        // service is fully host-agnostic (#2592). The runtime is dropped when the
        // loop returns on cancellation, so nothing lingers past a stop.
        std::thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!(
                        monitor_id = %config.id,
                        "HTTP monitor: failed to build poll runtime: {e}"
                    );
                    return;
                }
            };
            runtime.block_on(run_monitor(config, events, cancel, paused, last_result));
        });
    }

    /// Start the poll loop for `config` (synchronous).
    ///
    /// The trait's async [`start`](Service::start) parses a JSON config and
    /// delegates here; the desktop manager, running on a synchronous Tauri
    /// command thread with no reactor, calls this directly.
    pub fn start_with(&mut self, config: HttpMonitorConfig) {
        self.spawn_loop(config);
    }

    /// Stop the poll loop but keep the config so the monitor stays listed and
    /// can be resumed (synchronous counterpart of the trait's async
    /// [`stop`](Service::stop)).
    pub fn shutdown(&mut self) {
        self.cancel.cancel();
        self.paused.store(false, Ordering::SeqCst);
        self.status = ServiceStatus::Stopped;
    }

    /// Pause the poll loop's body while keeping the loop alive (Resume is
    /// instant). No-op when the monitor is not running.
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    /// Resume the monitor.
    ///
    /// - A **running** (or paused) monitor simply clears its pause flag.
    /// - A **stopped** monitor (loop cancelled but still listed) is re-spawned
    ///   with the same config/id.
    pub fn resume(&mut self) {
        if self.is_running() {
            self.paused.store(false, Ordering::SeqCst);
        } else if let Some(config) = self.config.clone() {
            self.spawn_loop(config);
        }
    }

    /// Whether the poll loop is currently alive.
    pub fn is_running(&self) -> bool {
        self.status == ServiceStatus::Running && !self.cancel.is_cancelled()
    }

    /// Whether the running loop is currently paused.
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// The most recent check result, if any.
    pub fn last_result(&self) -> Option<HttpCheckResult> {
        self.last_result.lock().ok().and_then(|g| g.clone())
    }

    /// Test-only: construct a service in the `Running` state with `config` but
    /// **without** spawning a real poll loop, so host-level bookkeeping tests
    /// (stop / remove / pause / list) need no Tokio runtime or network.
    ///
    /// `#[doc(hidden)] pub` (not `#[cfg(test)]`) so the desktop host's
    /// [`NetworkManager`] tests — in a different crate — can build one without a
    /// live monitor, mirroring how the type behaved when it lived in `src-tauri`.
    /// Not part of the supported API.
    #[doc(hidden)]
    pub fn test_running(config: HttpMonitorConfig) -> Self {
        let mut svc = Self::new();
        svc.config = Some(config);
        svc.status = ServiceStatus::Running;
        svc
    }

    /// Snapshot this monitor as an [`HttpMonitorState`] for listing.
    ///
    /// Returns `None` for a service that was never started (no config).
    pub fn state(&self) -> Option<HttpMonitorState> {
        let config = self.config.clone()?;
        let running = self.is_running();
        Some(HttpMonitorState {
            config,
            running,
            // A stopped loop can't be paused; only report paused while alive.
            paused: running && self.is_paused(),
            last_result: self.last_result(),
        })
    }
}

impl Default for HttpMonitorService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for HttpMonitorService {
    fn service_id(&self) -> &str {
        SERVICE_ID
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    fn settings_schema(&self) -> SettingsSchema {
        Self::schema()
    }

    fn capabilities(&self) -> ServiceCapabilities {
        ServiceCapabilities {
            configurable: true,
            emits_events: true,
            // A network probe is a natural fit for an agent run-location (probe
            // from a remote vantage point); it is not in the permanent
            // desktop-only set (credentials, spawn rendezvous, file watch,
            // OS-window management).
            desktop_only: false,
        }
    }

    async fn start(&mut self, config: Value) -> Result<(), ServiceError> {
        let config: HttpMonitorConfig = serde_json::from_value(config)
            .map_err(|e| ServiceError::InvalidConfig(e.to_string()))?;
        self.spawn_loop(config);
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ServiceError> {
        // Cancel the poll loop but keep the config so the monitor stays listed
        // (as `running: false`) and can be resumed. `paused` is cleared so a
        // later Resume starts clean.
        self.shutdown();
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), ServiceError> {
        // In-place pause: the poll loop stays alive, its body is suspended, so an
        // agent-hosted monitor pauses without a stop-and-relist (#2607). Delegate
        // to the inherent `pause`; the explicit path disambiguates it from this
        // trait method, which shares its name.
        HttpMonitorService::pause(self);
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), ServiceError> {
        // In-place resume: a paused (still-alive) loop simply clears its flag; a
        // stopped-but-listed loop is re-spawned with the same config. Delegates to
        // the inherent `resume` (explicit path disambiguates the shared name).
        HttpMonitorService::resume(self);
        Ok(())
    }

    fn status(&self) -> ServiceStatus {
        self.status.clone()
    }

    fn subscribe_events(&self) -> ServiceEventReceiver {
        self.events.subscribe()
    }
}

/// Build a required/optional settings field with sensible defaults for the
/// booleans we don't use here.
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

/// Outcome of building the HTTP client for a monitor.
///
/// Splitting this out makes the client-build failure path testable without
/// having to force `reqwest::Client::builder().build()` to fail: given a build
/// `Result`, [`build_client_outcome`] either yields the ready client or the
/// failure [`HttpCheckResult`] that must be emitted so the monitor is visibly
/// down instead of a stuck "checking…" zombie (see audit gap #4).
enum ClientBuildOutcome {
    /// Client built successfully — proceed to the poll loop.
    Ready(Client),
    /// Client build failed — emit this failure result, then stop the loop.
    Failed(HttpCheckResult),
}

/// Map a client-build `Result` to a [`ClientBuildOutcome`].
///
/// On failure this produces a failed [`HttpCheckResult`] (`ok == false`, `error`
/// set to the build error) tied to `config.id`, so the caller can emit it on the
/// normal check-event path and the UI shows the monitor as errored rather than
/// forever "checking…".
fn build_client_outcome(
    config: &HttpMonitorConfig,
    build_result: Result<Client, reqwest::Error>,
) -> ClientBuildOutcome {
    match build_result {
        Ok(client) => ClientBuildOutcome::Ready(client),
        Err(e) => {
            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            ClientBuildOutcome::Failed(HttpCheckResult {
                monitor_id: config.id.clone(),
                status_code: None,
                latency_ms: None,
                ok: false,
                error: Some(format!("failed to build HTTP client: {e}")),
                timestamp_ms,
            })
        }
    }
}

/// The background poll loop for one monitor.
///
/// Emits a [`CHECK_EVENT_KIND`] [`ServiceEvent`] (payload: [`HttpCheckResult`])
/// on `events` after every check — the host bridges that channel to its own
/// emitter — and caches the latest result in `last_result`.
async fn run_monitor(
    config: HttpMonitorConfig,
    events: EventChannel,
    cancel: CancellationToken,
    paused: Arc<AtomicBool>,
    last_result: Arc<Mutex<Option<HttpCheckResult>>>,
) {
    let build_result = Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build();
    let client = match build_client_outcome(&config, build_result) {
        ClientBuildOutcome::Ready(c) => c,
        ClientBuildOutcome::Failed(result) => {
            // Surface the failure on the normal check-event path so the monitor
            // shows as down/errored instead of a stuck "checking…" zombie, then
            // stop the loop (a rebuilt client would fail identically).
            tracing::error!(
                monitor_id = %config.id,
                "HTTP monitor: failed to build client — emitting failure result and stopping"
            );
            events.emit(ServiceEvent::new(CHECK_EVENT_KIND, &result));
            if let Ok(mut guard) = last_result.lock() {
                *guard = Some(result);
            }
            return;
        }
    };

    loop {
        if cancel.is_cancelled() {
            break;
        }

        // Pause suspends the poll body but keeps the loop alive so Resume is
        // instant. The interval sleep still runs so the loop stays responsive to
        // cancellation and re-checks the flag each tick.
        if paused.load(Ordering::SeqCst) {
            debug!(monitor_id = %config.id, "HTTP monitor paused — skipping check");
        } else {
            let result = check_once(&config, &client).await;
            debug!(
                monitor_id = %config.id,
                ok = result.ok,
                latency_ms = ?result.latency_ms,
                "HTTP monitor check complete"
            );

            events.emit(ServiceEvent::new(CHECK_EVENT_KIND, &result));

            if let Ok(mut guard) = last_result.lock() {
                *guard = Some(result);
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(config.interval_ms)) => {}
            _ = cancel.cancelled() => break,
        }
    }
}

async fn check_once(config: &HttpMonitorConfig, client: &Client) -> HttpCheckResult {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let method =
        reqwest::Method::from_bytes(config.method.as_bytes()).unwrap_or(reqwest::Method::GET);

    let started = Instant::now();
    match client.request(method, &config.url).send().await {
        Ok(response) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let status = response.status().as_u16();
            let ok = status == config.expected_status;
            HttpCheckResult {
                monitor_id: config.id.clone(),
                status_code: Some(status),
                latency_ms: Some(latency_ms),
                ok,
                error: None,
                timestamp_ms,
            }
        }
        Err(e) => HttpCheckResult {
            monitor_id: config.id.clone(),
            status_code: None,
            latency_ms: None,
            ok: false,
            error: Some(e.to_string()),
            timestamp_ms,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_config_has_valid_uuid() {
        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        assert!(!cfg.id.is_empty());
        assert_eq!(cfg.expected_status, 200);
        assert_eq!(cfg.interval_ms, 30_000);
    }

    #[test]
    fn zero_interval_clamps_to_floor() {
        // A `0` interval from the UI (e.g. `Number("")` → NaN → 0 in JS) must not
        // be honored verbatim, or the poll loop busy-loops requests.
        let cfg = HttpMonitorConfig::new("https://example.com".into(), 0, "GET".into(), 200, 5_000);
        assert_eq!(cfg.interval_ms, MIN_INTERVAL_MS);
    }

    #[test]
    fn tiny_interval_clamps_to_floor() {
        // Any value below the floor is raised to the floor.
        let cfg =
            HttpMonitorConfig::new("https://example.com".into(), 50, "GET".into(), 200, 5_000);
        assert_eq!(cfg.interval_ms, MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_at_floor_is_preserved() {
        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            MIN_INTERVAL_MS,
            "GET".into(),
            200,
            5_000,
        );
        assert_eq!(cfg.interval_ms, MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_above_floor_is_preserved() {
        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            5_000,
            "GET".into(),
            200,
            5_000,
        );
        assert_eq!(cfg.interval_ms, 5_000);
    }

    /// Obtain a genuine `reqwest::Error` offline so the build-failure branch can
    /// be exercised without forcing `Client::builder().build()` to actually fail
    /// (which is impractical). A blocking request to a malformed URL fails at the
    /// URL-parse stage — no network required — giving a real `reqwest::Error`
    /// that stands in for a build error in [`build_client_outcome`].
    fn a_reqwest_error() -> reqwest::Error {
        reqwest::blocking::Client::new()
            .get("http://[invalid-url")
            .send()
            .expect_err("malformed URL must yield a reqwest::Error")
    }

    #[test]
    fn client_build_failure_surfaces_as_failed_check_result() {
        // Gap #4 regression: a client-build failure must NOT silently early-return
        // (leaving a stuck "checking…" zombie). It must map to a failed
        // HttpCheckResult so the UI shows the monitor as errored.
        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            5_000,
            "GET".into(),
            200,
            5_000,
        );
        let err = a_reqwest_error();

        match build_client_outcome(&cfg, Err(err)) {
            ClientBuildOutcome::Failed(result) => {
                assert_eq!(result.monitor_id, cfg.id);
                assert!(!result.ok, "failed build must produce ok == false");
                assert!(
                    result.error.is_some(),
                    "failed build must carry an error message"
                );
                assert!(
                    result
                        .error
                        .as_deref()
                        .unwrap_or("")
                        .contains("failed to build HTTP client"),
                    "error should describe the client-build failure"
                );
                assert!(result.status_code.is_none());
                assert!(result.latency_ms.is_none());
            }
            ClientBuildOutcome::Ready(_) => {
                panic!("build error must map to a Failed outcome, not Ready")
            }
        }
    }

    #[test]
    fn client_build_success_yields_ready_outcome() {
        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            5_000,
            "GET".into(),
            200,
            5_000,
        );
        let ok_client = Client::builder().build().expect("default client builds");

        match build_client_outcome(&cfg, Ok(ok_client)) {
            ClientBuildOutcome::Ready(_) => {}
            ClientBuildOutcome::Failed(_) => {
                panic!("a successful build must map to Ready, not Failed")
            }
        }
    }

    // ── Service trait impl ────────────────────────────────────────────────────

    fn sample_config() -> HttpMonitorConfig {
        HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        )
    }

    #[test]
    fn service_metadata_and_capabilities() {
        let svc = HttpMonitorService::new();
        assert_eq!(svc.service_id(), SERVICE_ID);
        assert_eq!(svc.display_name(), DISPLAY_NAME);

        let caps = svc.capabilities();
        assert!(caps.configurable);
        assert!(caps.emits_events);
        // A network probe may run on an agent — it is not desktop-only.
        assert!(!caps.desktop_only);

        // The schema exposes the config fields (camelCase keys).
        let schema = svc.settings_schema();
        let keys: Vec<String> = schema
            .groups
            .iter()
            .flat_map(|g| g.fields.iter().map(|f| f.key.clone()))
            .collect();
        for expected in ["url", "intervalMs", "method", "expectedStatus", "timeoutMs"] {
            assert!(
                keys.contains(&expected.to_string()),
                "missing field {expected}"
            );
        }
    }

    #[test]
    fn register_http_monitor_populates_a_registry() {
        // The shared registry helper exposes the monitor with its run-location
        // metadata, so the desktop and the agent register an identical service.
        let mut registry = ServiceRegistry::new();
        register_http_monitor(&mut registry);
        let svc = registry
            .available_services()
            .into_iter()
            .find(|s| s.service_id == SERVICE_ID)
            .expect("http monitor must be registered");
        assert_eq!(svc.display_name, DISPLAY_NAME);
        assert!(svc.capabilities.emits_events);
        assert!(!svc.capabilities.desktop_only);
        // The factory yields a fresh, stopped service.
        let created = registry.create(SERVICE_ID).expect("create");
        assert_eq!(created.service_id(), SERVICE_ID);
        assert_eq!(created.status(), ServiceStatus::Stopped);
    }

    #[test]
    fn new_service_is_stopped_with_no_config() {
        let svc = HttpMonitorService::new();
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        assert!(!svc.is_running());
        // No config yet → nothing to list.
        assert!(svc.state().is_none());
    }

    #[tokio::test]
    async fn start_rejects_invalid_config() {
        let mut svc = HttpMonitorService::new();
        // Missing required fields → InvalidConfig, not a panic.
        let err = svc.start(serde_json::json!({ "url": "x" })).await;
        assert!(matches!(err, Err(ServiceError::InvalidConfig(_))));
        assert_eq!(svc.status(), ServiceStatus::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn start_runs_and_emits_check_events_through_event_channel() {
        // Point the monitor at a fast local sink so a real check completes
        // quickly; assert the result arrives on the core EventChannel (not a
        // Tauri emitter).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });

        let mut cfg = sample_config();
        cfg.url = format!("http://{addr}/");
        cfg.interval_ms = MIN_INTERVAL_MS;
        let cfg_id = cfg.id.clone();

        let mut svc = HttpMonitorService::new();
        let mut rx = svc.subscribe_events();
        svc.start(serde_json::to_value(&cfg).unwrap())
            .await
            .expect("start");
        assert_eq!(svc.status(), ServiceStatus::Running);
        assert!(svc.is_running());

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("a check event must arrive within 5s")
            .expect("event channel delivers");
        assert_eq!(event.kind, CHECK_EVENT_KIND);
        let result: HttpCheckResult = serde_json::from_value(event.payload).unwrap();
        assert_eq!(result.monitor_id, cfg_id);
        assert_eq!(result.status_code, Some(200));
        assert!(result.ok);

        svc.stop().await.expect("stop");
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        assert!(!svc.is_running());
    }

    #[tokio::test]
    async fn stop_keeps_config_for_listing_and_resume() {
        let mut svc = HttpMonitorService::new();
        let cfg = sample_config();
        let cfg_id = cfg.id.clone();
        // Use a non-routable address so no real request completes during the test.
        let mut cfg2 = cfg.clone();
        cfg2.url = "http://127.0.0.1:1/".into();
        svc.start(serde_json::to_value(&cfg2).unwrap())
            .await
            .expect("start");
        svc.stop().await.expect("stop");

        // Stopped keeps the monitor listed (config retained) as running:false.
        let state = svc.state().expect("state after stop");
        assert_eq!(state.config.id, cfg_id);
        assert!(!state.running);
        assert!(!state.paused);
    }

    #[tokio::test]
    async fn pause_and_resume_toggle_the_flag_in_place() {
        let mut svc = HttpMonitorService::new();
        let mut cfg = sample_config();
        cfg.url = "http://127.0.0.1:1/".into();
        svc.start(serde_json::to_value(&cfg).unwrap())
            .await
            .expect("start");

        assert!(!svc.is_paused());
        svc.pause();
        assert!(svc.is_paused());
        assert!(svc.is_running(), "pause keeps the loop alive");
        assert!(svc.state().unwrap().paused);

        svc.resume();
        assert!(!svc.is_paused());
        assert!(svc.is_running());
    }

    #[tokio::test]
    async fn service_trait_pause_resume_toggle_the_flag_in_place() {
        // The trait-level `Service::pause`/`resume` (used by the agent host over
        // `service.pause`/`service.resume`, #2607) delegate to the inherent
        // in-place pause: the loop stays alive, only the flag flips.
        let mut svc = HttpMonitorService::new();
        let mut cfg = sample_config();
        cfg.url = "http://127.0.0.1:1/".into();
        Service::start(&mut svc, serde_json::to_value(&cfg).unwrap())
            .await
            .expect("start");

        assert!(!svc.is_paused());
        Service::pause(&mut svc).await.expect("pause");
        assert!(svc.is_paused());
        assert!(svc.is_running(), "trait pause keeps the loop alive");

        Service::resume(&mut svc).await.expect("resume");
        assert!(!svc.is_paused());
        assert!(svc.is_running());
    }

    #[tokio::test]
    async fn resume_restarts_a_stopped_monitor_with_same_config() {
        let mut svc = HttpMonitorService::new();
        let mut cfg = sample_config();
        cfg.url = "http://127.0.0.1:1/".into();
        let cfg_id = cfg.id.clone();
        svc.start(serde_json::to_value(&cfg).unwrap())
            .await
            .expect("start");
        svc.stop().await.expect("stop");
        assert!(!svc.is_running());

        // Resuming a stopped monitor re-spawns the loop, reusing the same id.
        svc.resume();
        assert!(svc.is_running());
        assert_eq!(svc.status(), ServiceStatus::Running);
        assert_eq!(svc.state().unwrap().config.id, cfg_id);
    }
}
