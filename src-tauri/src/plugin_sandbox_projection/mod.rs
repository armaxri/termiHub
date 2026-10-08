//! The `plugin-sandbox` projection region (plugin OS-sandbox phase 6, #4188).
//!
//! A shared, **read-only** region that tells the UI how each native plugin's
//! sandbox is doing: the isolation the runner reported (or why its load was
//! refused), the runner's process state ("Running · 2 sessions", "Restarting",
//! "Disabled after 3 crashes") and the bridge requests the host recently
//! refused. Settings → Plugins renders its badges from it and the denial
//! toasts are raised from it, so this status is never frontend-owned state
//! (ADR-14).
//!
//! # View model
//!
//! ```json
//! {
//!   "plugins": {
//!     "<pluginId>": {
//!       "isolation": "full" | "reduced" | "unconfined" | "unavailable"
//!                    | "failed" | "runnerMissing",
//!       "enforced": ["seatbelt"], "missing": [], "detail": "…"?,
//!       "process": { "state": "running" | "idle" | "restarting" | "disabled",
//!                    "sessions": 2, "crashes": 0, "maxRestarts": 3,
//!                    "lastExit": { "kind": "crashed", …, "message": "…" }?,
//!                    "autoDisabled": "Disabled after 3 crashes"? }?,
//!       "denials": [{ "operation", "target", "reason", "atMs" }]
//!     }
//!   }
//! }
//! ```
//!
//! Every native plugin runs in a sandboxed runner (ADR-19); a plugin that is
//! neither loaded nor refused in its sandbox setup has no entry.
//!
//! # Publishing
//!
//! The state lives in the plugin host and changes on its own threads (a
//! runner crashing, being respawned or reaped, a bridge denial). Rather than
//! threading a projector through the host, a small publisher re-snapshots the
//! host every [`PUBLISH_INTERVAL`]; the projector emits a diff only when the
//! view actually changed, so an idle app sends nothing. There are no intents:
//! every action (trust, revoke, re-enable) goes through the plugin commands,
//! whose effect shows up in the next snapshot.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use termihub_core::plugin::sandbox::PluginSandboxStatus;
use termihub_core::plugin::PluginHost;

use crate::commands::projection::ProjectionState;

/// The shared region id.
pub const PLUGIN_SANDBOX_REGION: &str = "plugin-sandbox";

/// How often the publisher re-snapshots the plugin host.
pub const PUBLISH_INTERVAL: Duration = Duration::from_secs(1);

/// The region's view model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSandboxView {
    /// Per-plugin status, keyed by plugin id.
    pub plugins: BTreeMap<String, PluginSandboxStatus>,
}

/// The view for a host's current state.
#[must_use]
pub fn build_view(statuses: Vec<(String, PluginSandboxStatus)>) -> PluginSandboxView {
    PluginSandboxView {
        plugins: statuses.into_iter().collect(),
    }
}

/// The region snapshot for `host`.
#[must_use]
pub fn snapshot(host: &PluginHost) -> Value {
    let view = build_view(host.sandbox_statuses());
    serde_json::to_value(view).unwrap_or(Value::Null)
}

/// Publish the region from the managed plugin host (a no-op when either the
/// host or the projection substrate is not managed).
pub fn publish(app: &AppHandle) {
    let (Some(host), Some(projection)) = (
        app.try_state::<Arc<PluginHost>>(),
        app.try_state::<ProjectionState>(),
    ) else {
        return;
    };
    projection
        .projector
        .publish_with(PLUGIN_SANDBOX_REGION, || snapshot(&host));
}

/// Seed the region at version 0 so a subscriber attaches to a real view.
pub fn seed(app: &AppHandle, projection: &ProjectionState) {
    if let Some(host) = app.try_state::<Arc<PluginHost>>() {
        projection
            .projector
            .register_region(PLUGIN_SANDBOX_REGION, snapshot(&host));
    }
}

/// Start the background publisher (see the module docs). It runs for the
/// app's lifetime; publishing is cheap and emits nothing while nothing
/// changes.
pub fn start_publisher(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("plugin-sandbox-projection".to_owned())
        .spawn(move || loop {
            std::thread::sleep(PUBLISH_INTERVAL);
            publish(&app);
        });
    if let Err(e) = spawned {
        tracing::warn!("could not start the plugin-sandbox publisher: {e}");
    }
}

#[cfg(test)]
mod tests;
