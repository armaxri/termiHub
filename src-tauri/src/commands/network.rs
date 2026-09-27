//! Tauri commands for built-in network diagnostic tools.
//!
//! Every tool runs a core `ToolRegistry` tool through
//! [`tool_runner`](crate::network::tool_runner) — on this computer, or on the
//! agent its run-location names (#3731). Long-running operations (port scan,
//! ping, ping sweep, traceroute) are launched as background tasks and stream
//! results back via Tauri events. One-shot operations (DNS, WoL, open ports)
//! return immediately.
//!
//! An agent below the network-tool version floor is refused before the task
//! starts, so the command itself rejects with the "update the agent" error.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use termihub_core::network::{port_scan, DnsRecordType, ParseDnsRecordTypeError, WolDevice};

use crate::network::agent_stream::StreamTool;
use crate::network::http_monitor::{HttpCheckResult, HttpMonitorConfig, HttpMonitorState};
use crate::network::monitor_history_manager::HttpMonitorHistoryManager;
use crate::network::tool_history::{NetworkHistoryTool, NetworkToolRun};
use crate::network::tool_history_manager::NetworkToolHistoryManager;
use crate::network::tool_runner::{self, ToolTarget};
use crate::network::{agent_tools, NetworkManager};
use crate::run_location::RunLocation;
use crate::utils::errors::TerminalError;

/// Start `tool` as a background task on `target`, streaming its `network-*`
/// events to the frontend. Returns the task id the events carry.
fn spawn_streaming_task(
    manager: &Arc<NetworkManager>,
    app: AppHandle,
    target: ToolTarget,
    tool: StreamTool,
    params: Value,
) -> String {
    let (task_id, cancel) = manager.register_task();
    let tid = task_id.clone();
    // The owned `Arc<NetworkManager>` clone keeps the manager alive for exactly
    // as long as this task needs it.
    let manager = Arc::clone(manager);
    tokio::spawn(async move {
        tool_runner::run_streaming(target, tool, &tid, params, &cancel, move |name, payload| {
            let _ = app.emit(name, payload);
        })
        .await;
        manager.complete_task(&tid);
    });
    task_id
}

/// Set (or clear) the run-location preference for a network tool (#2190).
///
/// Recording an agent routes that tool's next invocation to the agent's
/// `tool.*` methods; [`RunLocation::ThisComputer`] clears the preference
/// (back to running on the desktop). The desktop-only HTTP monitor refuses an
/// agent location. Backs the run-location selector UI (#2191).
#[tauri::command]
pub fn set_network_tool_run_location(
    tool: String,
    run_location: RunLocation,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.set_run_location(&tool, run_location)
}

// ── Port Scanner ─────────────────────────────────────────────────────────────

/// Start a TCP port scan. Returns a task ID; results are emitted as events.
///
/// `host` accepts a single host, an IPv4 or IPv6 address, a CIDR range (e.g.
/// `192.168.0.0/24`), or a comma-separated mix of those.
///
/// Events emitted:
/// - `network-scan-result` per port: `{ taskId, host, port, state, latencyMs? }`
/// - `network-scan-complete`: `{ taskId, summary }`
/// - `network-scan-error`: `{ taskId, error }`
#[tauri::command]
pub async fn network_port_scan(
    host: String,
    ports: String,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    // Validate up front so a bad spec rejects the command itself, wherever the
    // scan would run.
    port_scan::parse_port_spec(&ports).map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    let targets = port_scan::parse_target_spec(&host)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

    let target = tool_runner::resolve_target(&manager, agent_tools::tool::PORT_SCAN)?;
    let params =
        agent_tools::port_scan_tool_params(&host, &targets, &ports, timeout_ms, concurrency);
    Ok(spawn_streaming_task(
        manager.inner(),
        app,
        target,
        StreamTool::PortScan,
        params,
    ))
}

