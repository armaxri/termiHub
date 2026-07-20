//! Tauri commands for the graphical remote-desktop layer.
//!
//! Protocol-blind on purpose: these five commands drive *any* graphical backend
//! (the mock, VNC #1681, RDP #1682) through the
//! [`GraphicalSessionManager`](crate::session::graphical_manager::GraphicalSessionManager).
//! They emit `remote-desktop-frame` / `-cursor` / `-clipboard` / `-state`
//! events via the manager's event sink (`tauri::AppHandle`).

use serde_json::Value;
use tauri::State;

use termihub_core::connection::InputEvent;

use crate::session::graphical_manager::GraphicalSessionManager;
use crate::utils::errors::TerminalError;

/// Open a graphical remote-desktop session. Returns the new session id.
#[tauri::command]
pub async fn remote_desktop_connect(
    type_id: String,
    settings: Value,
    app_handle: tauri::AppHandle,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<String, TerminalError> {
    manager.connect(&type_id, settings, app_handle).await
}

/// Request a new session resolution in pixels (Match Window / dynamic resize).
#[tauri::command]
pub async fn remote_desktop_resize(
    session_id: String,
    width: u16,
    height: u16,
    app_handle: tauri::AppHandle,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.resize(&session_id, width, height, app_handle).await
}

/// Forward a protocol-agnostic input event (key / pointer / wheel).
#[tauri::command]
pub async fn remote_desktop_send_input(
    session_id: String,
    event: InputEvent,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.send_input(&session_id, event).await
}

/// Push local clipboard text to the remote.
#[tauri::command]
pub async fn remote_desktop_send_clipboard(
    session_id: String,
    text: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.send_clipboard(&session_id, text, app_handle).await
}

/// Read the remote clipboard text, if any.
#[tauri::command]
pub async fn remote_desktop_get_clipboard(
    session_id: String,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<Option<String>, TerminalError> {
    manager.get_clipboard(&session_id).await
}

/// Deliver the user's verdict for an interactive certificate-trust prompt
/// (#1767): `accept` proceeds with the untrusted server certificate, `remember`
/// persists its fingerprint so the host is trusted on future connects.
#[tauri::command]
pub async fn remote_desktop_cert_decision(
    session_id: String,
    accept: bool,
    remember: bool,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.cert_decision(&session_id, accept, remember).await
}

/// One remembered RDP host and the certificate fingerprints trusted for it,
/// for the trust-management settings UI (#1784).
#[derive(Debug, Clone, serde::Serialize)]
pub struct RdpTrustedHost {
    /// Host key (`host:port`) as stored in the trust store.
    pub host: String,
    /// SHA-256 public-key fingerprints trusted for this host.
    pub fingerprints: Vec<String>,
}

/// List every remembered RDP host and its trusted certificate fingerprints
/// (#1784), so the settings UI can show what "Accept for host" has persisted.
#[tauri::command]
pub async fn rdp_trust_list(
    manager: State<'_, GraphicalSessionManager>,
) -> Result<Vec<RdpTrustedHost>, TerminalError> {
    Ok(manager
        .trust_store()
        .entries()
        .into_iter()
        .map(|(host, fingerprints)| RdpTrustedHost { host, fingerprints })
        .collect())
}

/// Revoke remembered RDP certificate trust (#1784). With `fingerprint` set,
/// forgets just that fingerprint (dropping the host once its last one is gone);
/// without it, forgets the whole host. Either way the next connect re-prompts.
/// Returns whether anything was removed.
#[tauri::command]
pub async fn rdp_trust_forget(
    host: String,
    fingerprint: Option<String>,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<bool, TerminalError> {
    let store = manager.trust_store();
    Ok(match fingerprint {
        Some(fp) => store.forget_fingerprint(&host, &fp),
        None => store.forget_host(&host),
    })
}

/// Disconnect a graphical session and release its resources.
#[tauri::command]
pub async fn remote_desktop_disconnect(
    session_id: String,
    app_handle: tauri::AppHandle,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.disconnect(&session_id, app_handle).await
}
