//! Owner gate on graphical tab close (#3401): a window another window took the
//! session over from must not disconnect the backend when its stale tab closes.
//! Driven through [`gated_disconnect`] against the mock remote-desktop backend.

use std::sync::Arc;

use super::gated_disconnect;
use crate::session::graphical_manager::{
    GraphicalEventSink, GraphicalSessionManager, RemoteDesktopCertPromptEvent,
    RemoteDesktopClipboardEvent, RemoteDesktopCursorEvent, RemoteDesktopFrameEvent,
    RemoteDesktopStateEvent,
};
use crate::session::rdp_trust_store::RdpTrustStore;
use crate::utils::errors::TerminalError;
use crate::window::WindowManager;

#[derive(Clone, Default)]
struct NullSink;

impl GraphicalEventSink for NullSink {
    fn emit_frame(&self, _: &RemoteDesktopFrameEvent) {}
    fn emit_cursor(&self, _: &RemoteDesktopCursorEvent) {}
    fn emit_clipboard(&self, _: &RemoteDesktopClipboardEvent) {}
    fn emit_state(&self, _: &RemoteDesktopStateEvent) {}
    fn emit_cert_prompt(&self, _: &RemoteDesktopCertPromptEvent) {}
}

async fn connected() -> (GraphicalSessionManager, String) {
    let registry = Arc::new(crate::session::registry::build_desktop_registry());
    let mgr = GraphicalSessionManager::new(registry, Arc::new(RdpTrustStore::in_memory()));
    let sid = mgr
        .connect("mock-remote-desktop", serde_json::json!({}), NullSink)
        .await
        .expect("connect");
    (mgr, sid)
}

#[tokio::test]
async fn non_owner_close_keeps_the_graphical_session_connected() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    // win-1 took the session over from main: main is evicted.
    wm.claim(&sid, "main");
    wm.claim(&sid, "win-1");

    let disconnected = gated_disconnect(&mgr, &wm, "main", &sid, NullSink)
        .await
        .expect("non-owner close");
    assert!(
        !disconnected,
        "an evicted window's close must not disconnect"
    );
    assert_eq!(
        wm.owner_of(&sid).as_deref(),
        Some("win-1"),
        "the owning window keeps its claim"
    );

    // The backend is still live: the owner's input still reaches it, and the
    // owner's own close is what finally disconnects it.
    mgr.send_input(
        &sid,
        termihub_core::connection::InputEvent::Key {
            code: "KeyA".to_string(),
            pressed: true,
        },
    )
    .await
    .expect("owner input after the evicted close");
    assert!(gated_disconnect(&mgr, &wm, "win-1", &sid, NullSink)
        .await
        .expect("owner close"));
    assert!(matches!(
        mgr.disconnect(&sid, NullSink).await,
        Err(TerminalError::SessionNotFound(_))
    ));
}

#[tokio::test]
async fn owner_or_unclaimed_close_disconnects_as_before() {
    let wm = WindowManager::new();

    // Unclaimed (single-window / pre-claim): any window's close disconnects.
    let (mgr, sid) = connected().await;
    assert!(gated_disconnect(&mgr, &wm, "main", &sid, NullSink)
        .await
        .expect("unclaimed close"));
    assert!(matches!(
        mgr.disconnect(&sid, NullSink).await,
        Err(TerminalError::SessionNotFound(_))
    ));

    // Owned: the owner's close disconnects.
    let (mgr, sid) = connected().await;
    wm.claim(&sid, "main");
    assert!(gated_disconnect(&mgr, &wm, "main", &sid, NullSink)
        .await
        .expect("owner close"));
    assert!(matches!(
        mgr.disconnect(&sid, NullSink).await,
        Err(TerminalError::SessionNotFound(_))
    ));
}
