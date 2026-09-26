use tauri::State;

use crate::embedded_servers::activity::ActivitySnapshot;
use crate::embedded_servers::config::{EmbeddedServerConfig, ServerState};
use crate::embedded_servers::server_manager::{
    clear_agent_activity, fetch_agent_activity, ActivityRoute, EmbeddedServerManager,
};
use crate::run_location::RunLocation;
use crate::utils::errors::TerminalError;

/// A network interface with its bound IP address, for the bind-address dropdown.
#[derive(serde::Serialize)]
pub struct NetworkInterface {
    /// Human-readable interface name (e.g. "en0", "eth0").
    pub name: String,
    /// IPv4 address as a string (e.g. "192.168.1.5").
    pub addr: String,
}

/// Return all local IPv4 network interfaces suitable for use as a bind address.
///
/// Always includes the loopback (`127.0.0.1`) entry first and an
/// "all interfaces" (`0.0.0.0`) entry last.
#[tauri::command]
pub fn list_network_interfaces() -> Vec<NetworkInterface> {
    let mut interfaces = vec![NetworkInterface {
        name: "Loopback".to_string(),
        addr: "127.0.0.1".to_string(),
    }];

    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            // Only IPv4, skip loopback (already added above).
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(ipv4) = iface.addr.ip() {
                interfaces.push(NetworkInterface {
                    name: iface.name,
                    addr: ipv4.to_string(),
                });
            }
        }
    }

    interfaces.push(NetworkInterface {
        name: "All Interfaces".to_string(),
        addr: "0.0.0.0".to_string(),
    });

    interfaces
}

/// Return all saved embedded server configurations.
#[tauri::command]
pub fn list_embedded_servers(
    manager: State<'_, EmbeddedServerManager>,
) -> Result<Vec<EmbeddedServerConfig>, TerminalError> {
    manager.get_configs()
}

/// Add or update an embedded server configuration.
#[tauri::command]
pub fn save_embedded_server(
    config: EmbeddedServerConfig,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.save_config(config)
}

/// Delete an embedded server configuration by ID.
#[tauri::command]
pub fn delete_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.delete_config(&server_id)
}

/// Get the current runtime state of all configured servers.
#[tauri::command]
pub fn get_embedded_server_states(
    manager: State<'_, EmbeddedServerManager>,
) -> Result<Vec<ServerState>, TerminalError> {
    manager.get_states()
}

/// Read a server's access log and detailed statistics (PROD-034, PROD-036).
///
/// Returns only entries newer than `since_seq` (all retained entries when
/// omitted), so the UI can poll incrementally. An agent-hosted server's log is
/// read from the agent over `embedded_server.activity` (#3453). `null` when
/// there is no log: never started, or hosted on an agent that predates the RPC
/// (the UI tells those apart by the agent's `embeddedServerActivity` flag).
///
/// `async` + `spawn_blocking`: the agent path is a blocking RPC, which must not
/// run on the main thread a synchronous command uses.
#[tauri::command]
pub async fn get_embedded_server_activity(
    server_id: String,
    since_seq: Option<u64>,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<Option<ActivitySnapshot>, TerminalError> {
    match manager.activity_route(&server_id)? {
        ActivityRoute::Desktop => manager.get_activity(&server_id, since_seq),
        ActivityRoute::Agent(agent_id) => {
            let Some(client) = manager.agent_client() else {
                return Ok(None);
            };
            tokio::task::spawn_blocking(move || {
                fetch_agent_activity(client.as_ref(), &agent_id, &server_id, since_seq)
            })
            .await
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Task join error: {e}")))?
        }
    }
}

/// Clear a server's access log and its request/error/top counters — on the
/// hosting agent for an agent-hosted server (#3453).
#[tauri::command]
pub async fn clear_embedded_server_activity(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    match manager.activity_route(&server_id)? {
        ActivityRoute::Desktop => manager.clear_activity(&server_id),
        ActivityRoute::Agent(agent_id) => {
            let Some(client) = manager.agent_client() else {
                return Ok(());
            };
            tokio::task::spawn_blocking(move || {
                clear_agent_activity(client.as_ref(), &agent_id, &server_id)
            })
            .await
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Task join error: {e}")))?
        }
    }
}

/// Set (or clear) which machine hosts a server — "This computer" or a named
/// agent (#2214).
///
/// Recording an agent routes the server's next start to that agent over the
/// agent RPC; `ThisComputer` clears the preference (back to desktop hosting).
/// This backs the run-location selector UI (a later S-phase) and is the hook for
/// exercising agent-hosted servers meanwhile.
#[tauri::command]
pub fn set_embedded_server_run_location(
    server_id: String,
    run_location: RunLocation,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.set_run_location(&server_id, run_location)
}

/// Start a server by ID.
///
/// Port conflicts are intentionally **not** retried here. A manually configured
/// server has an explicit, user-chosen, persisted port, so binding a *different*
/// port would silently desync the running server from its saved config and the
/// address the user handed out. When the port is taken, the start fails with the
/// shared, recoverable "port already in use" error (see
/// [`EmbeddedServerService::check_port_config`]) which the sidebar surfaces as a
/// toast; the user then frees the port or edits the config. This is the
/// deliberate counterpart to [`create_and_start_server`]'s fallback, which only
/// applies because quick-share starts from an unchosen default port (SM-018).
#[tauri::command]
pub fn start_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.start_server(&server_id)
}

/// Stop a running server by ID.
#[tauri::command]
pub fn stop_embedded_server(
    server_id: String,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<(), TerminalError> {
    manager.stop_server(&server_id)
}

/// Create a new server configuration and immediately start it.
///
/// If the requested port is in use, up to 10 sequential ports are tried. This
/// fallback is specific to quick-share, which starts from an unchosen default
/// port (`DEFAULT_PORTS[protocol]`) the user never picked — so stepping to the
/// next free port and reporting the one actually bound is the right UX. The
/// manual [`start_embedded_server`] path deliberately does *not* fall back,
/// because its port is explicit and persisted (SM-018).
/// Returns the ID of the newly created configuration.
#[tauri::command]
pub fn create_and_start_server(
    mut config: EmbeddedServerConfig,
    manager: State<'_, EmbeddedServerManager>,
) -> Result<String, TerminalError> {
    // Generate an ID if none was provided.
    if config.id.is_empty() {
        config.id = format!(
            "srv-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            &uuid::Uuid::new_v4().to_string()[..8]
        );
    }

    // Try the initial port, then up to 9 more.
    let base_port = config.port;
    let mut last_err = String::new();
    for attempt in 0..10u16 {
        config.port = base_port + attempt;
        manager.save_config(config.clone())?;
        match manager.start_server(&config.id) {
            Ok(()) => return Ok(config.id),
            Err(e) => {
                last_err = e.to_string();
                // Remove the config we just saved and try the next port.
                let _ = manager.delete_config(&config.id);
            }
        }
    }

    Err(TerminalError::EmbeddedServerError(format!(
        "Could not start server: {last_err}"
    )))
}
