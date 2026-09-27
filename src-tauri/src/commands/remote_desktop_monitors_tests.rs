//! Multi-monitor commands (#3696), driven through the helpers the Tauri
//! commands call, against the mock remote-desktop backend. No Tauri runtime is
//! needed.

use super::*;
use std::sync::Arc;

use crate::session::graphical_manager::{
    GraphicalEventSink, RemoteDesktopCertPromptEvent, RemoteDesktopClipboardEvent,
    RemoteDesktopCursorEvent, RemoteDesktopFrameEvent, RemoteDesktopStateEvent,
};
use crate::session::rdp_trust_store::RdpTrustStore;

#[derive(Clone, Default)]
struct Sink;

impl GraphicalEventSink for Sink {
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
        .connect("mock-remote-desktop", serde_json::json!({}), Sink)
        .await
        .expect("connect");
    (mgr, sid)
}

fn two_monitors() -> Vec<MonitorRect> {
    vec![
        MonitorRect {
            primary: true,
            ..MonitorRect::new(0, 0, 640, 480)
        },
        MonitorRect::new(640, 0, 640, 480),
    ]
}

#[tokio::test]
async fn the_owner_sets_the_layout_and_a_non_owner_is_dropped() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");

    let sent = gated_set_monitor_layout(&mgr, &wm, "win-1", &sid, &two_monitors())
        .await
        .expect("dropped, not failed");
    assert!(!sent, "a non-owning window never re-lays the remote");
    assert!(mgr.monitor_layout(&sid).await.expect("layout").is_empty());

    let sent = gated_set_monitor_layout(&mgr, &wm, "main", &sid, &two_monitors())
        .await
        .expect("owner layout");
    assert!(sent);
    assert_eq!(mgr.monitor_layout(&sid).await.expect("layout").len(), 2);
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

#[tokio::test]
async fn a_single_monitor_layout_is_rejected() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    assert!(matches!(
        gated_set_monitor_layout(&mgr, &wm, "main", &sid, &two_monitors()[..1]).await,
        Err(TerminalError::InvalidParams(_))
    ));
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}
