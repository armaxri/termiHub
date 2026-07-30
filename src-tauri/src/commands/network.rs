//! Tauri commands for built-in network diagnostic tools.
//!
//! Long-running operations (port scan, ping, traceroute) are launched as
//! background tasks and stream results back via Tauri events. One-shot
//! operations (DNS, WoL, open ports) return immediately.

use tauri::{AppHandle, Emitter, State};

use termihub_core::network::{
    dns, open_ports, ping, ping_sweep, port_scan, traceroute, wol, DnsRecordType, PingSweepResult,
    PortScanResult, WolDevice,
};
use termihub_core::service::ServiceInfo;

use crate::network::http_monitor::{HttpMonitorConfig, HttpMonitorState};
use crate::network::NetworkManager;
use crate::utils::errors::TerminalError;

// ── Port Scanner ─────────────────────────────────────────────────────────────

/// Start a TCP port scan. Returns a task ID; results are emitted as events.
///
/// `host` accepts a single host, an IPv4 or IPv6 address, a CIDR range (e.g.
/// `192.168.0.0/24`), or a comma-separated mix of those.
///
/// Events emitted:
/// - `network-scan-result` per port: `{ taskId, host, port, state, latencyMs? }`
/// - `network-scan-complete`: `{ taskId, summary }`
#[tauri::command]
pub async fn network_port_scan(
    host: String,
    ports: String,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    manager: State<'_, NetworkManager>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let port_list = port_scan::parse_port_spec(&ports)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    let targets = port_scan::parse_target_spec(&host)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager_ref = manager.inner() as *const NetworkManager as usize;

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        let on_result = {
            let app = app.clone();
            let tid = tid.clone();
            move |result: PortScanResult| {
                let _ = app.emit(
                    "network-scan-result",
                    serde_json::json!({
                        "taskId": tid,
                        "host": result.host,
                        "port": result.port,
                        "state": result.state,
                        "latencyMs": result.latency_ms,
                    }),
                );
            }
        };

        let summary = port_scan::scan_targets(
            &targets,
            &port_list,
            timeout_ms.unwrap_or(2000),
            concurrency.unwrap_or(100),
            on_result,
            cancel,
        )
        .await;

        match summary {
            Ok(s) => {
                let _ = app.emit(
                    "network-scan-complete",
                    serde_json::json!({ "taskId": &tid, "summary": s }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "network-scan-error",
                    serde_json::json!({ "taskId": &tid, "error": e.to_string() }),
                );
            }
        }

        // Clean up the task entry.
        // SAFETY: manager is Tauri managed state which outlives all tasks.
        let mgr = unsafe { &*(manager_ref as *const NetworkManager) };
        mgr.complete_task(&tid);
    });

    Ok(task_id)
}

