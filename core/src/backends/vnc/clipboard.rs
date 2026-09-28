//! VNC clipboard state: text and — through the RFB Extended Clipboard's `dib`
//! format (#3472, PROD-021) — images.
//!
//! `vnc-rs` negotiates the Extended Clipboard pseudo-encoding and hands over
//! the server's clipboard as [`VncEvent::Text`] (UTF-8, lossless when the
//! extension is in use; the #3469 Latin-1/UTF-8 heuristic otherwise) and
//! [`VncEvent::ClipboardDib`] (raw DIB bytes, size-capped by `vnc-rs`). Images
//! are converted here, at the protocol edge, into the shared capped
//! [`ClipboardImage`] with the same bounded decoder the RDP sidecar uses.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Mutex;
use tracing::{debug, warn};
use vnc::VncEvent;

use crate::connection::clipboard_dib::dib_to_image;
use crate::connection::ClipboardImage;

/// The mirrored remote clipboard and what the server's clipboard can carry.
#[derive(Default)]
pub(super) struct VncClipboard {
    /// Latest remote clipboard text, surfaced via `get_clipboard`.
    text: Mutex<String>,
    /// Latest remote clipboard image, already validated against the caps;
    /// cleared when the remote copies text.
    image: Mutex<Option<ClipboardImage>>,
    /// The server announced `dib` through the Extended Clipboard (and this
    /// client opted into images), so images can travel both ways.
    images_supported: AtomicBool,
}

impl VncClipboard {
    /// Route a clipboard event from the driver; `false` when `event` is not one.
    pub(super) async fn on_event(&self, event: &VncEvent) -> bool {
        match event {
            VncEvent::Text(text) => {
                *self.image.lock().await = None;
                *self.text.lock().await = text.clone();
            }
            VncEvent::ClipboardCapabilities(caps) => {
                debug!(
                    text = caps.text,
                    images = caps.images,
                    "vnc server supports the extended clipboard"
                );
                self.images_supported.store(caps.images, Ordering::Release);
            }
            VncEvent::ClipboardDib(dib) => {
                let image = match dib_to_image(dib) {
                    Ok(image) => {
                        debug!(
                            width = image.width,
                            height = image.height,
                            "remote clipboard image received"
                        );
                        Some(image)
                    }
                    Err(e) => {
                        warn!(error = %e, "rejected remote clipboard image");
                        None
                    }
                };
                *self.image.lock().await = image;
            }
            _ => return false,
        }
        true
    }

    /// The remote clipboard text, `None` when empty.
    pub(super) async fn text(&self) -> Option<String> {
        let text = self.text.lock().await;
        (!text.is_empty()).then(|| text.clone())
    }

    /// The remote clipboard image, if its latest copy was one.
    pub(super) async fn image(&self) -> Option<ClipboardImage> {
        self.image.lock().await.clone()
    }

    /// Whether images travel through this session's clipboard.
    pub(super) fn images_supported(&self) -> bool {
        self.images_supported.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::clipboard_dib::{image_to_dib, MAX_DIB_BYTES};
    use vnc::ClipboardCapabilities;

    fn caps(images: bool) -> VncEvent {
        VncEvent::ClipboardCapabilities(ClipboardCapabilities { text: true, images })
    }

    #[test]
    fn the_vnc_dib_cap_matches_the_core_dib_cap() {
        assert_eq!(u64::from(vnc::MAX_CLIPBOARD_DIB_BYTES), MAX_DIB_BYTES);
    }

    #[tokio::test]
    async fn images_are_supported_only_once_the_server_announces_dib() {
        let clipboard = VncClipboard::default();
        assert!(!clipboard.images_supported());
        assert!(clipboard.on_event(&caps(true)).await);
        assert!(clipboard.images_supported());
        clipboard.on_event(&caps(false)).await;
        assert!(!clipboard.images_supported());
    }

    #[tokio::test]
    async fn a_remote_dib_becomes_a_capped_rgba_image() {
        let clipboard = VncClipboard::default();
        let image = ClipboardImage::new(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 128]).unwrap();
        let dib = image_to_dib(&image);
        assert!(clipboard.on_event(&VncEvent::ClipboardDib(dib)).await);
        assert_eq!(clipboard.image().await, Some(image));
        // Copying text replaces the image.
        clipboard.on_event(&VncEvent::Text("hi".into())).await;
        assert_eq!(clipboard.image().await, None);
        assert_eq!(clipboard.text().await.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn a_malformed_or_oversize_dib_is_rejected() {
        let clipboard = VncClipboard::default();
        // Claims 100000 x 100000 (over the per-side cap) with no pixels.
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&100_000i32.to_le_bytes());
        dib[8..12].copy_from_slice(&100_000i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        clipboard.on_event(&VncEvent::ClipboardDib(dib)).await;
        assert_eq!(clipboard.image().await, None);
        clipboard
            .on_event(&VncEvent::ClipboardDib(vec![1, 2, 3]))
            .await;
        assert_eq!(clipboard.image().await, None);
    }

    #[tokio::test]
    async fn empty_text_reads_as_none_and_other_events_are_not_consumed() {
        let clipboard = VncClipboard::default();
        assert_eq!(clipboard.text().await, None);
        assert!(!clipboard.on_event(&VncEvent::Bell).await);
    }
}
