//! Tauri commands for the graphical remote-desktop layer.
//!
//! Protocol-blind on purpose: these five commands drive *any* graphical backend
//! (the mock, VNC #1681, RDP #1682) through the
//! [`GraphicalSessionManager`](crate::session::graphical_manager::GraphicalSessionManager).
//! They emit `remote-desktop-frame` / `-cursor` / `-clipboard` / `-state`
//! events via the manager's event sink (`tauri::AppHandle`).

//!
//! # Window ownership (#3388, SM-003 single-attach for windows)
//!
//! A graphical session is controlled by exactly one window — the same
//! `session → window` map ([`WindowManager`]) that gates terminal input and
//! resize (#3368). Every command that *drives* the session or *reads its
//! content* is gated here, in the command layer, with
//! [`WindowManager::may_send_input`] / [`WindowManager::may_resize`]:
//!
//! - **input** (key / pointer / wheel) and **resize** from a non-owning window
//!   are dropped (`Ok(())`, like `commands::session::send_input`);
//! - **clipboard** is gated in *both* directions — a non-owner can neither push
//!   text to the remote nor read the remote clipboard (text or surfaced files).
//!
//! An unclaimed session accepts every window (single-window / pre-claim). The
//! evicted window shows "Taken over by another window" + Reclaim; nothing
//! reclaims automatically. Frame / cursor / clipboard events are emitted only to
//! the owner (see `graphical_manager`'s `emit_owner_scoped`), so an evicted
//! canvas freezes on its last frame until Reclaim requests a full frame.

use serde_json::Value;
use tauri::State;
use tracing::debug;

use termihub_core::connection::{InputEvent, RemoteClipboardFile};

use crate::session::graphical_manager::{GraphicalEventSink, GraphicalSessionManager};
use crate::utils::errors::TerminalError;
use crate::window::WindowManager;

/// The graphical operation being ownership-gated (#3388), for the rule and log.
#[derive(Debug, Clone, Copy)]
enum GatedOp {
    Input,
    Resize,
    ClipboardSend,
    ClipboardRead,
}

/// Whether `window_label` controls `session_id` (unclaimed → any window;
/// claimed → owner only), logging the drop when it does not.
fn window_controls(
    window_manager: &WindowManager,
    session_id: &str,
    window_label: &str,
    op: GatedOp,
) -> bool {
    let allowed = match op {
        GatedOp::Resize => window_manager.may_resize(session_id, window_label),
        // Clipboard is session input/content: same single-owner rule as input.
        GatedOp::Input | GatedOp::ClipboardSend | GatedOp::ClipboardRead => {
            window_manager.may_send_input(session_id, window_label)
        }
    };
    if !allowed {
        debug!(
            session_id,
            window = window_label,
            op = ?op,
            "Dropping graphical command from non-owning (evicted) window (#3388)"
        );
    }
    allowed
}

/// Ownership-gated input forward. Returns whether the event was forwarded
/// (`false` = dropped because another window controls the session).
pub(crate) async fn gated_send_input(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    event: InputEvent,
) -> Result<bool, TerminalError> {
    if !window_controls(window_manager, session_id, window_label, GatedOp::Input) {
        return Ok(false);
    }
    manager
        .send_input_from(session_id, Some(window_label), event)
        .await?;
    Ok(true)
}

/// Ownership-gated release-all (#3402): synthesise key-up / button-up for
/// everything held on the remote. Sent by the controlling window when its
/// canvas or window loses focus. Returns the number of release events sent
/// (0 when dropped for a non-owner, or when nothing was held).
pub(crate) async fn gated_release_input(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
) -> Result<usize, TerminalError> {
    if !window_controls(window_manager, session_id, window_label, GatedOp::Input) {
        return Ok(0);
    }
    manager.release_held_input(session_id, None).await
}

