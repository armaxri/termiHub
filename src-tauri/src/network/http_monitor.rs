//! Periodic HTTP monitor — checks a URL at a fixed interval and emits events.
//!
//! This is desktop-only (uses `reqwest`) and is not part of `termihub-core`.

use std::time::{Duration, Instant};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use tracing::debug;
use uuid::Uuid;

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

/// Current state of a running HTTP monitor (for listing).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpMonitorState {
    pub config: HttpMonitorConfig,
    pub running: bool,
    pub last_result: Option<HttpCheckResult>,
}

/// Handle to a running HTTP monitor background task.
pub struct HttpMonitorHandle {
    pub config: HttpMonitorConfig,
    pub cancel: CancellationToken,
    pub last_result: std::sync::Arc<std::sync::Mutex<Option<HttpCheckResult>>>,
}

impl HttpMonitorConfig {
    /// Create a new config with a generated ID.
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
            interval_ms,
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
    let last_result = std::sync::Arc::new(std::sync::Mutex::new(None::<HttpCheckResult>));

    let cancel_clone = cancel.clone();
    let config_clone = config.clone();
    let last_result_clone = std::sync::Arc::clone(&last_result);

    tokio::spawn(async move {
        run_monitor(config_clone, app, cancel_clone, last_result_clone).await;
    });

    HttpMonitorHandle {
        config,
        cancel,
        last_result,
    }
}

async fn run_monitor(
    config: HttpMonitorConfig,
    app: AppHandle,
    cancel: CancellationToken,
    last_result: std::sync::Arc<std::sync::Mutex<Option<HttpCheckResult>>>,
) {
    let client = match Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("HTTP monitor: failed to build client: {e}");
            return;
        }
    };

    loop {
        if cancel.is_cancelled() {
            break;
        }

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
}