/// Cancel a running port scan.
#[tauri::command]
pub fn network_port_scan_cancel(
    task_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

/// One-shot TCP reachability probe used by the session-restore dialog to flag
/// unreachable targets (issue #1931).
///
/// Attempts a single TCP connect to `host:port` and returns `true` only when the
/// connection is accepted within `timeout_ms` (default 1500 ms). A refused,
/// filtered, unresolved, or timed-out target returns `false` — for the dialog's
/// purposes those all mean "won't connect right now".
#[tauri::command]
pub async fn probe_target_reachable(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<bool, TerminalError> {
    let summary = port_scan::scan_ports(
        &host,
        &[port],
        timeout_ms.unwrap_or(1500),
        1,
        |_| {},
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    Ok(summary.open > 0)
}

// ── Ping ─────────────────────────────────────────────────────────────────────

/// Start a ping session. Returns a task ID; results are emitted as events.
///
/// Events emitted:
/// - `network-ping-result` per echo: `{ taskId, result }`
/// - `network-ping-complete`: `{ taskId, stats, canceled }`
#[tauri::command]
pub async fn network_ping_start(
    host: String,
    interval_ms: Option<u64>,
    count: Option<u32>,
    manager: State<'_, NetworkManager>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager_ref = manager.inner() as *const NetworkManager as usize;
    let cancel_clone = cancel.clone();

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        let on_result = {
            let app = app.clone();
            let tid = tid.clone();
            move |result| {
                let _ = app.emit(
                    "network-ping-result",
                    serde_json::json!({ "taskId": &tid, "result": result }),
                );
            }
        };

        let result =
            ping::ping_stream(&host, interval_ms.unwrap_or(1000), count, on_result, cancel).await;
        // Check cancellation *after* the stream ends so Stop is reported as
        // canceled rather than completed (the token is set while it runs).
        let canceled = cancel_clone.is_cancelled();

        match result {
            Ok(stats) => {
                let _ = app.emit(
                    "network-ping-complete",
                    serde_json::json!({ "taskId": &tid, "stats": stats, "canceled": canceled }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "network-ping-error",
                    serde_json::json!({ "taskId": &tid, "error": e.to_string() }),
                );
            }
        }

        let mgr = unsafe { &*(manager_ref as *const NetworkManager) };
        mgr.complete_task(&tid);
    });

    Ok(task_id)
}

/// Stop a running ping session.
#[tauri::command]
pub fn network_ping_stop(
    task_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

// ── Ping Sweep ─────────────────────────────────────────────────────────────────

/// Start a subnet / IP-range ping sweep. Returns a task ID; results stream as
/// events.
///
/// `host` accepts a single host, an IPv4 or IPv6 address, a CIDR range (e.g.
/// `192.168.1.0/24`), or a comma-separated mix of those — expanded via
/// [`port_scan::parse_target_spec`].
///
/// Events emitted:
/// - `network-sweep-result` per responding host: `{ taskId, host, latencyMs?, hostname? }`
/// - `network-sweep-complete`: `{ taskId, summary, canceled }`
/// - `network-sweep-error`: `{ taskId, error }`
#[tauri::command]
pub async fn network_ping_sweep(
    host: String,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    resolve_hostnames: Option<bool>,
    manager: State<'_, NetworkManager>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let targets = port_scan::parse_target_spec(&host)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager_ref = manager.inner() as *const NetworkManager as usize;
    let cancel_clone = cancel.clone();

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        let on_result = {
            let app = app.clone();
            let tid = tid.clone();
            move |result: PingSweepResult| {
                let _ = app.emit(
                    "network-sweep-result",
                    serde_json::json!({
                        "taskId": tid,
                        "host": result.host,
                        "latencyMs": result.latency_ms,
                        "hostname": result.hostname,
                    }),
                );
            }
        };

        let summary = ping_sweep::ping_sweep(
            &targets,
            timeout_ms.unwrap_or(1000),
            concurrency.unwrap_or(64),
            resolve_hostnames.unwrap_or(true),
            on_result,
            cancel,
        )
        .await;

        // The token is set while the sweep runs; check *after* it ends so Stop
        // is reported as canceled rather than completed.
        let canceled = cancel_clone.is_cancelled();

        match summary {
            Ok(s) => {
                let _ = app.emit(
                    "network-sweep-complete",
                    serde_json::json!({ "taskId": &tid, "summary": s, "canceled": canceled }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "network-sweep-error",
                    serde_json::json!({ "taskId": &tid, "error": e.to_string() }),
                );
            }
        }

        // SAFETY: manager is Tauri managed state which outlives all tasks.
        let mgr = unsafe { &*(manager_ref as *const NetworkManager) };
        mgr.complete_task(&tid);
    });

    Ok(task_id)
}

/// Cancel a running ping sweep.
#[tauri::command]
pub fn network_ping_sweep_cancel(
    task_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_reports_open_listener_reachable() {
        // A bound (even non-accepting) listener completes the TCP handshake.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().unwrap().port();

        let reachable = probe_target_reachable("127.0.0.1".to_string(), port, Some(1000))
            .await
            .expect("probe should not error");

        assert!(reachable, "an open TCP listener should be reachable");
    }

    #[tokio::test]
    async fn probe_reports_closed_port_unreachable() {
        // Claiming a "closed" port by binding on port 0 and dropping the listener is
        // racy: under the full parallel suite the just-freed ephemeral port can be
        // reassigned to another concurrent test's live listener before the probe
        // fires, so the probe correctly reports it *open* and the assertion fails
        // (#2008). Retry with a fresh port whenever a probe comes back reachable —
        // that only happens when the port lost the reuse race, so retrying keeps the
        // assertion meaningful (a genuinely closed port must read unreachable) while
        // removing the timing dependence. Losing the race on every one of many
        // independent ports is astronomically unlikely.
        const ATTEMPTS: usize = 20;
        for attempt in 1..=ATTEMPTS {
            let port = {
                let listener =
                    std::net::TcpListener::bind("127.0.0.1:0").expect("bind test listener");
                listener.local_addr().unwrap().port()
            };

            let reachable = probe_target_reachable("127.0.0.1".to_string(), port, Some(500))
                .await
                .expect("probe should not error");

            if !reachable {
                return; // A closed port was reported unreachable, as expected.
            }

            assert!(
                attempt < ATTEMPTS,
                "closed port {port} still reported reachable after {ATTEMPTS} attempts \
                 (all lost the ephemeral-port-reuse race)",
            );
        }
    }
}

/// Perform a DNS lookup and return the records immediately.
#[tauri::command]
pub async fn network_dns_lookup(
    hostname: String,
    record_type: String,
    server: Option<String>,
) -> Result<serde_json::Value, TerminalError> {
    let rtype = parse_record_type(&record_type)?;
    let result = dns::dns_lookup(&hostname, rtype, server.as_deref())
        .await
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    serde_json::to_value(result).map_err(|e| TerminalError::NetworkError(e.to_string()))
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/// List local listening ports.
#[tauri::command]
pub fn network_open_ports() -> Result<serde_json::Value, TerminalError> {
    let ports =
        open_ports::list_open_ports().map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    serde_json::to_value(ports).map_err(|e| TerminalError::NetworkError(e.to_string()))
}

// ── Traceroute ───────────────────────────────────────────────────────────────

/// Start a traceroute. Returns a task ID; hops are emitted as events.
///
/// Events emitted:
/// - `network-traceroute-hop`: `{ taskId, hop }`
/// - `network-traceroute-complete`: `{ taskId }`
#[tauri::command]
pub async fn network_traceroute(
    host: String,
    max_hops: Option<u8>,
    manager: State<'_, NetworkManager>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager_ref = manager.inner() as *const NetworkManager as usize;

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        let on_hop = {
            let app = app.clone();
            let tid = tid.clone();
            move |hop| {
                let _ = app.emit(
                    "network-traceroute-hop",
                    serde_json::json!({ "taskId": &tid, "hop": hop }),
                );
            }
        };

        let result = traceroute::traceroute(&host, max_hops.unwrap_or(30), on_hop, cancel).await;

        match result {
            Ok(()) => {
                let _ = app.emit(
                    "network-traceroute-complete",
                    serde_json::json!({ "taskId": &tid }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "network-traceroute-error",
                    serde_json::json!({ "taskId": &tid, "error": e.to_string() }),
                );
            }
        }

        let mgr = unsafe { &*(manager_ref as *const NetworkManager) };
        mgr.complete_task(&tid);
    });

    Ok(task_id)
}

/// Cancel a running traceroute.
#[tauri::command]
pub fn network_traceroute_cancel(
    task_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

/// Send a Wake-on-LAN magic packet.
#[tauri::command]
pub fn network_wol_send(mac: String, broadcast: String, port: u16) -> Result<(), TerminalError> {
    wol::send_magic_packet(&mac, &broadcast, port)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))
}

/// List saved WoL devices.
#[tauri::command]
pub fn network_wol_devices_list(
    manager: State<'_, NetworkManager>,
) -> Result<Vec<WolDevice>, TerminalError> {
    Ok(manager.list_wol_devices())
}

/// Save (add or update) a WoL device.
#[tauri::command]
pub fn network_wol_device_save(
    device: WolDevice,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.save_wol_device(device)
}

/// Delete a saved WoL device.
#[tauri::command]
pub fn network_wol_device_delete(
    device_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.delete_wol_device(&device_id)
}

// ── HTTP Monitor ─────────────────────────────────────────────────────────────

/// Start a new HTTP monitor. Returns the monitor ID.
#[tauri::command]
pub fn network_http_monitor_start(
    url: String,
    interval_ms: Option<u64>,
    method: Option<String>,
    expected_status: Option<u16>,
    timeout_ms: Option<u64>,
    manager: State<'_, NetworkManager>,
) -> Result<String, TerminalError> {
    let config = HttpMonitorConfig::new(
        url,
        interval_ms.unwrap_or(30_000),
        method.unwrap_or_else(|| "GET".into()),
        expected_status.unwrap_or(200),
        timeout_ms.unwrap_or(5_000),
    );
    manager.start_http_monitor(config)
}

/// Stop a running HTTP monitor, keeping it listed (as not running) so it can be
/// resumed. Use [`network_http_monitor_remove`] to delete it.
#[tauri::command]
pub fn network_http_monitor_stop(
    monitor_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.stop_http_monitor(&monitor_id)
}

/// Remove an HTTP monitor entirely (cancel + drop handle + delete persisted
/// config).
#[tauri::command]
pub fn network_http_monitor_remove(
    monitor_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.remove_http_monitor(&monitor_id)
}

/// Pause a running HTTP monitor (suspend polling, keep the loop alive).
#[tauri::command]
pub fn network_http_monitor_pause(
    monitor_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.pause_http_monitor(&monitor_id)
}

/// Resume a paused or stopped HTTP monitor with the same config.
#[tauri::command]
pub fn network_http_monitor_resume(
    monitor_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.resume_http_monitor(&monitor_id)
}

/// Stop every running HTTP monitor at once.
///
/// Backs the "Kill All" action of the Open Connections panel's HTTP Monitors
/// group (#1147). Reuses the same teardown as app shutdown.
#[tauri::command]
pub fn network_http_monitor_stop_all(
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.stop_all_http_monitors();
    Ok(())
}

/// List all HTTP monitors and their current state.
#[tauri::command]
pub fn network_http_monitor_list(
    manager: State<'_, NetworkManager>,
) -> Result<Vec<HttpMonitorState>, TerminalError> {
    Ok(manager.list_http_monitors())
}

/// List the run-location-routable services registered on the desktop.
///
/// Backs discovery for the future run-location selector (S-track, #2139). The
/// HTTP monitor is the S2 pilot (#2157) — the first existing service lifted onto
/// the core `Service` trait — so it appears here with its schema and
/// capabilities.
#[tauri::command]
pub fn network_services_list(manager: State<'_, NetworkManager>) -> Vec<ServiceInfo> {
    manager.available_services()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn parse_record_type(s: &str) -> Result<DnsRecordType, TerminalError> {
    match s.to_uppercase().as_str() {
        "A" => Ok(DnsRecordType::A),
        "AAAA" => Ok(DnsRecordType::Aaaa),
        "MX" => Ok(DnsRecordType::Mx),
        "CNAME" => Ok(DnsRecordType::Cname),
        "NS" => Ok(DnsRecordType::Ns),
        "TXT" => Ok(DnsRecordType::Txt),
        "SRV" => Ok(DnsRecordType::Srv),
        "SOA" => Ok(DnsRecordType::Soa),
        "PTR" => Ok(DnsRecordType::Ptr),
        "ANY" => Ok(DnsRecordType::Any),
        other => Err(TerminalError::NetworkError(format!(
            "unknown DNS record type: '{other}'"
        ))),
    }
}
