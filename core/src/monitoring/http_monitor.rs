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

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
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
    /// Opt-in escape hatch for monitoring an internal host (SEC-008).
    ///
    /// When `true`, the monitor is allowed to reach loopback (`127/8`, `::1`),
    /// RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), and IPv6
    /// unique-local (`fc00::/7`) addresses — e.g. a local dev server on
    /// `localhost` or an internal host. Link-local (including the cloud-metadata
    /// endpoint `169.254.169.254`) and the unspecified address stay blocked
    /// regardless, as no legitimate monitor targets them. Defaults to `false`
    /// (deny-internal) so the SSRF guard is safe by default; `#[serde(default)]`
    /// keeps configs stored before this field deserializing.
    #[serde(default)]
    pub allow_private_network: bool,
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
            allow_private_network: false,
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
                collapsed: false,
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
                    field(
                        "allowPrivateNetwork",
                        "Allow internal / private targets",
                        FieldType::Boolean,
                        false,
                        Some(Value::Bool(false)),
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

    /// Construct a service pre-loaded with `config` but **stopped** — no poll
    /// loop is spawned and no network work happens.
    ///
    /// Used to list a persisted monitor on launch without auto-starting it
    /// (PERF-008): the monitor appears as `running: false` and does zero network
    /// work until the user resumes it (which re-spawns the loop with the same
    /// config, via [`resume`](Self::resume)). The event channel is live, so a host
    /// can subscribe a bridge up front and events flow the moment it is resumed.
    pub fn stopped_with(config: HttpMonitorConfig) -> Self {
        let mut svc = Self::new();
        svc.config = Some(config);
        // status stays ServiceStatus::Stopped
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

// ── SSRF protection (SEC-008) ────────────────────────────────────────────────
//
// The monitor fetches a user/config-supplied URL and can run **agent-side**, so
// without guards it is an SSRF primitive: pointing it at `http://169.254.169.254/`
// leaks cloud IAM credentials, and internal-only services (admin panels, other
// agents, the agent's own loopback ports) become reachable. Defence is two-part
// so both name- and literal-addressed targets — and every redirect hop — are
// covered, and DNS-rebinding is closed by validating the exact address connected
// to:
//
//   1. [`SsrfResolver`] — a custom `reqwest` DNS resolver used for hostnames. It
//      resolves, drops every disallowed address, and connects only to the
//      survivors (or fails if none remain). reqwest connects to precisely the
//      addresses the resolver returns, so a hostname cannot rebind to an internal
//      IP between the check and the connection. It runs for the initial request
//      *and* every redirect hop.
//   2. [`blocked_literal_ip`] — reqwest never calls the resolver for URLs whose
//      host is an IP literal, so those are validated directly: the initial URL
//      before sending (see [`check_once`]) and each redirect target via the
//      client's redirect policy.

/// Whether `ip` is a target the monitor must refuse (SSRF guard).
///
/// Link-local (incl. the metadata endpoint `169.254.169.254`), the unspecified
/// address, and IPv4 broadcast are **always** blocked — no legitimate monitor
/// targets them. Loopback (`127/8`, `::1`), RFC 1918 private ranges, and IPv6
/// unique-local (`fc00::/7`) are blocked unless `allow_private` (the monitor's
/// opt-in `allowPrivateNetwork`, for the legitimate "monitor my local/internal
/// host" case) is set.
fn is_blocked_ip(ip: IpAddr, allow_private: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4, allow_private),
        // Classify an IPv4-mapped address (`::ffff:a.b.c.d`) by its IPv4 value so
        // `::ffff:169.254.169.254` cannot smuggle past the v4 rules.
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_blocked_ipv4(v4, allow_private),
            None => is_blocked_ipv6(v6, allow_private),
        },
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr, allow_private: bool) -> bool {
    // Always-blocked: 0.0.0.0, 169.254/16 (incl. metadata), broadcast.
    if ip.is_unspecified() || ip.is_link_local() || ip.is_broadcast() {
        return true;
    }
    // 127/8 loopback and 10/8, 172.16/12, 192.168/16 private — blocked unless the
    // operator opted in to internal targets.
    if (ip.is_loopback() || ip.is_private()) && !allow_private {
        return true;
    }
    false
}