/// Release what the *previous* controller left held on a graphical session's
/// remote once `new_owner` has claimed it (#3402). The evicted window can no
/// longer send (its input is gated off), so the backend releases on its behalf;
/// input `new_owner` itself holds is kept. A non-graphical (terminal) session id
/// is a silent no-op. Returns the number of release events sent.
pub(crate) async fn release_on_takeover(
    manager: &GraphicalSessionManager,
    session_id: &str,
    new_owner: &str,
) -> usize {
    match manager
        .release_held_input(session_id, Some(new_owner))
        .await
    {
        Ok(released) => {
            if released > 0 {
                debug!(
                    session_id,
                    new_owner, released, "released held graphical input on takeover (#3402)"
                );
            }
            released
        }
        // Not a graphical session (the claim was for a terminal): nothing held.
        Err(_) => 0,
    }
}

/// Ownership-gated resize. Returns whether the resize was forwarded.
pub(crate) async fn gated_resize(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    width: u16,
    height: u16,
    sink: impl GraphicalEventSink,
) -> Result<bool, TerminalError> {
    if !window_controls(window_manager, session_id, window_label, GatedOp::Resize) {
        return Ok(false);
    }
    manager.resize(session_id, width, height, sink).await?;
    Ok(true)
}

/// Ownership-gated local → remote clipboard push. Returns whether it was sent.
pub(crate) async fn gated_send_clipboard(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    text: String,
    sink: impl GraphicalEventSink,
) -> Result<bool, TerminalError> {
    if !window_controls(
        window_manager,
        session_id,
        window_label,
        GatedOp::ClipboardSend,
    ) {
        return Ok(false);
    }
    manager.send_clipboard(session_id, text, sink).await?;
    Ok(true)
}

/// Ownership-gated remote clipboard read: a non-owning window reads `None`.
pub(crate) async fn gated_get_clipboard(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
) -> Result<Option<String>, TerminalError> {
    if !window_controls(
        window_manager,
        session_id,
        window_label,
        GatedOp::ClipboardRead,
    ) {
        return Ok(None);
    }
    manager.get_clipboard(session_id).await
}

/// Ownership-gated listing of the remote's copied files: empty for a non-owner.
pub(crate) async fn gated_remote_clipboard_files(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
) -> Result<Vec<RemoteClipboardFile>, TerminalError> {
    if !window_controls(
        window_manager,
        session_id,
        window_label,
        GatedOp::ClipboardRead,
    ) {
        return Ok(Vec::new());
    }
    manager.remote_clipboard_files(session_id).await
}

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
///
/// Ownership-gated (#3388): dropped unless the calling window controls the session.
pub async fn remote_desktop_resize(
    session_id: String,
    width: u16,
    height: u16,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_resize(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        width,
        height,
        app_handle,
    )
    .await
    .map(|_| ())
}

/// Ask the backend to re-emit a full framebuffer frame.
///
/// Invoked when a graphical tab is moved into another window (#1904): the
/// destination canvas is blank until the next full frame, so this forces a
/// prompt repaint. The frame flows out on `remote-desktop-frame` as usual.
#[tauri::command]
pub async fn remote_desktop_request_full_frame(
    session_id: String,
    manager: State<'_, GraphicalSessionManager>,
) -> Result<(), TerminalError> {
    manager.request_full_frame(&session_id).await
}

/// Forward a protocol-agnostic input event (key / pointer / wheel).
///
/// Ownership-gated (#3388): input from a window another window has taken the
/// session over from is dropped, so an evicted window never drives the desktop.
#[tauri::command]
pub async fn remote_desktop_send_input(
    session_id: String,
    event: InputEvent,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_send_input(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        event,
    )
    .await
    .map(|_| ())
}

/// Release every key / mouse button held on the remote (#3402).
///
/// Invoked by the controlling window when its canvas or window loses focus or
/// is hidden, so a key-up the canvas never saw cannot leave a key stuck.
/// Ownership-gated: a non-owning window cannot release the owner's input.
#[tauri::command]
pub async fn remote_desktop_release_input(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_release_input(&manager, &window_manager, window.label(), &session_id)
        .await
        .map(|_| ())
}

