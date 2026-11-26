//! Live serial port list for **agent-hosted** serial connections (#5069).
//!
//! The serial Port field rescans local ports through
//! [`list_serial_ports`](super::session::list_serial_ports) while it is visible
//! (#5066). For an agent-hosted serial connection the ports live on the agent's
//! host, so [`list_agent_serial_ports`] asks the connected agent via the
//! `serial.list_ports` RPC (protocol 0.34.0) instead.
//!
//! The frontend only calls this for an agent advertising the
//! `serialPortRescan` capability. Should an agent still answer JSON-RPC "method
//! not found" (typed by `send_request` as [`TerminalError::AgentUnsupported`]),
//! that is reported as `supported: false` — the field keeps the agent's
//! `availableSerialPorts` snapshot — never as an error.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tracing::trace;

use termihub_core::protocol::methods::{
    HostAddressesResult, SerialListPortsResult, HOST_ADDRESSES, SERIAL_LIST_PORTS,
};

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Wait bound for one listing. The field polls every ~1.5 s while visible, so a
/// slow agent link must fail fast (the frontend then backs off) rather than
/// hold a request for the default one-minute timeout.
pub const AGENT_SERIAL_LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// Result of [`list_agent_serial_ports`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentSerialPortsResult {
    /// `false` when the agent is too old to list its ports on demand (the
    /// field keeps the connect-time `availableSerialPorts` snapshot).
    pub supported: bool,
    /// The agent host's serial ports in natural order (empty when unsupported).
    pub ports: Vec<String>,
}

/// Ask an agent for its serial ports through `send` (one JSON-RPC request) and
/// decode the reply. Split out of the command so it is testable without a
/// Tauri `State` or a live agent.
pub fn list_agent_serial_ports_via(
    send: impl FnOnce(&str, Value) -> Result<Value, TerminalError>,
) -> Result<AgentSerialPortsResult, TerminalError> {
    match send(SERIAL_LIST_PORTS, Value::Object(Default::default())) {
        Ok(value) => {
            let parsed: SerialListPortsResult = serde_json::from_value(value).map_err(|e| {
                TerminalError::RemoteError(format!(
                    "Invalid {SERIAL_LIST_PORTS} reply from agent: {e}"
                ))
            })?;
            Ok(AgentSerialPortsResult {
                supported: true,
                ports: parsed.ports,
            })
        }
        Err(TerminalError::AgentUnsupported(_)) => Ok(AgentSerialPortsResult {
            supported: false,
            ports: Vec::new(),
        }),
        Err(e) => Err(e),
    }
}

/// List the serial ports of a connected agent's host, for the Port field of an
/// agent-hosted serial connection, which polls this while visible (#5069).
/// Returns `supported: false` for an agent older than protocol 0.34.0; rejects
/// when the agent is not connected or does not answer within
/// [`AGENT_SERIAL_LIST_TIMEOUT`].
#[tauri::command]
pub async fn list_agent_serial_ports(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentSerialPortsResult, TerminalError> {
    trace!(agent_id, "Listing agent serial ports");
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !manager.is_connected(&agent_id) {
            return Err(TerminalError::RemoteError(format!(
                "Agent {agent_id} not connected"
            )));
        }
        list_agent_serial_ports_via(|method, params| {
            manager.send_request_bounded(&agent_id, method, params, AGENT_SERIAL_LIST_TIMEOUT)
        })
    })
    .await
    .unwrap_or_else(|e| Err(TerminalError::InternalError(e.to_string())))
}

/// Result of [`list_agent_addresses`] (#6086).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentAddressesResult {
    /// `false` when the agent is too old to list them: the address is typed.
    pub supported: bool,
    /// The agent host's IPv4 addresses, as a computer's own are listed.
    pub addresses: Vec<crate::commands::embedded_servers::NetworkInterface>,
}

/// Ask an agent for its host's addresses through `send` and decode the reply.
pub fn list_agent_addresses_via(
    send: impl FnOnce(&str, Value) -> Result<Value, TerminalError>,
) -> Result<AgentAddressesResult, TerminalError> {
    match send(HOST_ADDRESSES, Value::Object(Default::default())) {
        Ok(value) => {
            let parsed: HostAddressesResult = serde_json::from_value(value).map_err(|e| {
                TerminalError::RemoteError(format!(
                    "Invalid {HOST_ADDRESSES} reply from agent: {e}"
                ))
            })?;
            let addresses = parsed
                .addresses
                .into_iter()
                .map(|a| crate::commands::embedded_servers::NetworkInterface {
                    name: a.name,
                    addr: a.addr,
                })
                .collect();
            Ok(AgentAddressesResult {
                supported: true,
                addresses,
            })
        }
        Err(TerminalError::AgentUnsupported(_)) => Ok(AgentAddressesResult {
            supported: false,
            addresses: Vec::new(),
        }),
        Err(e) => Err(e),
    }
}