fn is_blocked_ipv6(ip: Ipv6Addr, allow_private: bool) -> bool {
    // Always-blocked: :: and fe80::/10 link-local.
    if ip.is_unspecified() || is_ipv6_link_local(ip) {
        return true;
    }
    // ::1 loopback and fc00::/7 unique-local (the IPv6 analogue of RFC 1918) —
    // blocked unless the operator opted in to internal targets.
    if (ip.is_loopback() || is_ipv6_unique_local(ip)) && !allow_private {
        return true;
    }
    false
}

/// `fe80::/10` — IPv6 link-local unicast.
fn is_ipv6_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// `fc00::/7` — IPv6 unique-local addresses.
fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.octets()[0] & 0xfe) == 0xfc
}

/// If `url`'s host is an IP **literal** that the guard blocks, return the reason
/// string; otherwise `None`. Hostnames return `None` here — they are validated
/// by [`SsrfResolver`] at connection time.
fn blocked_literal_ip(url: &reqwest::Url, allow_private: bool) -> Option<String> {
    let host = url.host_str()?;
    // `host_str` yields IPv6 literals in bracketed form (`[::1]`); strip the
    // brackets before parsing. A host that does not parse as an IP is a domain
    // name and is handled by `SsrfResolver` at connection time, not here.
    let ip = parse_host_ip(host)?;
    if is_blocked_ip(ip, allow_private) {
        Some(format!(
            "blocked by SSRF protection: {ip} is not an allowed target"
        ))
    } else {
        None
    }
}

/// Parse a URL host string as an IP literal, accepting the bracketed IPv6 form
/// (`[::1]`). Returns `None` for domain names.
fn parse_host_ip(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .and_then(|h| h.parse::<IpAddr>().ok())
}

/// A `reqwest` DNS resolver that filters out SSRF-blocked addresses.
///
/// Applied to hostnames for the initial request and every redirect hop. reqwest
/// connects to exactly the addresses returned here, so validating them closes the
/// DNS-rebinding window (the checked address is the connected address).
#[derive(Debug, Clone)]
struct SsrfResolver {
    allow_private: bool,
}

impl Resolve for SsrfResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_private = self.allow_private;
        Box::pin(async move {
            let host = name.as_str().to_owned();
            // getaddrinfo on tokio's blocking pool; port 0 — reqwest overrides it
            // with the URL's port.
            let resolved = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let allowed: Vec<SocketAddr> = resolved
                .filter(|addr| !is_blocked_ip(addr.ip(), allow_private))
                .collect();
            if allowed.is_empty() {
                let err: Box<dyn std::error::Error + Send + Sync> = format!(
                    "blocked by SSRF protection: {host} resolves only to disallowed addresses"
                )
                .into();
                return Err(err);
            }
            let addrs: Addrs = Box::new(allowed.into_iter());
            Ok(addrs)
        })
    }
}

/// Build the monitor's HTTP client with SSRF defences wired in: the custom
/// [`SsrfResolver`] for hostnames and a redirect policy that re-validates every
/// literal-IP hop (and caps the chain at 10 redirects).
fn build_guarded_client(config: &HttpMonitorConfig) -> Result<Client, reqwest::Error> {
    let allow_private = config.allow_private_network;
    Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .dns_resolver(Arc::new(SsrfResolver { allow_private }))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("too many redirects");
            }
            match blocked_literal_ip(attempt.url(), allow_private) {
                Some(reason) => attempt.error(reason),
                None => attempt.follow(),
            }
        }))
        .build()
}

/// Build a failed [`HttpCheckResult`] carrying `error`, tagged with `config.id`.
fn failed_result(config: &HttpMonitorConfig, error: String, timestamp_ms: u64) -> HttpCheckResult {
    HttpCheckResult {
        monitor_id: config.id.clone(),
        status_code: None,
        latency_ms: None,
        ok: false,
        error: Some(error),
        timestamp_ms,
    }
}

/// Maximum failure-backoff multiplier (SM-015).
///
/// A consecutively-failing monitor backs off geometrically up to this many times
/// its base interval, so a dead host is probed at most once per
/// `BACKOFF_MAX_MULTIPLIER × interval` instead of being hammered every interval.
/// The delay resets to the base interval on the first success.
const BACKOFF_MAX_MULTIPLIER: u32 = 30;

