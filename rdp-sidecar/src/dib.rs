//! DIB ↔ RGBA conversion for the CLIPRDR image clipboard (PROD-021).
//!
//! The converter moved to `termihub_core::connection::clipboard_dib` (#3472) so
//! the VNC backend's Extended Clipboard `dib` format shares the same bounded
//! decoder; this module re-exports it for the sidecar.

pub use termihub_core::connection::clipboard_dib::{dib_to_image, image_to_dib};