/// List the network addresses of a connected agent's host, for the file server
/// editor's "one address of that machine" (#6086). `supported: false` for an
/// agent older than protocol 0.46.0; rejects when the agent is not connected or
/// does not answer in time.
#[tauri::command]
pub async fn list_agent_addresses(
    agent_id: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<AgentAddressesResult, TerminalError> {
    let manager = agent_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !manager.is_connected(&agent_id) {
            return Err(TerminalError::RemoteError(format!(
                "Agent {agent_id} not connected"
            )));
        }
        list_agent_addresses_via(|method, params| {
            manager.send_request_bounded(&agent_id, method, params, AGENT_SERIAL_LIST_TIMEOUT)
        })
    })
    .await
    .unwrap_or_else(|e| Err(TerminalError::InternalError(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sends_the_method_and_decodes_the_ports_in_order() {
        let mut sent = None;
        let result = list_agent_serial_ports_via(|method, params| {
            sent = Some((method.to_string(), params));
            Ok(json!({ "ports": ["/dev/ttyUSB0", "/dev/ttyUSB1"] }))
        })
        .expect("ok");
        assert_eq!(sent, Some(("serial.list_ports".to_string(), json!({}))));
        assert_eq!(
            result,
            AgentSerialPortsResult {
                supported: true,
                ports: vec!["/dev/ttyUSB0".into(), "/dev/ttyUSB1".into()],
            }
        );
    }

    #[test]
    fn an_agents_addresses_are_listed_as_this_computers_are() {
        let mut sent = None;
        let result = list_agent_addresses_via(|method, params| {
            sent = Some((method.to_string(), params));
            Ok(json!({ "addresses": [{ "name": "eth0", "addr": "192.168.1.30" }] }))
        })
        .expect("ok");
        assert_eq!(sent, Some(("host.addresses".to_string(), json!({}))));
        assert!(result.supported);
        assert_eq!(result.addresses.len(), 1);
        assert_eq!(
            (
                result.addresses[0].name.as_str(),
                result.addresses[0].addr.as_str()
            ),
            ("eth0", "192.168.1.30")
        );
        // An older agent: typed, not an error.
        let old = list_agent_addresses_via(|_, _| {
            Err(TerminalError::AgentUnsupported("Method not found".into()))
        })
        .expect("unsupported is not an error");
        assert_eq!((old.supported, old.addresses.len()), (false, 0));
        // Anything else is the caller's to show.
        assert!(
            list_agent_addresses_via(|_, _| Err(TerminalError::RemoteError("x".into()))).is_err()
        );
    }

    #[test]
    fn a_reply_without_ports_is_an_empty_list() {
        let result = list_agent_serial_ports_via(|_, _| Ok(json!({}))).expect("ok");
        assert!(result.supported);
        assert!(result.ports.is_empty());
    }

    /// An agent older than protocol 0.34.0 answers "method not found": the
    /// field must keep its snapshot, not show an error.
    #[test]
    fn old_agent_method_not_found_is_unsupported_not_an_error() {
        let result = list_agent_serial_ports_via(|_, _| {
            Err(TerminalError::AgentUnsupported("Method not found".into()))
        })
        .expect("unsupported is not an error");
        assert_eq!(
            result,
            AgentSerialPortsResult {
                supported: false,
                ports: Vec::new(),
            }
        );
    }

    #[test]
    fn transport_errors_propagate() {
        let err = list_agent_serial_ports_via(|_, _| {
            Err(TerminalError::RemoteError("request timed out".into()))
        })
        .expect_err("error");
        assert!(err.to_string().contains("request timed out"));
    }

    #[test]
    fn a_malformed_reply_is_an_error() {
        let err =
            list_agent_serial_ports_via(|_, _| Ok(json!({ "ports": "nope" }))).expect_err("error");
        assert!(matches!(err, TerminalError::RemoteError(_)));
    }

    #[test]
    fn result_serializes_camel_case_for_the_frontend() {
        let v = serde_json::to_value(AgentSerialPortsResult {
            supported: true,
            ports: vec!["COM3".into()],
        })
        .unwrap();
        assert_eq!(v, json!({ "supported": true, "ports": ["COM3"] }));
    }
}
