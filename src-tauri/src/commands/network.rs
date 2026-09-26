//! Tauri commands for built-in network diagnostic tools.
//!
//! Long-running operations (port scan, ping, traceroute) are launched as
//! background tasks and stream results back via Tauri events. One-shot
//! operations (DNS, WoL, open ports) return immediately.

use std::sync::Arc;

use tauri::{AppHandle, State};

use termihub_core::network::{
    defaults, dns, open_ports, ping, ping_sweep, port_scan, traceroute, wol, DnsRecordType,
    ParseDnsRecordTypeError, PingSweepResult, PortScanResult, WolDevice,
};

use crate::network::agent_stream::{self, StreamTool};
use crate::network::http_monitor::{HttpMonitorConfig, HttpMonitorState};
use crate::network::tool_history::{NetworkHistoryTool, NetworkToolRun};
use crate::network::tool_history_manager::NetworkToolHistoryManager;
use crate::network::{agent_tools, events, NetworkManager};
use crate::run_location::{ResolvedLocation, RunLocation};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Fetch the agent RPC client when a tool's run-location resolves to an agent
/// (#2190). `Ok(None)` for a local run; an error when an agent is requested but
/// no agent client is available.
fn agent_client_for(
    manager: &NetworkManager,
    location: &ResolvedLocation,
) -> Result<Option<Arc<dyn AgentRpcClient>>, TerminalError> {
    match location {
        ResolvedLocation::Local => Ok(None),
        ResolvedLocation::Agent(_) => manager
            .agent_rpc_client()
            .map(Some)
            .ok_or_else(|| TerminalError::NetworkError("agent manager is not available".into())),
    }
}

/// Guard that an agent-located request actually carries a resolved agent client
/// before a background task branches on it (WA-RS-005).
///
/// `agent_client_for` upholds this invariant for every normal path, so a `None`
/// here means a routing/state bug. Surfacing it as a recoverable `Err` lets the
/// caller show an error instead of the background task panicking on an
/// `.expect(...)` — a panicking command handler is worse UX and can destabilize
/// the backend.
fn ensure_agent_client<T>(
    location: &ResolvedLocation,
    agent_client: &Option<T>,
) -> Result<(), TerminalError> {
    if matches!(location, ResolvedLocation::Agent(_)) && agent_client.is_none() {
        return Err(TerminalError::NetworkError(
            "no agent client for agent-located request".into(),
        ));
    }
    Ok(())
}

