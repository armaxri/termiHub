//! Tauri commands backing the **Show Connection Path** popover's live per-hop
//! status (#962).
//!
//! Opening the popover for an SSH connection with a jump-host chain starts a
//! *probe*: it walks the full path — every gateway hop in order, then the target
//! — using the same per-hop connect primitives as the real connect path
//! ([`termihub_core::backends::ssh::jump_host::probe_connection_path`]), and
//! streams each node's status (`connecting` → `connected` / `failed`) back to the
//! frontend as `jump-host-hop-status` events keyed by a caller-supplied
//! `probe_id`. A final `jump-host-probe-complete` event marks the run finished.
//!
//! The probe opens no lasting session: it tears its connections down on return,
//! so it is a transient reachability/auth check, not a connect. Closing the
//! popover cancels an in-flight probe via [`cancel_connection_path_probe`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use termihub_core::backends::ssh::jump_host::{probe_connection_path, HopProgress, HopStatus};
use termihub_core::config::SshConfig;

use crate::connection::manager::ConnectionManager;
use crate::utils::errors::TerminalError;

/// Event emitted for each per-hop status transition during a probe.
///
/// `index`/`total` map the update onto the rendered chain (gateway hops first,
/// the target last); `status` is one of `connecting`, `connected`, `failed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HopStatusEvent {
    probe_id: String,
    index: usize,
    total: usize,
    host: String,
    port: u16,
    status: String,
    /// Failure reason for a `failed` status; empty otherwise.
    message: String,
}

/// Event emitted once when a probe finishes (whether it fully succeeded or
/// stopped at a failed hop).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeCompleteEvent {
    probe_id: String,
    /// `true` when every node was reached; `false` when a hop failed.
    success: bool,
}

const EVENT_HOP_STATUS: &str = "jump-host-hop-status";
const EVENT_PROBE_COMPLETE: &str = "jump-host-probe-complete";

/// Maps a [`HopStatus`] to the lowercase string the frontend renders.
fn status_str(status: HopStatus) -> &'static str {
    match status {
        HopStatus::Connecting => "connecting",
        HopStatus::Connected => "connected",
        HopStatus::Failed => "failed",
    }
}

/// Registry of in-flight connection-path probes, keyed by `probe_id`, so the
/// popover can cancel a probe when it closes (#962). Managed Tauri state.
///
/// The inner map is `Arc`-shared so a spawned probe task can hold its own handle
/// and remove its entry on completion without needing a reference to the Tauri
/// state.
#[derive(Default, Clone)]
pub struct ProbeRegistry {
    active: Arc<Mutex<HashMap<String, Arc<CancellationToken>>>>,
}

impl ProbeRegistry {
    /// Register a probe and return its cancellation token, replacing any prior
    /// probe under the same id (cancelling it first). The returned `Arc` is the
    /// stored instance, so [`complete`](Self::complete) can identity-match it.
    fn register(&self, probe_id: &str) -> Arc<CancellationToken> {
        let token = Arc::new(CancellationToken::new());
        if let Ok(mut map) = self.active.lock() {
            if let Some(prev) = map.insert(probe_id.to_string(), token.clone()) {
                prev.cancel();
            }
        }
        token
    }

    /// Cancel an in-flight probe. Returns `true` if one was registered.
    fn cancel(&self, probe_id: &str) -> bool {
        let token = self
            .active
            .lock()
            .ok()
            .and_then(|map| map.get(probe_id).cloned());
        match token {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Drop a probe's entry once it finishes — but only when the registry still
    /// holds *this* token instance, so a probe re-registered under the same id is
    /// left untouched.
    fn complete(&self, probe_id: &str, token: &Arc<CancellationToken>) {
        if let Ok(mut map) = self.active.lock() {
            if map
                .get(probe_id)
                .is_some_and(|stored| Arc::ptr_eq(stored, token))
            {
                map.remove(probe_id);
            }
        }
    }
}

/// Start a live probe of an SSH connection's full path (jump-host hops + target).
///
/// `settings` is the SSH connection's config object (the same JSON
/// [`crate::commands::session::create_connection`] receives); saved-connection
/// jump-host references are resolved to inline hops first. Per-hop status streams
/// back as `jump-host-hop-status` events and a `jump-host-probe-complete` event
/// closes the run, all keyed by `probe_id`. Returns immediately; the probe runs
/// in the background and tears its connections down when finished.
#[tauri::command]
pub async fn probe_connection_path_cmd(
    probe_id: String,
    mut settings: Value,
    registry: State<'_, ProbeRegistry>,
    conn_manager: State<'_, ConnectionManager>,
    app_handle: AppHandle,
) -> Result<(), TerminalError> {
    info!(probe_id, "Probing connection path");

    // Resolve saved-connection jump-host references to inline hops before parsing
    // (core only connects with inline hops) — mirrors create_connection (#940).
    conn_manager
        .resolve_jump_host_refs(&mut settings, None)
        .map_err(|e| TerminalError::ConnectionFailed(e.to_string()))?;

    let target: SshConfig = serde_json::from_value(settings)
        .map_err(|e| TerminalError::ConnectionFailed(format!("Invalid SSH config: {e}")))?;
    let target = target.expand();

    let token = registry.register(&probe_id);
    // A cheap clone (Arc inside) the spawned task can keep to clear its entry.
    let registry_handle: ProbeRegistry = registry.inner().clone();

    tokio::spawn(async move {
        let probe_token = token.clone();
        let mut on_progress = {
            let app = app_handle.clone();
            let probe_id = probe_id.clone();
            move |p: HopProgress| {
                let _ = app.emit(
                    EVENT_HOP_STATUS,
                    HopStatusEvent {
                        probe_id: probe_id.clone(),
                        index: p.index,
                        total: p.total,
                        host: p.host,
                        port: p.port,
                        status: status_str(p.status).to_string(),
                        message: p.message,
                    },
                );
            }
        };

        let result =
            probe_connection_path(&target, Some(probe_token.as_ref()), &mut on_progress).await;

        let success = result.is_ok();
        debug!(probe_id, success, "Connection path probe finished");
        let _ = app_handle.emit(
            EVENT_PROBE_COMPLETE,
            ProbeCompleteEvent {
                probe_id: probe_id.clone(),
                success,
            },
        );

        // Clear our entry so a later cancel targets only live probes (no-op if a
        // newer probe already replaced this id).
        registry_handle.complete(&probe_id, &probe_token);
    });

    Ok(())
}

/// Cancel an in-flight connection-path probe by its `probe_id`.
///
/// Fired when the **Show Connection Path** popover closes so an in-progress probe
/// aborts its handshakes promptly instead of finishing against a dialog nobody is
/// watching. No-op if the probe already finished. Returns whether one was active.
#[tauri::command]
pub fn cancel_connection_path_probe(
    probe_id: String,
    registry: State<'_, ProbeRegistry>,
) -> Result<bool, TerminalError> {
    debug!(probe_id, "Cancelling connection path probe");
    Ok(registry.cancel(&probe_id))
}