/// Fixed-cadence scheduler with exponential failure backoff (SM-015).
///
/// Split out from the async loop so the cadence/backoff policy is unit-tested
/// without real timers or network. `interval` is the configured base period; the
/// delay before the next check is `interval` while healthy and grows
/// geometrically (2×, 4×, 8×, …) with each consecutive failure, capped at
/// `BACKOFF_MAX_MULTIPLIER × interval`, resetting to `interval` on the next
/// success.
#[derive(Debug)]
struct PollSchedule {
    interval: Duration,
    consecutive_failures: u32,
}

impl PollSchedule {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            consecutive_failures: 0,
        }
    }

    /// The base interval delay, ignoring failure state. Used for an idle tick
    /// (paused / no subscribers) so idling never trips or resets the backoff.
    fn base_delay(&self) -> Duration {
        self.interval
    }

    /// Record a completed check's outcome and return the delay before the next
    /// check: `interval` on success, or a capped exponential backoff while
    /// failures persist.
    fn record(&mut self, ok: bool) -> Duration {
        self.consecutive_failures = if ok {
            0
        } else {
            self.consecutive_failures.saturating_add(1)
        };
        self.interval.saturating_mul(self.backoff_multiplier())
    }

    /// Backoff multiplier: 1 while healthy, doubling per consecutive failure,
    /// capped at [`BACKOFF_MAX_MULTIPLIER`].
    fn backoff_multiplier(&self) -> u32 {
        if self.consecutive_failures == 0 {
            return 1;
        }
        let doubled = 1u32
            .checked_shl(self.consecutive_failures)
            .unwrap_or(u32::MAX);
        doubled.min(BACKOFF_MAX_MULTIPLIER)
    }
}

/// A single HTTP check, abstracted so the poll loop can be driven by a fake in
/// tests (no network, scripted results, deterministic virtual time) while
/// production uses the real `reqwest`-backed [`check_once`].
#[async_trait]
trait MonitorCheck: Send {
    async fn check(&self) -> HttpCheckResult;
}

/// Production [`MonitorCheck`]: issues the real SSRF-guarded HTTP request.
struct HttpChecker {
    config: HttpMonitorConfig,
    client: Client,
}

#[async_trait]
impl MonitorCheck for HttpChecker {
    async fn check(&self) -> HttpCheckResult {
        check_once(&self.config, &self.client).await
    }
}

/// The background poll loop for one monitor.
///
/// Builds the HTTP client, then drives [`poll_loop`]. Emitting the client-build
/// failure keeps a broken monitor visibly errored rather than a stuck "checking…"
/// zombie (audit gap #4).
async fn run_monitor(
    config: HttpMonitorConfig,
    events: EventChannel,
    cancel: CancellationToken,
    paused: Arc<AtomicBool>,
    last_result: Arc<Mutex<Option<HttpCheckResult>>>,
) {
    let build_result = build_guarded_client(&config);
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

    let interval = Duration::from_millis(config.interval_ms);
    let monitor_id = config.id.clone();
    let checker = HttpChecker { config, client };
    poll_loop(
        monitor_id,
        interval,
        checker,
        events,
        cancel,
        paused,
        last_result,
    )
    .await;
}

/// Whether the poll loop should perform an HTTP check this tick.
///
/// Skips when paused (Pause keeps the loop alive but idle) or when nothing is
/// subscribed to the monitor's events (PERF-008): with no listener the check is
/// pure waste — no result would reach anyone — so an unobserved monitor does no
/// network work until something subscribes. The loop still wakes each interval to
/// re-evaluate, so a monitor resumes checking as soon as a subscriber appears.
fn should_check(paused: bool, subscriber_count: usize) -> bool {
    !paused && subscriber_count > 0
}

