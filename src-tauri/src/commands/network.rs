//! Tauri commands for built-in network diagnostic tools.
//!
//! Long-running operations (port scan, ping, traceroute) are launched as
//! background tasks and stream results back via Tauri events. One-shot
//! operations (DNS, WoL, open ports) return immediately.

use tauri::{AppHandle, Emitter, State};

use termihub_core::network::{
    dns, open_ports, ping, port_scan, traceroute, wol, DnsRecordType, PortScanResult, WolDevice,
};

use crate::network::http_monitor::{HttpMonitorConfig, HttpMonitorState};
use crate::network::NetworkManager;
use crate::utils::errors::TerminalError;

// ── Port Scanner ─────────────────────────────────────────────────────────────

/// Start a TCP port scan. Returns a task ID; results are emitted as events.
///
/// Events emitted:
/// - `network-scan-result` per port: `{ taskId, port, state, latencyMs? }`
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
                        "port": result.port,
                        "state": result.state,
                        "latencyMs": result.latency_ms,
                    }),
                );
            }
        };

        let summary = port_scan::scan_ports(
            &host,
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

        let canceled = cancel_clone.is_cancelled();
        let result =
            ping::ping_stream(&host, interval_ms.unwrap_or(1000), count, on_result, cancel).await;

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

// ── DNS Lookup ───────────────────────────────────────────────────────────────

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

/// Stop a running HTTP monitor.
#[tauri::command]
pub fn network_http_monitor_stop(
    monitor_id: String,
    manager: State<'_, NetworkManager>,
) -> Result<(), TerminalError> {
    manager.stop_http_monitor(&monitor_id)
}

/// List all HTTP monitors and their current state.
#[tauri::command]
pub fn network_http_monitor_list(
    manager: State<'_, NetworkManager>,
) -> Result<Vec<HttpMonitorState>, TerminalError> {
    Ok(manager.list_http_monitors())
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
