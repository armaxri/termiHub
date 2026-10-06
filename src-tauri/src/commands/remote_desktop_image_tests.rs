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

/// The send command's body (#4088): an over-cap **host** image — within the
/// per-side cap but over the 32 MiB decoded-size cap — is refused with the cap
/// error the panel toasts, and nothing reaches the session.
#[tokio::test]
async fn an_over_cap_host_image_returns_the_cap_error_and_sends_nothing() {
    use termihub_core::connection::MAX_CLIPBOARD_IMAGE_BYTES;

    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");
    // 4097 x 2048 x 4 bytes = 33_562_624 > 32 MiB, a genuine host-sized buffer.
    let (width, height) = (4097_u32, 2048_u32);
    let bytes = u64::from(width) * u64::from(height) * 4;
    assert!(bytes > MAX_CLIPBOARD_IMAGE_BYTES);
    let rgba = vec![0_u8; usize::try_from(bytes).expect("fits in usize")];

    let err = send_host_clipboard_image(
        &mgr,
        &wm,
        "main",
        &sid,
        Some(HostClipboardImage {
            width,
            height,
            rgba: &rgba,
        }),
    )
    .await
    .expect_err("an over-cap host image is refused");
    assert!(matches!(err, TerminalError::InvalidParams(_)), "{err:?}");
    let message = err.to_string();
    assert!(
        message.contains("local clipboard image rejected")
            && message.contains(&format!("exceeds the {MAX_CLIPBOARD_IMAGE_BYTES}-byte cap")),
        "unexpected cap error: {message}"
    );
    assert_eq!(
        mgr.get_clipboard_image(&sid).await.expect("read"),
        None,
        "the refused image never reached the backend"
    );
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

/// An image over the per-side cap is refused the same way, before its pixels
/// are copied.
#[tokio::test]
async fn an_over_dimension_host_image_returns_the_cap_error_and_sends_nothing() {
    use termihub_core::connection::MAX_CLIPBOARD_IMAGE_DIMENSION;

    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");
    let width = MAX_CLIPBOARD_IMAGE_DIMENSION + 1;
    let rgba = vec![0_u8; usize::try_from(width).expect("fits") * 4];

    let err = send_host_clipboard_image(
        &mgr,
        &wm,
        "main",
        &sid,
        Some(HostClipboardImage {
            width,
            height: 1,
            rgba: &rgba,
        }),
    )
    .await
    .expect_err("an over-dimension host image is refused");
    assert!(matches!(err, TerminalError::InvalidParams(_)), "{err:?}");
    assert!(err.to_string().contains("cap"), "unexpected error: {err}");
    assert_eq!(mgr.get_clipboard_image(&sid).await.expect("read"), None);
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}

#[tokio::test]
async fn a_host_image_within_the_caps_is_sent_and_an_empty_clipboard_sends_nothing() {
    let (mgr, sid) = connected().await;
    let wm = WindowManager::new();
    wm.claim(&sid, "main");

    assert_eq!(
        send_host_clipboard_image(&mgr, &wm, "main", &sid, None)
            .await
            .expect("empty host clipboard"),
        None
    );
    assert_eq!(mgr.get_clipboard_image(&sid).await.expect("read"), None);

    let rgba = [9_u8; 8];
    let host = HostClipboardImage {
        width: 2,
        height: 1,
        rgba: &rgba,
    };
    assert_eq!(
        send_host_clipboard_image(&mgr, &wm, "win-1", &sid, Some(host))
            .await
            .expect("non-owner send"),
        None,
        "a non-owning window sends nothing"
    );
    assert_eq!(mgr.get_clipboard_image(&sid).await.expect("read"), None);

    assert_eq!(
        send_host_clipboard_image(&mgr, &wm, "main", &sid, Some(host))
            .await
            .expect("owner send"),
        Some(image().info())
    );
    assert_eq!(
        mgr.get_clipboard_image(&sid).await.expect("read"),
        Some(image())
    );
    mgr.disconnect(&sid, Sink).await.expect("disconnect");
}
