//! The `services` projection region: the file servers and what their rows say
//! (#6028, F-6).
//!
//! One **shared** region, like the [`tunnels`](crate::tunnel::projection) one,
//! so every window shows the same list, states and traffic, and a save in one
//! window reaches the others:
//!
//! ```json
//! {
//!   "servers": [ EmbeddedServerConfig, ... ],  // the saved configs, no passwords
//!   "states":  { "<serverId>": ServerState }   // state, reason, traffic
//! }
//! ```
//!
//! The commands of `commands/embedded_servers.rs` change servers and answer with
//! their own errors; what they changed arrives here. Every change publishes the
//! whole view, and the projector sends only what differs.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::config::{EmbeddedServerConfig, ServerState};
use super::server_manager::EmbeddedServerManager;
use crate::commands::projection::ProjectionState;

/// The projection region id of the file servers.
pub const SERVICES_REGION: &str = "services";

/// The `services` view of `servers` in `states`. Pure.
pub fn services_view_from(servers: Vec<EmbeddedServerConfig>, states: Vec<ServerState>) -> Value {
    let states: Map<String, Value> = states
        .into_iter()
        .filter_map(|state| {
            let value = serde_json::to_value(&state).ok()?;
            Some((state.server_id, value))
        })
        .collect();
    json!({ "servers": servers, "states": states })
}

/// The current `services` view of `manager`.
pub fn build_services_view<R: Runtime>(manager: &EmbeddedServerManager<R>) -> Value {
    services_view_from(
        manager.get_configs().unwrap_or_default(),
        manager.get_states().unwrap_or_default(),
    )
}

/// Publish the `services` region. A no-op while it or the manager is not managed
/// yet. Call it without holding a manager lock: the view is built under the
/// region lock (so a racing publish never lands an older view), in the order
/// region lock, then manager locks.
pub fn publish_services<R: Runtime>(app: &AppHandle<R>) {
    let (Some(projection), Some(manager)) = (
        app.try_state::<ProjectionState>(),
        app.try_state::<Arc<EmbeddedServerManager<R>>>(),
    ) else {
        return;
    };
    projection
        .projector
        .publish_with(SERVICES_REGION, || build_services_view(&manager));
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