/// Set (or clear) the run-location preference for a network tool (#2190).
///
/// Recording an agent routes that tool's next invocation to the agent's
/// `network.*` methods; [`RunLocation::ThisComputer`] clears the preference
/// (back to running on the desktop). The desktop-only HTTP monitor refuses an
/// agent location. Backs the run-location selector UI (#2191) and is the hook
/// for exercising agent-routed tools meanwhile.
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
#[tauri::command]
pub async fn network_port_scan(
    host: String,
    ports: String,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    let port_list = port_scan::parse_port_spec(&ports)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
    let targets = port_scan::parse_target_spec(&host)
        .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

    // Route by run-location (#2190). A tool with no recorded preference resolves
    // local and takes the existing desktop path; an agent preference proxies the
    // scan to that agent's `network.port_scan` and re-emits the same events.
    let location = manager.resolve_tool_location(agent_tools::tool::PORT_SCAN)?;
    let agent_client = agent_client_for(&manager, &location)?;
    ensure_agent_client(&location, &agent_client)?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager = Arc::clone(manager.inner());

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        match location {
            ResolvedLocation::Agent(agent_id) => {
                // Guarded by `ensure_agent_client` before spawning; emit a
                // recoverable error instead of panicking should that invariant
                // ever be bypassed (WA-RS-005).
                let Some(client) = agent_client else {
                    events::emit_error(
                        &app,
                        events::name::SCAN_ERROR,
                        &tid,
                        "no agent client for agent-located request",
                    );
                    manager.complete_task(&tid);
                    return;
                };
                if agent_stream::supports_streaming(&client, &agent_id) {
                    // Live results, no 60 s cap, Stop cancels on the agent (#3353).
                    let params = agent_tools::port_scan_tool_params(
                        &host,
                        &targets,
                        &ports,
                        timeout_ms,
                        concurrency,
                    );
                    agent_stream::run_streaming_to_app(
                        StreamTool::PortScan,
                        client,
                        &agent_id,
                        &app,
                        &tid,
                        params,
                        &cancel,
                    )
                    .await;
                } else {
                    // Older agent: one-shot `network.port_scan`.
                    let params = agent_tools::port_scan_params(
                        &host,
                        &targets,
                        &ports,
                        timeout_ms,
                        concurrency,
                    );
                    let (app2, tid2) = (app.clone(), tid.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        agent_tools::dispatch_port_scan(&client, &agent_id, &app2, &tid2, params);
                    })
                    .await;
                }
            }
            ResolvedLocation::Local => {
                let on_result = {
                    let app = app.clone();
                    let tid = tid.clone();
                    move |result: PortScanResult| {
                        events::emit_scan_result(&app, &tid, &result);
                    }
                };

                let summary = port_scan::scan_targets(
                    &targets,
                    &port_list,
                    timeout_ms.unwrap_or(defaults::PORT_SCAN_TIMEOUT_MS),
                    concurrency.unwrap_or(defaults::PORT_SCAN_CONCURRENCY),
                    on_result,
                    cancel,
                )
                .await;

                match summary {
                    Ok(s) => events::emit_scan_complete(&app, &tid, s),
                    Err(e) => {
                        events::emit_error(&app, events::name::SCAN_ERROR, &tid, &e.to_string())
                    }
                }
            }
        }

        // Clean up the task entry.
        // The owned `Arc<NetworkManager>` clone keeps the manager alive for
        // exactly as long as this task needs it.
        manager.complete_task(&tid);
    });

    Ok(task_id)
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
#[tauri::command]
pub async fn network_ping_start(
    host: String,
    interval_ms: Option<u64>,
    count: Option<u32>,
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    // Route by run-location (#2190): a recorded agent preference proxies the ping
    // to that agent's `network.ping` (a bounded, collect-and-return batch) and
    // re-emits the same events; no preference keeps the existing desktop path.
    let location = manager.resolve_tool_location(agent_tools::tool::PING)?;
    let agent_client = agent_client_for(&manager, &location)?;
    ensure_agent_client(&location, &agent_client)?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager = Arc::clone(manager.inner());
    let cancel_clone = cancel.clone();

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        match location {
            ResolvedLocation::Agent(agent_id) => {
                // Guarded by `ensure_agent_client` before spawning; emit a
                // recoverable error instead of panicking should that invariant
                // ever be bypassed (WA-RS-005).
                let Some(client) = agent_client else {
                    events::emit_error(
                        &app,
                        events::name::PING_ERROR,
                        &tid,
                        "no agent client for agent-located request",
                    );
                    manager.complete_task(&tid);
                    return;
                };
                if agent_stream::supports_streaming(&client, &agent_id) {
                    // Live echoes; an absent count runs until Stop (#3353).
                    let params = agent_tools::ping_tool_params(&host, interval_ms, count);
                    agent_stream::run_streaming_to_app(
                        StreamTool::Ping,
                        client,
                        &agent_id,
                        &app,
                        &tid,
                        params,
                        &cancel,
                    )
                    .await;
                } else {
                    // Older agent: one-shot, count-bounded `network.ping`.
                    let params = agent_tools::ping_params(&host, interval_ms, count);
                    let (app2, tid2) = (app.clone(), tid.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        agent_tools::dispatch_ping(&client, &agent_id, &app2, &tid2, params);
                    })
                    .await;
                }
            }
            ResolvedLocation::Local => {
                let on_result = {
                    let app = app.clone();
                    let tid = tid.clone();
                    move |result| {
                        events::emit_ping_result(&app, &tid, result);
                    }
                };

                let result = ping::ping_stream(
                    &host,
                    interval_ms.unwrap_or(defaults::PING_INTERVAL_MS),
                    count,
                    on_result,
                    cancel,
                )
                .await;
                // Check cancellation *after* the stream ends so Stop is reported
                // as canceled rather than completed (the token is set while it
                // runs).
                let canceled = cancel_clone.is_cancelled();

                match result {
                    Ok(stats) => events::emit_ping_complete(&app, &tid, stats, canceled),
                    Err(e) => {
                        events::emit_error(&app, events::name::PING_ERROR, &tid, &e.to_string())
                    }
                }
            }
        }

        manager.complete_task(&tid);
    });

    Ok(task_id)
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

    // Route by run-location (PROD-033): an agent preference runs the sweep from
    // the agent's vantage through its `tool.run` (`ping_sweep`) and re-emits the
    // same events; no preference keeps the desktop path.
    let location = manager.resolve_tool_location(agent_tools::tool::PING_SWEEP)?;
    let agent_client = agent_client_for(&manager, &location)?;
    ensure_agent_client(&location, &agent_client)?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager = Arc::clone(manager.inner());
    let cancel_clone = cancel.clone();

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        if let ResolvedLocation::Agent(agent_id) = location {
            // Guarded by `ensure_agent_client` before spawning (WA-RS-005).
            match agent_client {
                Some(client) if agent_stream::supports_streaming(&client, &agent_id) => {
                    // Live results, no 60 s cap, Stop cancels on the agent (#3353).
                    let params = agent_tools::ping_sweep_tool_params(
                        &targets,
                        timeout_ms,
                        concurrency,
                        resolve_hostnames,
                    );
                    agent_stream::run_streaming_to_app(
                        StreamTool::PingSweep,
                        client,
                        &agent_id,
                        &app,
                        &tid,
                        params,
                        &cancel,
                    )
                    .await;
                }
                Some(client) => {
                    // Older agent: one-shot `tool.run`.
                    let params = agent_tools::ping_sweep_tool_run_params(
                        &targets,
                        timeout_ms,
                        concurrency,
                        resolve_hostnames,
                    );
                    let (app2, tid2) = (app.clone(), tid.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        agent_tools::dispatch_ping_sweep(
                            &client, &agent_id, &app2, &tid2, params, &cancel,
                        );
                    })
                    .await;
                }
                None => events::emit_error(
                    &app,
                    events::name::SWEEP_ERROR,
                    &tid,
                    "no agent client for agent-located request",
                ),
            }
            manager.complete_task(&tid);
            return;
        }

        let on_result = {
            let app = app.clone();
            let tid = tid.clone();
            move |result: PingSweepResult| {
                events::emit_sweep_result(
                    &app,
                    &tid,
                    result.host,
                    result.latency_ms,
                    result.hostname,
                );
            }
        };

        let summary = ping_sweep::ping_sweep(
            &targets,
            timeout_ms.unwrap_or(defaults::PING_SWEEP_TIMEOUT_MS),
            concurrency.unwrap_or(defaults::PING_SWEEP_CONCURRENCY),
            resolve_hostnames.unwrap_or(defaults::PING_SWEEP_RESOLVE_HOSTNAMES),
            on_result,
            cancel,
        )
        .await;

        // The token is set while the sweep runs; check *after* it ends so Stop
        // is reported as canceled rather than completed.
        let canceled = cancel_clone.is_cancelled();

        match summary {
            Ok(s) => events::emit_sweep_complete(&app, &tid, s, canceled),
            Err(e) => events::emit_error(&app, events::name::SWEEP_ERROR, &tid, &e.to_string()),
        }

        // The owned `Arc<NetworkManager>` clone keeps the manager alive for
        // exactly as long as this task needs it.
        manager.complete_task(&tid);
    });

    Ok(task_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_agent_client_errors_when_agent_location_has_no_client() {
        // A routing/state bug could reach the agent branch without a resolved
        // client. The handler must surface a recoverable error to the frontend
        // rather than panic inside the spawned task (WA-RS-005).
        let location = ResolvedLocation::Agent("agent-1".to_string());
        let agent_client: Option<()> = None;

        let err = ensure_agent_client(&location, &agent_client)
            .expect_err("agent location with no client must be an error, not a panic");

        assert!(matches!(err, TerminalError::NetworkError(_)));
    }

    #[test]
    fn ensure_agent_client_ok_when_agent_location_has_client() {
        // The normal agent path: `agent_client_for` resolved a client.
        let location = ResolvedLocation::Agent("agent-1".to_string());
        let agent_client: Option<()> = Some(());

        ensure_agent_client(&location, &agent_client)
            .expect("agent location with a resolved client must be Ok");
    }

    #[test]
    fn ensure_agent_client_ok_for_local_location() {
        // Local runs never carry an agent client; a missing client is expected.
        let location = ResolvedLocation::Local;
        let agent_client: Option<()> = None;

        ensure_agent_client(&location, &agent_client)
            .expect("a local location without an agent client must be Ok");
    }

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

/// Perform a DNS lookup and return the records immediately.
///
/// Routes by run-location (#2190): an agent preference proxies to the agent's
/// `network.dns_lookup` (returning the same `DnsResult` shape); no preference
/// resolves on the desktop as before.
#[tauri::command]
pub async fn network_dns_lookup(
    hostname: String,
    record_type: String,
    server: Option<String>,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<serde_json::Value, TerminalError> {
    // Validate the record type locally so the error is identical regardless of
    // where the lookup runs.
    let rtype: DnsRecordType = record_type
        .parse()
        .map_err(|e: ParseDnsRecordTypeError| TerminalError::NetworkError(e.to_string()))?;

    match manager.resolve_tool_location(agent_tools::tool::DNS)? {
        ResolvedLocation::Agent(agent_id) => {
            let client = manager.agent_rpc_client().ok_or_else(|| {
                TerminalError::NetworkError("agent manager is not available".into())
            })?;
            let params = serde_json::to_value(agent_tools::dns_params(
                &hostname,
                &record_type,
                server.as_deref(),
            ))
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
            tokio::task::spawn_blocking(move || {
                client.send_request(
                    &agent_id,
                    termihub_core::protocol::methods::NETWORK_DNS_LOOKUP,
                    params,
                )
            })
            .await
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?
        }
        ResolvedLocation::Local => {
            let result = dns::dns_lookup(&hostname, rtype, server.as_deref())
                .await
                .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
            serde_json::to_value(result).map_err(|e| TerminalError::NetworkError(e.to_string()))
        }
    }
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/// List listening ports.
///
/// Routes by run-location (PROD-033): an agent preference proxies to the
/// agent's `network.open_ports` and lists the **agent host's** listening ports
/// (the same bare `OpenPort[]` shape); no preference lists this computer's.
#[tauri::command]
pub async fn network_open_ports(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<serde_json::Value, TerminalError> {
    let ports = match manager.resolve_tool_location(agent_tools::tool::OPEN_PORTS)? {
        ResolvedLocation::Agent(agent_id) => {
            let client = manager.agent_rpc_client().ok_or_else(|| {
                TerminalError::NetworkError("agent manager is not available".into())
            })?;
            tokio::task::spawn_blocking(move || {
                agent_tools::dispatch_open_ports(&client, &agent_id)
            })
            .await
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?
            .map_err(TerminalError::NetworkError)?
        }
        ResolvedLocation::Local => {
            open_ports::list_open_ports().map_err(|e| TerminalError::NetworkError(e.to_string()))?
        }
    };
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
    manager: State<'_, Arc<NetworkManager>>,
    app: AppHandle,
) -> Result<String, TerminalError> {
    // Route by run-location (#2190): a recorded agent preference proxies the
    // traceroute to that agent's `network.traceroute` (showing the agent's path
    // to the target) and re-emits the same hop events; no preference keeps the
    // existing desktop path.
    let location = manager.resolve_tool_location(agent_tools::tool::TRACEROUTE)?;
    let agent_client = agent_client_for(&manager, &location)?;
    ensure_agent_client(&location, &agent_client)?;

    let (task_id, cancel) = manager.register_task();

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let manager = Arc::clone(manager.inner());

    tokio::spawn(async move {
        let app = app_clone;
        let tid = task_id_clone.clone();

        match location {
            ResolvedLocation::Agent(agent_id) => {
                // Guarded by `ensure_agent_client` before spawning; emit a
                // recoverable error instead of panicking should that invariant
                // ever be bypassed (WA-RS-005).
                let Some(client) = agent_client else {
                    events::emit_error(
                        &app,
                        events::name::TRACEROUTE_ERROR,
                        &tid,
                        "no agent client for agent-located request",
                    );
                    manager.complete_task(&tid);
                    return;
                };
                if agent_stream::supports_streaming(&client, &agent_id) {
                    // Live hops, Stop cancels on the agent (#3353).
                    let params = agent_tools::traceroute_tool_params(&host, max_hops);
                    agent_stream::run_streaming_to_app(
                        StreamTool::Traceroute,
                        client,
                        &agent_id,
                        &app,
                        &tid,
                        params,
                        &cancel,
                    )
                    .await;
                } else {
                    // Older agent: one-shot `network.traceroute`.
                    let params = agent_tools::traceroute_params(&host, max_hops);
                    let (app2, tid2) = (app.clone(), tid.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        agent_tools::dispatch_traceroute(&client, &agent_id, &app2, &tid2, params);
                    })
                    .await;
                }
            }
            ResolvedLocation::Local => {
                let on_hop = {
                    let app = app.clone();
                    let tid = tid.clone();
                    move |hop| {
                        events::emit_traceroute_hop(&app, &tid, hop);
                    }
                };

                let result = traceroute::traceroute(
                    &host,
                    max_hops.unwrap_or(defaults::TRACEROUTE_MAX_HOPS),
                    on_hop,
                    cancel,
                )
                .await;

                match result {
                    Ok(()) => events::emit_traceroute_complete(&app, &tid),
                    Err(e) => events::emit_error(
                        &app,
                        events::name::TRACEROUTE_ERROR,
                        &tid,
                        &e.to_string(),
                    ),
                }
            }
        }

        manager.complete_task(&tid);
    });

    Ok(task_id)
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

/// Send a Wake-on-LAN magic packet.
///
/// Routes by run-location (#2190): an agent preference sends the magic packet
/// from the agent's LAN via `network.wol`; no preference sends it from the
/// desktop as before.
#[tauri::command]
pub fn network_wol_send(
    mac: String,
    broadcast: String,
    port: u16,
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<(), TerminalError> {
    match manager.resolve_tool_location(agent_tools::tool::WOL)? {
        ResolvedLocation::Agent(agent_id) => {
            let client = manager.agent_rpc_client().ok_or_else(|| {
                TerminalError::NetworkError("agent manager is not available".into())
            })?;
            let params = serde_json::to_value(agent_tools::wol_params(&mac, &broadcast, port))
                .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
            client
                .send_request(
                    &agent_id,
                    termihub_core::protocol::methods::NETWORK_WOL,
                    params,
                )
                .map(|_| ())
        }
        ResolvedLocation::Local => wol::send_magic_packet(&mac, &broadcast, port)
            .map_err(|e| TerminalError::NetworkError(e.to_string())),
    }
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
