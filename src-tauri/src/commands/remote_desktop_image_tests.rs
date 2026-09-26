//! Window-ownership gates on the image-clipboard commands (PROD-021, #3388),
//! driven through the `gated_*` helpers the Tauri commands call, against the
//! mock remote-desktop backend (which echoes a pushed image back as the remote
//! image). No Tauri runtime is needed.

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

fn image() -> ClipboardImage {
    ClipboardImage::new(2, 1, vec![9; 8]).expect("valid image")
}

#[tokio::test]
async fn only_the_owner_can_push_or_read_a_clipboard_image() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");

    assert!(
        !gated_send_clipboard_image(&mgr, &wm, "win-1", &sid, image())
            .await
            .expect("non-owner push"),
        "a non-owning window cannot push an image"
    );
    assert_eq!(
        mgr.get_clipboard_image(&sid).await.expect("read"),
        None,
        "the dropped push never reached the backend"
    );

    assert!(gated_send_clipboard_image(&mgr, &wm, "main", &sid, image())
        .await
        .expect("owner push"));
    assert_eq!(
        gated_get_clipboard_image(&mgr, &wm, "main", &sid)
            .await
            .expect("owner read"),
        Some(image())
    );
    assert_eq!(
        gated_get_clipboard_image(&mgr, &wm, "win-1", &sid)
            .await
            .expect("non-owner read"),
        None,
        "a non-owning window cannot read the remote image"
    );
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

#[tokio::test]
async fn status_reports_support_and_gates_the_image_for_non_owners() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");
    let empty = clipboard_image_status(&mgr, &wm, "main", &sid)
        .await
        .expect("status");
    assert_eq!(
        empty,
        ClipboardImageStatus {
            supported: true,
            image: None
        }
    );
    gated_send_clipboard_image(&mgr, &wm, "main", &sid, image())
        .await
        .expect("owner push");
    let owner = clipboard_image_status(&mgr, &wm, "main", &sid)
        .await
        .expect("status");
    assert_eq!(owner.image, Some(image().info()));
    let intruder = clipboard_image_status(&mgr, &wm, "win-1", &sid)
        .await
        .expect("status");
    assert_eq!(intruder.image, None, "a non-owner never sees the image");
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

#[tokio::test]
async fn an_invalid_image_is_rejected_before_reaching_the_backend() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    let bogus = ClipboardImage {
        width: 8192,
        height: 8192,
        rgba: vec![0; 4],
    };
    assert!(matches!(
        gated_send_clipboard_image(&mgr, &wm, "main", &sid, bogus).await,
        Err(TerminalError::InvalidParams(_))
    ));
    assert_eq!(mgr.get_clipboard_image(&sid).await.expect("read"), None);
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

#[tokio::test]
async fn unknown_session_reports_not_found() {
    let (mgr, sid) = connected().await;
    assert!(mgr.get_clipboard_image("nope").await.is_err());
    assert!(mgr.send_clipboard_image("nope", image()).await.is_err());
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}