/// Push local clipboard text to the remote.
///
/// Ownership-gated (#3388): dropped unless the calling window controls the session.
#[tauri::command]
pub async fn remote_desktop_send_clipboard(
    session_id: String,
    text: String,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_send_clipboard(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        text,
        app_handle,
    )
    .await
    .map(|_| ())
}

/// Read the remote clipboard text, if any.
///
/// Ownership-gated (#3388): a non-owning window reads `None` — the remote
/// clipboard is session content and only the controlling window may see it.
#[tauri::command]
pub async fn remote_desktop_get_clipboard(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<Option<String>, TerminalError> {
    gated_get_clipboard(&manager, &window_manager, window.label(), &session_id).await
}

/// List the files the remote most recently copied to its clipboard, surfaced for
/// a local paste with delayed rendering (#1804).
///
/// Empty on any platform without an OS-clipboard delayed-render binding (the
/// sidecar keeps eagerly downloading into the shared folder there), or when the
/// remote copied text/an image/nothing. The bytes are fetched later, only when
/// the user actually pastes — see [`remote_desktop_bind_clipboard_files`].
/// Ownership-gated (#3388): empty for a non-owning window.
#[tauri::command]
pub async fn remote_desktop_remote_clipboard_files(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<Vec<RemoteClipboardFile>, TerminalError> {
    gated_remote_clipboard_files(&manager, &window_manager, window.label(), &session_id).await
}

/// Bind the remote-copied clipboard files onto the host OS clipboard so they can
/// be pasted into any local app (#1804). Returns the number of files bound.
///
/// The bytes are **not** fetched here: this installs a delayed-render promise on
/// the OS clipboard, and each file's bytes are streamed from the remote via
/// [`GraphicalSessionManager::fetch_remote_clipboard_file`] only when the user
/// actually pastes (on macOS, the `NSPasteboard` `provideDataForType:` callback).
/// Returns `0` when the remote copied no pasteable files, and errors on a
/// platform without a native binding. Ownership-gated (#3388): a non-owning
/// window binds nothing (`0`), so it can never pull the remote's files.
#[tauri::command]
pub async fn remote_desktop_bind_clipboard_files(
    session_id: String,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<usize, TerminalError> {
    // Only regular files carry bytes to fetch; directories are surfaced only so a
    // copied tree can be rebuilt and are not offered to the OS clipboard here.
    let files: Vec<RemoteClipboardFile> =
        gated_remote_clipboard_files(&manager, &window_manager, window.label(), &session_id)
            .await?
            .into_iter()
            .filter(|f| !f.is_dir)
            .collect();
    if files.is_empty() {
        return Ok(0);
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        let count = files.len();
        #[cfg(target_os = "macos")]
        crate::macos_clipboard::bind_remote_clipboard_files(
            &app_handle,
            (*manager).clone(),
            session_id,
            files,
        )
        .map_err(|e| TerminalError::InternalError(e.to_string()))?;
        #[cfg(target_os = "linux")]
        crate::linux_clipboard::bind_remote_clipboard_files(
            &app_handle,
            (*manager).clone(),
            session_id,
            files,
        )
        .map_err(|e| TerminalError::InternalError(e.to_string()))?;
        #[cfg(windows)]
        crate::windows_clipboard::bind_remote_clipboard_files(
            &app_handle,
            (*manager).clone(),
            session_id,
            files,
        )
        .map_err(|e| TerminalError::InternalError(e.to_string()))?;
        Ok(count)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        // No native OS-clipboard binding on this platform: with delayed rendering
        // off, `remote_clipboard_files` is already empty and we returned above, so
        // reaching here means a caller invoked the command anyway. Report rather
        // than silently succeed. (`app_handle`/`session_id` are binding-only inputs.)
        let _ = (&app_handle, &session_id);
        Err(TerminalError::InternalError(
            "pasting remote clipboard files to the host OS clipboard is not supported on this \
             platform yet"
                .to_string(),
        ))
    }
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
///
/// Only the controlling window tears the session down (#3401): the call from a
/// window another window has taken the session over from (its tab shows "Taken
/// over by another window") is a stale view closing, so it is a no-op and the
/// owning window keeps its live desktop. See [`WindowManager::may_close`].
#[tauri::command]
pub async fn remote_desktop_disconnect(
    session_id: String,
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<(), TerminalError> {
    gated_disconnect(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        app_handle,
    )
    .await
    .map(|_| ())
}

/// The owner-gated body of [`remote_desktop_disconnect`] (#3401). Returns
/// whether the session was disconnected (`false` = kept for the owning window).
pub(crate) async fn gated_disconnect(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    sink: impl GraphicalEventSink,
) -> Result<bool, TerminalError> {
    if !window_manager.may_close(session_id, window_label) {
        tracing::info!(
            session_id,
            window = window_label,
            "Graphical tab closed in a non-owning window; keeping the session (#3401)"
        );
        return Ok(false);
    }
    manager.disconnect(session_id, sink).await.map(|()| true)
}

#[cfg(all(test, feature = "mock-remote-desktop"))]
#[path = "remote_desktop_close_tests.rs"]
mod close_tests;

#[cfg(all(test, feature = "mock-remote-desktop"))]
mod tests {
    //! Window-ownership gates on the graphical commands (#3388), driven through
    //! the same `gated_*` helpers the Tauri commands call, against the mock
    //! remote-desktop backend (no Tauri runtime needed).
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    use crate::session::graphical_manager::{
        RemoteDesktopCertPromptEvent, RemoteDesktopClipboardEvent, RemoteDesktopCursorEvent,
        RemoteDesktopFrameEvent, RemoteDesktopStateEvent,
    };
    use crate::session::rdp_trust_store::RdpTrustStore;
    use crate::window::OutputEmitTarget;

    #[derive(Clone, Default)]
    struct Sink {
        states: Arc<StdMutex<usize>>,
        clipboards: Arc<StdMutex<Vec<String>>>,
    }

    impl GraphicalEventSink for Sink {
        fn emit_frame(&self, _: &RemoteDesktopFrameEvent) {}
        fn emit_cursor(&self, _: &RemoteDesktopCursorEvent) {}
        fn emit_clipboard(&self, event: &RemoteDesktopClipboardEvent) {
            self.clipboards
                .lock()
                .expect("clipboard log")
                .push(event.text.clone());
        }
        fn emit_state(&self, _: &RemoteDesktopStateEvent) {
            *self.states.lock().expect("state count") += 1;
        }
        fn emit_cert_prompt(&self, _: &RemoteDesktopCertPromptEvent) {}
    }

    async fn connected() -> (GraphicalSessionManager, Sink, String) {
        let registry = Arc::new(crate::session::registry::build_desktop_registry());
        let mgr = GraphicalSessionManager::new(registry, Arc::new(RdpTrustStore::in_memory()));
        let sink = Sink::default();
        let sid = mgr
            .connect("mock-remote-desktop", serde_json::json!({}), sink.clone())
            .await
            .expect("connect");
        (mgr, sink, sid)
    }

    fn key() -> InputEvent {
        InputEvent::Key {
            code: "KeyA".to_string(),
            pressed: true,
        }
    }

    #[tokio::test]
    async fn non_owner_input_resize_and_clipboard_are_rejected() {
        let (mgr, sink, sid) = connected().await;
        let wm = WindowManager::new();
        wm.claim(&sid, "main");

        // Input: owner forwards, the evicted window is dropped.
        assert!(gated_send_input(&mgr, &wm, "main", &sid, key())
            .await
            .expect("owner input"));
        assert!(
            !gated_send_input(&mgr, &wm, "win-1", &sid, key())
                .await
                .expect("non-owner input"),
            "a non-owning window's graphical input is dropped"
        );

        // Resize: a dropped resize never reaches the backend (no Resizing state).
        let before = *sink.states.lock().expect("states");
        assert!(
            !gated_resize(&mgr, &wm, "win-1", &sid, 800, 600, sink.clone())
                .await
                .expect("non-owner resize"),
            "a non-owning window's resize is dropped"
        );
        assert_eq!(
            *sink.states.lock().expect("states"),
            before,
            "a dropped resize emits no lifecycle state"
        );
        assert!(
            gated_resize(&mgr, &wm, "main", &sid, 800, 600, sink.clone())
                .await
                .expect("owner resize")
        );

        // Clipboard push: only the owner's text lands on the remote.
        assert!(
            gated_send_clipboard(&mgr, &wm, "main", &sid, "owner".into(), sink.clone())
                .await
                .expect("owner clipboard")
        );
        assert!(
            !gated_send_clipboard(&mgr, &wm, "win-1", &sid, "intruder".into(), sink.clone())
                .await
                .expect("non-owner clipboard"),
            "a non-owning window cannot push clipboard text"
        );
        assert_eq!(
            *sink.clipboards.lock().expect("clipboards"),
            vec!["owner".to_string()],
            "the dropped push is not echoed either"
        );

        // Clipboard read: the owner sees the remote clipboard, the non-owner does not.
        assert_eq!(
            gated_get_clipboard(&mgr, &wm, "main", &sid)
                .await
                .expect("owner read"),
            Some("owner".to_string())
        );
        assert_eq!(
            gated_get_clipboard(&mgr, &wm, "win-1", &sid)
                .await
                .expect("non-owner read"),
            None,
            "a non-owning window cannot read the remote clipboard"
        );
        assert!(gated_remote_clipboard_files(&mgr, &wm, "win-1", &sid)
            .await
            .expect("non-owner files")
            .is_empty());

        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }

    #[tokio::test]
    async fn unclaimed_graphical_session_accepts_any_window() {
        // Single-window / pre-claim: no owner → every window may drive it.
        let (mgr, sink, sid) = connected().await;
        let wm = WindowManager::new();
        for label in ["main", "win-1"] {
            assert!(gated_send_input(&mgr, &wm, label, &sid, key())
                .await
                .expect("input"));
            assert!(gated_resize(&mgr, &wm, label, &sid, 640, 480, sink.clone())
                .await
                .expect("resize"));
        }
        assert_eq!(wm.output_target(&sid), OutputEmitTarget::Broadcast);
        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }

    #[tokio::test]
    async fn two_window_claim_flip_moves_graphical_control_and_frames() {
        // A owns → B takes over (A evicted) → A reclaims (B evicted). At every
        // step exactly one window drives the session and receives its frames.
        let (mgr, sink, sid) = connected().await;
        let wm = WindowManager::new();

        let steps = [("main", "win-1"), ("win-1", "main"), ("main", "win-1")];
        for (owner, evicted) in steps {
            wm.claim(&sid, owner);
            assert!(gated_send_input(&mgr, &wm, owner, &sid, key())
                .await
                .expect("owner input"));
            assert!(!gated_send_input(&mgr, &wm, evicted, &sid, key())
                .await
                .expect("evicted input"));
            assert!(
                !gated_send_clipboard(&mgr, &wm, evicted, &sid, "x".into(), sink.clone())
                    .await
                    .expect("evicted clipboard")
            );
            assert_eq!(
                wm.output_target(&sid),
                OutputEmitTarget::Window(owner.to_string()),
                "frames / cursor / clipboard are emitted only to the controlling window"
            );
        }
        mgr.disconnect(&sid, sink).await.expect("disconnect");
    }
}
