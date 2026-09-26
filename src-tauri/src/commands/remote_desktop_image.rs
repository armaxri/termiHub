//! Image clipboard for graphical remote-desktop sessions (PROD-021).
//!
//! The pixels never cross into the webview: the desktop moves an image between
//! the session's backend and the host OS clipboard itself (through
//! `tauri-plugin-clipboard-manager`'s image API), and the frontend only sees the
//! dimensions ([`ClipboardImageInfo`]) plus the two actions:
//!
//! - **copy** — write the image the remote copied onto the host clipboard;
//! - **send** — read the host clipboard's image and push it to the remote.
//!
//! Both are **window-ownership gated** exactly like the text / file clipboard
//! commands (#3388): a non-owning window reads no image, copies nothing, and
//! cannot push one. Every image is checked against the shared clipboard-image
//! caps ([`check_clipboard_image_size`]) before it is forwarded; an oversize
//! local image is refused with an error the panel surfaces, never scaled.
//! Protocol support: RDP bridges images both ways over CLIPRDR; VNC's standard
//! RFB clipboard is Latin-1 text only, so a send there reports "not supported".

use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tracing::{debug, warn};

use termihub_core::connection::{check_clipboard_image_size, ClipboardImage, ClipboardImageInfo};

use super::remote_desktop::{window_controls, GatedOp};
use crate::session::graphical_manager::GraphicalSessionManager;
use crate::utils::errors::TerminalError;
use crate::window::WindowManager;

/// Ownership-gated read of the remote's clipboard image: `None` for a
/// non-owning window, or when the remote's latest copy was not an image.
pub(crate) async fn gated_get_clipboard_image(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
) -> Result<Option<ClipboardImage>, TerminalError> {
    if !window_controls(
        window_manager,
        session_id,
        window_label,
        GatedOp::ClipboardRead,
    ) {
        return Ok(None);
    }
    manager.get_clipboard_image(session_id).await
}

/// Ownership-gated push of a local image to the remote. Returns whether it was
/// sent (`false` = dropped because another window controls the session).
pub(crate) async fn gated_send_clipboard_image(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
    image: ClipboardImage,
) -> Result<bool, TerminalError> {
    if !window_controls(
        window_manager,
        session_id,
        window_label,
        GatedOp::ClipboardSend,
    ) {
        return Ok(false);
    }
    manager.send_clipboard_image(session_id, image).await?;
    Ok(true)
}

/// Convert a host clipboard image (RGBA) into a capped [`ClipboardImage`],
/// checking the dimensions **before** copying the pixels.
pub(crate) fn host_image_to_clipboard_image(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<ClipboardImage, TerminalError> {
    let reject = |v| TerminalError::InvalidParams(format!("local clipboard image rejected: {v}"));
    check_clipboard_image_size(width, height).map_err(reject)?;
    ClipboardImage::new(width, height, rgba.to_vec()).map_err(reject)
}

/// What the clipboard panel needs to render its image section (PROD-021).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageStatus {
    /// Whether the session's protocol bridges clipboard images at all (RDP yes,
    /// VNC no) — the panel hides the image actions when it does not.
    pub supported: bool,
    /// Dimensions of the image the remote most recently copied, if any.
    pub image: Option<ClipboardImageInfo>,
}

/// The image-clipboard status the panel renders from.
pub(crate) async fn clipboard_image_status(
    manager: &GraphicalSessionManager,
    window_manager: &WindowManager,
    window_label: &str,
    session_id: &str,
) -> Result<ClipboardImageStatus, TerminalError> {
    let supported = manager.supports_clipboard_image(session_id).await?;
    let image = gated_get_clipboard_image(manager, window_manager, window_label, session_id)
        .await?
        .map(|image| image.info());
    Ok(ClipboardImageStatus { supported, image })
}

/// Whether the session supports an image clipboard, and the dimensions of the
/// image the remote most recently copied, if any.
///
/// Ownership-gated (#3388): a non-owning window never sees a remote image.
#[tauri::command]
pub async fn remote_desktop_clipboard_image_info(
    session_id: String,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<ClipboardImageStatus, TerminalError> {
    clipboard_image_status(&manager, &window_manager, window.label(), &session_id).await
}

/// Copy the image the remote most recently copied onto the host OS clipboard.
/// Returns its dimensions, or `None` when there is no remote image (or the
/// calling window does not control the session — ownership-gated, #3388).
#[tauri::command]
pub async fn remote_desktop_copy_clipboard_image(
    session_id: String,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<Option<ClipboardImageInfo>, TerminalError> {
    let Some(image) =
        gated_get_clipboard_image(&manager, &window_manager, window.label(), &session_id).await?
    else {
        return Ok(None);
    };
    let info = image.info();
    let host_image = tauri::image::Image::new_owned(image.rgba, image.width, image.height);
    app_handle
        .clipboard()
        .write_image(&host_image)
        .map_err(|e| {
            TerminalError::InternalError(format!("failed to write clipboard image: {e}"))
        })?;
    debug!(
        session_id,
        width = info.width,
        height = info.height,
        "copied remote clipboard image to the host clipboard"
    );
    Ok(Some(info))
}

/// Push the image on the host OS clipboard to the remote. Returns its
/// dimensions, or `None` when the host clipboard holds no image or the calling
/// window does not control the session (ownership-gated, #3388). Errors when the
/// image exceeds the clipboard-image caps or the protocol has no image clipboard
/// (VNC).
#[tauri::command]
pub async fn remote_desktop_send_clipboard_image(
    session_id: String,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    manager: State<'_, GraphicalSessionManager>,
    window_manager: State<'_, WindowManager>,
) -> Result<Option<ClipboardImageInfo>, TerminalError> {
    let host_image = match app_handle.clipboard().read_image() {
        Ok(image) => image,
        Err(e) => {
            debug!(error = %e, "host clipboard holds no readable image");
            return Ok(None);
        }
    };
    let image =
        host_image_to_clipboard_image(host_image.width(), host_image.height(), host_image.rgba())
            .inspect_err(|e| warn!(error = %e, "refusing to send the local clipboard image"))?;
    let info = image.info();
    let sent = gated_send_clipboard_image(
        &manager,
        &window_manager,
        window.label(),
        &session_id,
        image,
    )
    .await?;
    Ok(sent.then_some(info))
}

#[cfg(all(test, feature = "mock-remote-desktop"))]
#[path = "remote_desktop_image_tests.rs"]
mod tests;

#[cfg(test)]
mod conversion_tests {
    use super::*;
    use termihub_core::connection::MAX_CLIPBOARD_IMAGE_DIMENSION;

    #[test]
    fn host_image_within_caps_converts() {
        let image = host_image_to_clipboard_image(1, 1, &[1, 2, 3, 4]).expect("fits");
        assert_eq!(image.rgba, vec![1, 2, 3, 4]);
    }

    #[test]
    fn oversize_host_image_is_rejected() {
        assert!(matches!(
            host_image_to_clipboard_image(MAX_CLIPBOARD_IMAGE_DIMENSION + 1, 1, &[]),
            Err(TerminalError::InvalidParams(_))
        ));
        // Within the per-side cap but over the byte cap.
        assert!(matches!(
            host_image_to_clipboard_image(8192, 8192, &[]),
            Err(TerminalError::InvalidParams(_))
        ));
    }

    #[test]
    fn mismatched_host_buffer_is_rejected() {
        assert!(matches!(
            host_image_to_clipboard_image(2, 2, &[0; 4]),
            Err(TerminalError::InvalidParams(_))
        ));
    }
}
