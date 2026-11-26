use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::embedded_servers::activity::ActivitySnapshot;
use crate::embedded_servers::config::EmbeddedServerConfig;
use crate::embedded_servers::server_manager::{
    clear_agent_activity, fetch_agent_activity, ActivityRoute, EmbeddedServerManager,
};
use crate::utils::errors::TerminalError;

/// A network interface with its bound IP address, for the bind-address dropdown.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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

/// Run `work` on the manager off the main thread: starting or stopping a server
/// on an agent waits for that agent (#6028).
async fn off_main_thread<T: Send + 'static>(
    app_handle: AppHandle,
    work: impl FnOnce(&EmbeddedServerManager) -> Result<T, TerminalError> + Send + 'static,
) -> Result<T, TerminalError> {
    tokio::task::spawn_blocking(move || {
        let manager = app_handle
            .try_state::<Arc<EmbeddedServerManager>>()
            .ok_or_else(|| {
                TerminalError::EmbeddedServerError("Services are unavailable".to_string())
            })?;
        work(&manager)
    })
    .await
    .map_err(|e| TerminalError::EmbeddedServerError(format!("Task join error: {e}")))?
}

/// Add or update an embedded server configuration.
#[tauri::command]
pub async fn save_embedded_server(
    config: EmbeddedServerConfig,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| manager.save_config(config)).await
}

/// Delete an embedded server configuration by ID.
#[tauri::command]
pub async fn delete_embedded_server(
    server_id: String,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| manager.delete_config(&server_id)).await
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
    manager: State<'_, Arc<EmbeddedServerManager>>,
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
    manager: State<'_, Arc<EmbeddedServerManager>>,
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

/// Start a server by ID.
///
/// Port conflicts are intentionally **not** retried here. A manually configured
/// server has an explicit, user-chosen, persisted port, so binding a *different*
/// port would silently desync the running server from its saved config and the
/// address the user handed out. When the port is taken, the start fails with the
/// shared, recoverable "port already in use" error (see
/// [`EmbeddedServerService::check_port_config`]) which the sidebar surfaces as a
/// toast; the user then frees the port or edits the config (SM-018). The editors
/// preset a port no service of this computer is set to (#6088).
#[tauri::command]
pub async fn start_embedded_server(
    server_id: String,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| manager.start_server(&server_id)).await
}

/// Stop a running server by ID.
#[tauri::command]
pub async fn stop_embedded_server(
    server_id: String,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| manager.stop_server(&server_id)).await
}

/// What happened to a service, a tunnel or a file server (#6028, slice 9), the
/// oldest first.
#[tauri::command]
pub fn get_service_events(
    service_id: String,
    events: tauri::State<'_, crate::agent_service::events::ServiceEvents>,
) -> Vec<crate::agent_service::events::ServiceEvent> {
    events.of(&service_id)
}

/// Bring back a server that was just deleted.
#[tauri::command]
pub async fn restore_embedded_server(
    server_id: String,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| {
        manager.restore_deleted(&server_id)
    })
    .await
}

/// Take back the stop of a server that its agent has not got yet.
#[tauri::command]
pub async fn keep_embedded_server_running(
    server_id: String,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    off_main_thread(app_handle, move |manager| manager.keep_running(&server_id)).await
}

/// Ask the agents about the servers they run, now.
#[tauri::command]
pub async fn check_embedded_servers(app_handle: AppHandle) -> Result<(), TerminalError> {
    off_main_thread(app_handle, |manager| {
        manager.check_again();
        Ok(())
    })
    .await
}