/// The background poll loop, generic over the [`MonitorCheck`] seam so it is
/// testable with a fake checker under deterministic virtual time.
///
/// Emits a [`CHECK_EVENT_KIND`] [`ServiceEvent`] (payload: [`HttpCheckResult`])
/// on `events` after every performed check — the host bridges that channel to its
/// own emitter — and caches the latest result in `last_result`.
///
/// # Scheduling (SM-015)
///
/// The next tick's deadline is derived from the previous deadline plus the delay,
/// never from "now, after the check completes", so a slow check does not push the
/// whole schedule later — the poll period does not drift by the check duration.
/// On consecutive failures the delay backs off geometrically (see
/// [`PollSchedule`]) so a dead host is not hammered every interval.
async fn poll_loop<C: MonitorCheck>(
    monitor_id: String,
    interval: Duration,
    checker: C,
    events: EventChannel,
    cancel: CancellationToken,
    paused: Arc<AtomicBool>,
    last_result: Arc<Mutex<Option<HttpCheckResult>>>,
) {
    let mut schedule = PollSchedule::new(interval);
    // Start at "now" so the first check fires immediately, then advance by the
    // scheduled delay each tick (fixed cadence — see the fn doc).
    let mut deadline = tokio::time::Instant::now();

    loop {
        if cancel.is_cancelled() {
            break;
        }

        let is_paused = paused.load(Ordering::SeqCst);
        let delay = if !should_check(is_paused, events.subscriber_count()) {
            // Idle tick: paused, or nobody is subscribed to the results (PERF-008).
            // Either way the check would be pure waste — a result would reach no
            // one — so do no network work and re-check one base interval later,
            // without disturbing the failure backoff.
            debug!(
                monitor_id = %monitor_id,
                paused = is_paused,
                "HTTP monitor idle — skipping check (paused or no subscribers)"
            );
            schedule.base_delay()
        } else {
            let result = checker.check().await;
            debug!(
                monitor_id = %monitor_id,
                ok = result.ok,
                latency_ms = ?result.latency_ms,
                "HTTP monitor check complete"
            );
            let delay = schedule.record(result.ok);
            events.emit(ServiceEvent::new(CHECK_EVENT_KIND, &result));
            if let Ok(mut guard) = last_result.lock() {
                *guard = Some(result);
            }
            delay
        };

        // Advance the deadline by the chosen delay. If the check overran the
        // delay (deadline already in the past), resynchronize to now so a slow
        // host yields spacing rather than a catch-up burst (mirrors
        // tokio::time::MissedTickBehavior::Delay).
        deadline += delay;
        let now = tokio::time::Instant::now();
        if deadline <= now {
            deadline = now + delay;
        }

        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {}
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

    // SSRF pre-flight for an IP-literal target: reqwest never consults the custom
    // resolver for a literal host, so validate it here before any connection is
    // made. Hostnames are validated by `SsrfResolver` at connection time.
    if let Ok(url) = reqwest::Url::parse(&config.url) {
        if let Some(reason) = blocked_literal_ip(&url, config.allow_private_network) {
            debug!(monitor_id = %config.id, "HTTP monitor: {reason}");
            return failed_result(config, reason, timestamp_ms);
        }
    }

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

    // ── SSRF guard (SEC-008) ──────────────────────────────────────────────────

    #[test]
    fn always_blocks_metadata_link_local_and_unspecified() {
        // These are blocked regardless of the opt-in — no legitimate monitor
        // targets them, and 169.254.169.254 is the cloud-metadata crown jewel.
        for (addr, label) in [
            ("0.0.0.0", "ipv4 unspecified"),
            ("169.254.169.254", "cloud metadata endpoint"),
            ("169.254.1.1", "ipv4 link-local"),
            ("255.255.255.255", "ipv4 broadcast"),
            ("::", "ipv6 unspecified"),
            ("fe80::1", "ipv6 link-local"),
            ("::ffff:169.254.169.254", "ipv4-mapped metadata"),
        ] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(
                is_blocked_ip(ip, false),
                "{label} ({addr}) must be blocked (deny-internal)"
            );
            assert!(
                is_blocked_ip(ip, true),
                "{label} ({addr}) must stay blocked even with allow_private"
            );
        }
    }

    #[test]
    fn loopback_and_private_ranges_blocked_by_default_allowed_on_opt_in() {
        // Internal targets (loopback + private) are blocked by default but
        // reachable via the explicit `allowPrivateNetwork` opt-in.
        for addr in [
            "127.0.0.1",        // ipv4 loopback
            "127.5.6.7",        // ipv4 loopback range
            "10.0.0.1",         // RFC 1918
            "172.16.0.1",       // RFC 1918
            "172.31.255.255",   // RFC 1918
            "192.168.1.1",      // RFC 1918
            "::1",              // ipv6 loopback
            "::ffff:127.0.0.1", // ipv4-mapped loopback
            "fc00::1",          // ipv6 unique-local
            "fd12:3456::1",     // ipv6 unique-local
        ] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(
                is_blocked_ip(ip, false),
                "{addr} must be blocked when internal access is denied"
            );
            assert!(
                !is_blocked_ip(ip, true),
                "{addr} must be allowed when allow_private is opted in"
            );
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for addr in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",        // example.com
            "172.15.0.1",           // just outside 172.16/12
            "172.32.0.1",           // just outside 172.16/12
            "2606:4700:4700::1111", // public IPv6
        ] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(
                !is_blocked_ip(ip, false),
                "{addr} is public and must be allowed"
            );
        }
    }

    #[test]
    fn blocked_literal_ip_flags_ipv4_and_ipv6_literals() {
        let blocked = reqwest::Url::parse("http://169.254.169.254/latest/meta-data/").unwrap();
        assert!(blocked_literal_ip(&blocked, false).is_some());

        let v6 = reqwest::Url::parse("http://[::1]:8080/").unwrap();
        assert!(blocked_literal_ip(&v6, false).is_some());

        // A domain host is not judged here (the resolver handles it).
        let domain = reqwest::Url::parse("http://example.com/").unwrap();
        assert!(blocked_literal_ip(&domain, false).is_none());

        // A public literal is allowed.
        let public = reqwest::Url::parse("http://8.8.8.8/").unwrap();
        assert!(blocked_literal_ip(&public, false).is_none());

        // Private literal: blocked by default, allowed on opt-in.
        let private = reqwest::Url::parse("http://192.168.1.10/").unwrap();
        assert!(blocked_literal_ip(&private, false).is_some());
        assert!(blocked_literal_ip(&private, true).is_none());
    }

    #[tokio::test]
    async fn check_once_rejects_metadata_endpoint_without_network() {
        // A monitor pointed at the metadata endpoint must fail fast with an SSRF
        // error and never attempt the request.
        let mut cfg = sample_config();
        cfg.url = "http://169.254.169.254/latest/meta-data/".into();
        let client = build_guarded_client(&cfg).expect("client builds");
        let result = check_once(&cfg, &client).await;
        assert!(!result.ok);
        assert!(result.status_code.is_none());
        let err = result.error.unwrap_or_default();
        assert!(
            err.contains("SSRF protection"),
            "error should name the SSRF guard, got: {err}"
        );
    }

    #[test]
    fn allow_private_network_defaults_to_false_when_absent() {
        // Configs stored before the field existed must deserialize to deny-internal.
        let json = serde_json::json!({
            "id": "m1",
            "url": "https://example.com",
            "intervalMs": 30000,
            "method": "GET",
            "expectedStatus": 200,
            "timeoutMs": 5000
        });
        let cfg: HttpMonitorConfig = serde_json::from_value(json).unwrap();
        assert!(!cfg.allow_private_network);
    }

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

    // ── Poll scheduling: fixed cadence + failure backoff (SM-015) ─────────────

    #[test]
    fn poll_schedule_healthy_delay_is_the_interval() {
        let mut sched = PollSchedule::new(Duration::from_secs(5));
        assert_eq!(sched.record(true), Duration::from_secs(5));
        // A run of successes keeps the delay pinned at the interval.
        assert_eq!(sched.record(true), Duration::from_secs(5));
        assert_eq!(sched.base_delay(), Duration::from_secs(5));
    }

    #[test]
    fn poll_schedule_backs_off_geometrically_on_consecutive_failures() {
        let mut sched = PollSchedule::new(Duration::from_secs(5));
        // Each consecutive failure doubles the delay: 2×, 4×, 8×, 16× …
        assert_eq!(sched.record(false), Duration::from_secs(10));
        assert_eq!(sched.record(false), Duration::from_secs(20));
        assert_eq!(sched.record(false), Duration::from_secs(40));
        assert_eq!(sched.record(false), Duration::from_secs(80));
    }

    #[test]
    fn poll_schedule_backoff_is_capped() {
        let mut sched = PollSchedule::new(Duration::from_secs(1));
        // Drive many failures; the multiplier saturates at BACKOFF_MAX_MULTIPLIER
        // rather than growing without bound (or overflowing the shift).
        let mut last = Duration::ZERO;
        for _ in 0..64 {
            last = sched.record(false);
        }
        assert_eq!(
            last,
            Duration::from_secs(1) * BACKOFF_MAX_MULTIPLIER,
            "backoff must cap at BACKOFF_MAX_MULTIPLIER × interval"
        );
    }

    #[test]
    fn poll_schedule_resets_to_interval_on_success() {
        let mut sched = PollSchedule::new(Duration::from_secs(5));
        sched.record(false);
        sched.record(false);
        assert_eq!(sched.record(false), Duration::from_secs(40));
        // A single success clears the backoff immediately.
        assert_eq!(sched.record(true), Duration::from_secs(5));
    }

    /// A fake [`MonitorCheck`] for driving [`poll_loop`] under deterministic
    /// virtual time: records the (virtual) start instant of each check, returns a
    /// scripted ok/fail outcome, optionally simulates request latency, and cancels
    /// the loop once `stop_after` checks have run so the test terminates.
    struct RecordingChecker {
        outcomes: Vec<bool>,
        latency: Duration,
        stop_after: usize,
        cancel: CancellationToken,
        calls: Arc<Mutex<Vec<tokio::time::Instant>>>,
    }

    #[async_trait]
    impl MonitorCheck for RecordingChecker {
        async fn check(&self) -> HttpCheckResult {
            let n = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(tokio::time::Instant::now());
                calls.len()
            };
            if self.latency > Duration::ZERO {
                tokio::time::sleep(self.latency).await;
            }
            let ok = self.outcomes.get(n - 1).copied().unwrap_or(true);
            if n >= self.stop_after {
                self.cancel.cancel();
            }
            HttpCheckResult {
                monitor_id: "m".into(),
                status_code: Some(if ok { 200 } else { 500 }),
                latency_ms: Some(0),
                ok,
                error: None,
                timestamp_ms: 0,
            }
        }
    }

    /// Drive `poll_loop` with the given checker under virtual time and return the
    /// recorded per-check start instants and their consecutive gaps.
    async fn run_recorded_loop(
        interval: Duration,
        outcomes: Vec<bool>,
        latency: Duration,
        stop_after: usize,
    ) -> Vec<Duration> {
        let cancel = CancellationToken::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let checker = RecordingChecker {
            outcomes,
            latency,
            stop_after,
            cancel: cancel.clone(),
            calls: Arc::clone(&calls),
        };
        let events = EventChannel::new();
        // Keep a live subscriber so the subscriber-gate (PERF-008) lets checks run.
        let _rx = events.subscribe();
        poll_loop(
            "m".into(),
            interval,
            checker,
            events,
            cancel,
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
        )
        .await;

        let instants = calls.lock().unwrap().clone();
        instants
            .windows(2)
            .map(|w| w[1].duration_since(w[0]))
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn poll_loop_holds_fixed_cadence_despite_check_latency() {
        // With a 1s interval and a 300ms-latency check, successive checks must
        // start ~1s apart (fixed cadence), NOT 1.3s apart — the period must not
        // drift by the request duration (SM-015).
        let interval = Duration::from_secs(1);
        let gaps = run_recorded_loop(interval, vec![true; 4], Duration::from_millis(300), 4).await;
        assert_eq!(gaps.len(), 3);
        for gap in gaps {
            assert_eq!(gap, interval, "poll period must not drift by check latency");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn poll_loop_backs_off_while_the_host_keeps_failing() {
        // A perpetually-failing host is probed at a growing interval, not hammered
        // every interval (SM-015). Gaps after each failure: 2×, 4×, 8×.
        let interval = Duration::from_secs(1);
        let gaps = run_recorded_loop(interval, vec![false; 4], Duration::ZERO, 4).await;
        assert_eq!(
            gaps,
            vec![
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn poll_loop_resets_cadence_after_recovery() {
        // Fail twice (backing off), then recover: the delay after the success
        // snaps back to the base interval (SM-015).
        let interval = Duration::from_secs(1);
        // checks: fail, fail, ok, ok → gaps reflect the delay chosen AFTER each
        // check: 2× (fail1), 4× (fail2), 1× (success resets), then stop.
        let gaps =
            run_recorded_loop(interval, vec![false, false, true, true], Duration::ZERO, 4).await;
        assert_eq!(
            gaps,
            vec![
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(1),
            ]
        );
    }

    // ── Subscriber gating: no work without a listener (PERF-008) ──────────────

    #[test]
    fn should_check_requires_running_and_a_subscriber() {
        // A check runs only while not paused AND at least one subscriber listens.
        assert!(should_check(false, 1), "running + subscriber → check");
        assert!(should_check(false, 3), "multiple subscribers still checks");
        assert!(!should_check(false, 0), "no subscriber → skip (PERF-008)");
        assert!(
            !should_check(true, 1),
            "paused → skip even with a subscriber"
        );
        assert!(!should_check(true, 0), "paused and unsubscribed → skip");
    }

    /// Build a `RecordingChecker` that never self-cancels, so the loop's own
    /// idle/gating behavior (not the checker) decides when checks happen. The
    /// caller drives cancellation externally.
    fn non_stopping_checker(
        cancel: CancellationToken,
        calls: Arc<Mutex<Vec<tokio::time::Instant>>>,
    ) -> RecordingChecker {
        RecordingChecker {
            outcomes: vec![true; 64],
            latency: Duration::ZERO,
            stop_after: usize::MAX,
            cancel,
            calls,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn poll_loop_does_no_checks_without_a_subscriber() {
        // A launched-but-unobserved monitor must fire zero HTTP checks (PERF-008):
        // with no subscriber the loop only idles.
        let interval = Duration::from_secs(1);
        let cancel = CancellationToken::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let events = EventChannel::new(); // no subscriber
        let handle = tokio::spawn(poll_loop(
            "m".into(),
            interval,
            non_stopping_checker(cancel.clone(), Arc::clone(&calls)),
            events,
            cancel.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
        ));

        // Let several intervals elapse in virtual time, then stop the loop.
        tokio::time::sleep(interval * 5).await;
        cancel.cancel();
        handle.await.unwrap();

        assert!(
            calls.lock().unwrap().is_empty(),
            "no HTTP check may fire while nothing is subscribed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn poll_loop_resumes_checks_once_a_subscriber_appears() {
        // While unsubscribed the loop idles; the moment a subscriber appears it
        // resumes checking (PERF-008).
        let interval = Duration::from_secs(1);
        let cancel = CancellationToken::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let events = EventChannel::new();
        let subscribe_handle = events.clone();
        let handle = tokio::spawn(poll_loop(
            "m".into(),
            interval,
            non_stopping_checker(cancel.clone(), Arc::clone(&calls)),
            events,
            cancel.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(None)),
        ));

        // No subscriber for a few intervals → still zero checks.
        tokio::time::sleep(interval * 3).await;
        assert!(
            calls.lock().unwrap().is_empty(),
            "must stay idle until subscribed"
        );

        // A subscriber appears; checks resume on the next tick(s).
        let _rx = subscribe_handle.subscribe();
        tokio::time::sleep(interval * 3).await;
        cancel.cancel();
        handle.await.unwrap();

        assert!(
            !calls.lock().unwrap().is_empty(),
            "checks must resume once a subscriber is present"
        );
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

    #[test]
    fn stopped_with_lists_as_not_running_and_does_no_work() {
        // PERF-008: a persisted monitor loaded on launch is listed but stopped —
        // no poll loop, no network work — until the user resumes it.
        let cfg = sample_config();
        let id = cfg.id.clone();
        let svc = HttpMonitorService::stopped_with(cfg);
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        assert!(!svc.is_running());
        let state = svc.state().expect("a config-loaded monitor is listed");
        assert_eq!(state.config.id, id);
        assert!(!state.running, "loaded monitor must not be running");
        assert!(!state.paused);
    }

    #[test]
    fn stopped_with_can_be_resumed_into_a_running_loop() {
        // The user opting the monitor in re-spawns the loop with the same config
        // (PERF-008: work is on-demand, not on launch).
        let mut svc = HttpMonitorService::stopped_with(sample_config());
        assert!(!svc.is_running());
        svc.resume();
        assert!(svc.is_running());
        assert_eq!(svc.status(), ServiceStatus::Running);
        svc.shutdown();
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
        // The test sink binds on loopback; opt in so the SSRF guard allows it.
        cfg.allow_private_network = true;
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