/// Cancel a running port scan.
#[tauri::command]
pub fn network_port_scan_cancel(
    task_id: String,
    manager: State<'_, Arc<NetworkManager>>,
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
/// - `network-ping-error`: `{ taskId, error }`
#[tauri::command]
pub async fn network_ping_start(
    host: String,
    interval_ms: Option<u64>,
    count: Option<u32>,
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let target = tool_runner::resolve_target(&manager, agent_tools::tool::PING)?;
    let params = agent_tools::ping_tool_params(&host, interval_ms, count);
    Ok(spawn_streaming_task(
        manager.inner(),
        app,
        target,
        StreamTool::Ping,
        params,
    ))
}

/// Stop a running ping session.
#[tauri::command]
pub fn network_ping_stop(
    task_id: String,
    manager: State<'_, Arc<NetworkManager>>,
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
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let targets = port_scan::parse_target_spec(&host)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

    let target = tool_runner::resolve_target(&manager, agent_tools::tool::PING_SWEEP)?;
    let params =
        agent_tools::ping_sweep_tool_params(&targets, timeout_ms, concurrency, resolve_hostnames);
    Ok(spawn_streaming_task(
        manager.inner(),
        app,
        target,
        StreamTool::PingSweep,
        params,
    ))
}

/// Cancel a running ping sweep.
#[tauri::command]
pub fn network_ping_sweep_cancel(
    task_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

/// Perform a DNS lookup and return the records (a `DnsResult`) immediately.
#[tauri::command]
pub async fn network_dns_lookup(
    hostname: String,
    record_type: String,
    server: Option<String>,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<Value, TerminalError> {
    // Validate the record type up front so the error is identical regardless of
    // where the lookup runs.
    record_type
        .parse::<DnsRecordType>()
        .map_err(|e: ParseDnsRecordTypeError| TerminalError::NetworkError(e.to_string()))?;

    let target = tool_runner::resolve_target(&manager, agent_tools::tool::DNS)?;
    let params = agent_tools::dns_tool_params(&hostname, &record_type, server.as_deref());
    tool_runner::run_one_shot(&target, agent_tools::tool::DNS, params).await
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/// List listening ports as a bare `OpenPort[]` — this computer's, or the
/// **agent host's** when the tool runs on an agent (PROD-033).
#[tauri::command]
pub async fn network_open_ports(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<Value, TerminalError> {
    let target = tool_runner::resolve_target(&manager, agent_tools::tool::OPEN_PORTS)?;
    let result = tool_runner::run_one_shot(
        &target,
        agent_tools::tool::OPEN_PORTS,
        serde_json::json!({}),
    )
    .await?;
    let ports = agent_tools::parse_open_ports_result(result)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    serde_json::to_value(ports).map_err(|e| TerminalError::NetworkError(e.to_string()))
}

// ── Traceroute ───────────────────────────────────────────────────────────────

/// Start a traceroute. Returns a task ID; hops are emitted as events.
///
/// Events emitted:
/// - `network-traceroute-hop`: `{ taskId, hop }`
/// - `network-traceroute-complete`: `{ taskId }`
/// - `network-traceroute-error`: `{ taskId, error }`
#[tauri::command]
pub async fn network_traceroute(
    host: String,
    max_hops: Option<u8>,
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let target = tool_runner::resolve_target(&manager, agent_tools::tool::TRACEROUTE)?;
    let params = agent_tools::traceroute_tool_params(&host, max_hops);
    Ok(spawn_streaming_task(
        manager.inner(),
        app,
        target,
        StreamTool::Traceroute,
        params,
    ))
}

/// Cancel a running traceroute.
#[tauri::command]
pub fn network_traceroute_cancel(
    task_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.cancel_task(&task_id)
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

/// Send a Wake-on-LAN magic packet — from this computer, or from the agent's
/// LAN when the tool runs on an agent.
#[tauri::command]
pub async fn network_wol_send(
    mac: String,
    broadcast: String,
    port: u16,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    let target = tool_runner::resolve_target(&manager, agent_tools::tool::WOL)?;
    let params = agent_tools::wol_tool_params(&mac, &broadcast, port);
    tool_runner::run_one_shot(&target, agent_tools::tool::WOL, params)
        .await
        .map(|_| ())
}

/// List saved WoL devices.
#[tauri::command]
pub fn network_wol_devices_list(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<Vec<WolDevice>, TerminalError> {
    Ok(manager.list_wol_devices())
}

/// Save (add or update) a WoL device.
#[tauri::command]
pub fn network_wol_device_save(
    device: WolDevice,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.save_wol_device(device)
}

/// Delete a saved WoL device.
#[tauri::command]
pub fn network_wol_device_delete(
    device_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.delete_wol_device(&device_id)
}

// ── HTTP Monitor ─────────────────────────────────────────────────────────────

/// Start a new HTTP monitor. Returns the monitor ID.
///
/// `run_location` chooses where the monitor runs (default:
/// [`RunLocation::ThisComputer`]); an agent choice hosts the poll loop on that
/// agent, which probes the target from its own vantage and streams the checks
/// back (#2592).
#[tauri::command]
pub fn network_http_monitor_start(
    url: String,
    interval_ms: Option<u64>,
    method: Option<String>,
    expected_status: Option<u16>,
    timeout_ms: Option<u64>,
    run_location: Option<RunLocation>,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<String, TerminalError> {
    let config = HttpMonitorConfig::new(
        url,
        interval_ms.unwrap_or(30_000),
        method.unwrap_or_else(|| "GET".into()),
        expected_status.unwrap_or(200),
        timeout_ms.unwrap_or(5_000),
    );
    manager.start_http_monitor(config, run_location.unwrap_or_default())
}

/// Set (or clear) a monitor's run-location preference (#2592).
///
/// [`RunLocation::ThisComputer`] clears the preference (back to the desktop
/// default); a [`RunLocation::Agent`] records which agent hosts the monitor on
/// its next start. Mirrors `set_embedded_server_run_location`.
#[tauri::command]
pub fn set_http_monitor_run_location(
    monitor_id: String,
    run_location: RunLocation,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.set_http_monitor_run_location(&monitor_id, run_location)
}

/// Stop a running HTTP monitor, keeping it listed (as not running) so it can be
/// resumed. Use [`network_http_monitor_remove`] to delete it.
#[tauri::command]
pub fn network_http_monitor_stop(
    monitor_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.stop_http_monitor(&monitor_id)
}

/// Remove an HTTP monitor entirely (cancel + drop handle + delete persisted
/// config).
#[tauri::command]
pub fn network_http_monitor_remove(
    monitor_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.remove_http_monitor(&monitor_id)
}

/// Pause a running HTTP monitor (suspend polling, keep the loop alive).
#[tauri::command]
pub fn network_http_monitor_pause(
    monitor_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.pause_http_monitor(&monitor_id)
}

/// Resume a paused or stopped HTTP monitor with the same config.
#[tauri::command]
pub fn network_http_monitor_resume(
    monitor_id: String,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.resume_http_monitor(&monitor_id)
}

/// Stop every running HTTP monitor at once.
///
/// Backs the "Kill All" action of the Open Connections panel's HTTP Monitors
/// group (#1147). Reuses the same teardown as app shutdown.
#[tauri::command]
pub fn network_http_monitor_stop_all(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    manager.stop_all_http_monitors();
    Ok(())
}

/// List all HTTP monitors and their current state.
#[tauri::command]
pub fn network_http_monitor_list(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<Vec<HttpMonitorState>, TerminalError> {
    Ok(manager.list_http_monitors())
}

// ── Run history (PROD-032) ───────────────────────────────────────────────────

/// List recorded network-tool runs, newest first — every tool, or one `tool`.
#[tauri::command]
pub fn list_network_tool_runs(
    tool: Option<NetworkHistoryTool>,
    manager: State<'_, NetworkToolHistoryManager>,
) -> Result<Vec<NetworkToolRun>, TerminalError> {
    manager.list(tool)
}

/// Record a finished network-tool run. The backend bounds it (per-tool count,
/// age, per-run size) and returns the record as stored.
#[tauri::command]
pub fn record_network_tool_run(
    run: NetworkToolRun,
    manager: State<'_, NetworkToolHistoryManager>,
) -> Result<NetworkToolRun, TerminalError> {
    manager.record(run)
}

/// Delete one recorded run by id.
#[tauri::command]
pub fn delete_network_tool_run(
    id: String,
    manager: State<'_, NetworkToolHistoryManager>,
) -> Result<(), TerminalError> {
    manager.delete(&id)
}

/// Clear the run history — for one `tool`, or for every tool when omitted.
#[tauri::command]
pub fn clear_network_tool_history(
    tool: Option<NetworkHistoryTool>,
    manager: State<'_, NetworkToolHistoryManager>,
) -> Result<(), TerminalError> {
    manager.clear(tool)
}

// ── HTTP monitor check history (#3462) ───────────────────────────────────────

/// A monitor's recorded checks, oldest first. With `limit`, only the newest
/// `limit` checks (the panel's chart window); without it, all of them (CSV).
#[tauri::command]
pub fn list_http_monitor_checks(
    monitor_id: String,
    limit: Option<usize>,
    manager: State<'_, HttpMonitorHistoryManager>,
) -> Result<Vec<HttpCheckResult>, TerminalError> {
    manager.list(&monitor_id, limit)
}

/// Clear the check history — of one `monitor_id`, or of every monitor when
/// omitted (the Settings clear-all).
#[tauri::command]
pub fn clear_http_monitor_history(
    monitor_id: Option<String>,
    manager: State<'_, HttpMonitorHistoryManager>,
) -> Result<(), TerminalError> {
    manager.clear(monitor_id.as_deref())
}

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
        // Hold a bound, never-listening socket for the whole probe: its port
        // cannot be connected to (Linux/Windows refuse, macOS drops the SYN) and,
        // without `SO_REUSEADDR`, no concurrent test can bind it. The old
        // bind-a-listener-then-drop-it port could be reassigned to another test's
        // live listener before the probe fired (#2008, #3532).
        use socket2::{Domain, Protocol, Socket, Type};
        let held = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
            .expect("create TCP socket");
        held.bind(&std::net::SocketAddr::from(([127, 0, 0, 1], 0)).into())
            .expect("bind loopback TCP socket");
        let port = held
            .local_addr()
            .expect("local addr")
            .as_socket()
            .expect("an IP socket address")
            .port();

        let reachable = probe_target_reachable("127.0.0.1".to_string(), port, Some(500))
            .await
            .expect("probe should not error");
        assert!(!reachable, "closed port {port} was reported reachable");
    }
}
