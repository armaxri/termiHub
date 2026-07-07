//! Periodic HTTP monitor — checks a URL at a fixed interval and emits events.
//!
//! This is desktop-only (uses `reqwest`) and is not part of `termihub-core`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use tracing::debug;
use uuid::Uuid;

/// Minimum poll interval, in milliseconds.
///
/// The frontend's `min={5}` on the interval field is only a soft HTML hint —
/// an empty field yields `Number("")` → `NaN` → `0`, which would otherwise be
/// forwarded verbatim and turn the poll loop into a tight busy-loop of
/// requests. Clamping to this floor server-side guarantees a sane cadence
/// regardless of what the UI (or any future caller) sends.
pub const MIN_INTERVAL_MS: u64 = 1_000;

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

/// Handle to a running HTTP monitor background task.
pub struct HttpMonitorHandle {
    pub config: HttpMonitorConfig,
    pub cancel: CancellationToken,
    /// When set, the poll loop stays alive but skips the HTTP check (Pause).
    pub paused: Arc<AtomicBool>,
    pub last_result: std::sync::Arc<std::sync::Mutex<Option<HttpCheckResult>>>,
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

/// Spawn a background task that periodically polls a URL.
///
/// Emits `network-http-monitor-check` events on the app handle.
/// Returns a [`HttpMonitorHandle`] that can be used to stop the task.
pub fn start_monitor(config: HttpMonitorConfig, app: AppHandle) -> HttpMonitorHandle {
    let cancel = CancellationToken::new();
    let paused = Arc::new(AtomicBool::new(false));
    let last_result = std::sync::Arc::new(std::sync::Mutex::new(None::<HttpCheckResult>));

    let cancel_clone = cancel.clone();
    let paused_clone = Arc::clone(&paused);
    let config_clone = config.clone();
    let last_result_clone = std::sync::Arc::clone(&last_result);

    // Spawn on Tauri's managed runtime, not `tokio::spawn`: the
    // `network_http_monitor_start` command is synchronous, so it runs on a thread
    // with no Tokio reactor — `tokio::spawn` there panics ("no reactor running").
    // `tauri::async_runtime::spawn` works from any thread (see #828, #982).
    tauri::async_runtime::spawn(async move {
        run_monitor(
            config_clone,
            app,
            cancel_clone,
            paused_clone,
            last_result_clone,
        )
        .await;
    });

    HttpMonitorHandle {
        config,
        cancel,
        paused,
        last_result,
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

async fn run_monitor(
    config: HttpMonitorConfig,
    app: AppHandle,
    cancel: CancellationToken,
    paused: Arc<AtomicBool>,
    last_result: std::sync::Arc<std::sync::Mutex<Option<HttpCheckResult>>>,
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
            let _ = app.emit("network-http-monitor-check", &result);
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

            let _ = app.emit("network-http-monitor-check", &result);

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
}
