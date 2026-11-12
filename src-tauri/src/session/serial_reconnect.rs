//! Desktop glue for the serial auto-reconnect (#5390).
//!
//! A resilient serial tab reconnects through the same backend redrive as SSH
//! ([`crate::session_projection::redrive`]): the shared reconnect policy, the
//! shared countdown strip and the same Cancel. Two serial-specific steps sit
//! around it, both pure over a [`SerialPortProbe`] so tests never touch a real
//! device:
//!
//! - [`opened_serial_identity`] records the USB identity of the device a tab
//!   opened, kept with the retained request;
//! - [`gate_serial_reconnect`] runs before each redrive attempt and lets it
//!   open a port only when [`resolve_reconnect_port`] says the configured
//!   device is back. Anything else is a failed attempt with a reason, so the
//!   loop backs off and gives up on the shared policy.
//!
//! Only **direct** serial tabs go through here. An agent-hosted serial session
//! lives on the agent, which reopens the port on its own host and reports each
//! step with `connection.reconnect` (#5396, `agent/src/daemon/serial_reopen.rs`).

use serde_json::Value;
use termihub_core::config::SerialConfig;
use termihub_core::session::serial_reconnect::{
    resolve_reconnect_port, ReconnectPortResolution, SerialDeviceIdentity, SerialPortProbe,
};

/// The connection type id of the serial backend.
const SERIAL_TYPE_ID: &str = "serial";

/// The configured port of a serial settings bag, with `${env:…}` expanded as
/// the backend does on connect. `None` when the bag is not a serial config.
fn configured_port(settings: &Value) -> Option<String> {
    let config: SerialConfig = serde_json::from_value(settings.clone()).ok()?;
    let port = config.expand().port;
    (!port.is_empty()).then_some(port)
}

/// Whether a request is a direct (not agent-hosted) serial connection.
fn is_direct_serial(type_id: &str, agent_id: Option<&str>) -> bool {
    type_id == SERIAL_TYPE_ID && agent_id.is_none()
}

/// The USB identity of the device a direct serial connection just opened, to
/// remember for its reconnect loop. `None` for any other request or when the
/// platform cannot read an identity.
pub(crate) fn opened_serial_identity(
    type_id: &str,
    agent_id: Option<&str>,
    settings: &Value,
    probe: &dyn SerialPortProbe,
) -> Option<SerialDeviceIdentity> {
    if !is_direct_serial(type_id, agent_id) {
        return None;
    }
    probe.identity(&configured_port(settings)?)
}

/// Decide whether a reconnect attempt may open a port (see the module docs).
///
/// Returns the settings to connect with: unchanged for any non-serial or
/// agent-hosted request; for a direct serial request, with `port` set to the
/// port the configured device now uses. `Err` carries the reason the attempt
/// did not open anything, which the loop folds as a failed attempt.
pub(crate) fn gate_serial_reconnect(
    type_id: &str,
    agent_id: Option<&str>,
    mut settings: Value,
    remembered: Option<&SerialDeviceIdentity>,
    probe: &dyn SerialPortProbe,
) -> Result<Value, String> {
    if !is_direct_serial(type_id, agent_id) {
        return Ok(settings);
    }
    let Some(configured) = configured_port(&settings) else {
        // Not a usable serial config: let the connect report the real error.
        return Ok(settings);
    };
    match resolve_reconnect_port(&configured, remembered, probe) {
        ReconnectPortResolution::Reopen { port } => {
            if port != configured {
                if let Some(map) = settings.as_object_mut() {
                    map.insert("port".to_string(), Value::String(port));
                }
            }
            Ok(settings)
        }
        other => Err(other
            .waiting_reason(&configured)
            .unwrap_or_else(|| format!("Serial port {configured} is not available."))),
    }
}

#[cfg(test)]
#[path = "serial_reconnect_tests.rs"]
mod tests;
