//! Shared clipboard-image payload and bounds for graphical sessions (PROD-021).
//!
//! A remote-desktop clipboard image travels between the protocol backend (the
//! RDP sidecar's CLIPRDR channel) and the desktop's OS clipboard as a
//! [`ClipboardImage`]: tightly-packed, row-major, top-down **RGBA**, the same
//! pixel contract as [`DirtyRect`](super::DirtyRect). Protocol encodings (RDP
//! `CF_DIB` / `CF_DIBV5`) are converted at the protocol edge; everything past it
//! is protocol-blind.
//!
//! ## Bounds (same philosophy as the frame bounds guard)
//!
//! Clipboard images are **untrusted** in both directions: the remote chooses the
//! dimensions of what it copied, and a local clipboard image is whatever another
//! local application placed there. Every image is therefore checked against
//! [`MAX_CLIPBOARD_IMAGE_DIMENSION`] (per side) and [`MAX_CLIPBOARD_IMAGE_BYTES`]
//! (decoded RGBA size) **before** any pixel buffer is allocated at the protocol
//! edge, and re-validated by [`ClipboardImage::validate`] wherever one crosses a
//! trust boundary (sidecar → desktop IPC, OS clipboard → session). An image over
//! either cap is rejected and logged, never truncated or scaled.

use serde::{Deserialize, Serialize};

use super::graphical::{rgba_len, MAX_FRAMEBUFFER_DIMENSION};

/// Upper bound on either clipboard-image dimension, in pixels. Shares the
/// framebuffer cap: nothing a remote desktop can legitimately show is larger.
pub const MAX_CLIPBOARD_IMAGE_DIMENSION: u32 = MAX_FRAMEBUFFER_DIMENSION;

/// Upper bound on a clipboard image's decoded RGBA size, in bytes (32 MiB).
///
/// Fits a full 4K UHD screenshot (3840 × 2160 × 4 ≈ 31.6 MiB) while keeping a
/// single image — MessagePack-encoded for the sidecar IPC, where a byte array can
/// cost up to two bytes per byte — comfortably under the IPC frame cap. Larger
/// images are rejected rather than scaled.
pub const MAX_CLIPBOARD_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// A clipboard image: tightly-packed, row-major, top-down RGBA
/// (`width * height * 4` bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// RGBA pixel data, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
}

/// Metadata of a clipboard image, surfaced to the frontend (which never needs
/// the pixels — the desktop moves them between the session and the OS
/// clipboard itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageInfo {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// Why a clipboard image was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClipboardImageViolation {
    /// A dimension was zero.
    #[error("clipboard image has a zero dimension ({width}x{height})")]
    ZeroDimension {
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
    },
    /// A dimension exceeded [`MAX_CLIPBOARD_IMAGE_DIMENSION`].
    #[error(
        "clipboard image {width}x{height} exceeds the {max}x{max} cap",
        max = MAX_CLIPBOARD_IMAGE_DIMENSION
    )]
    Oversize {
        /// Width in pixels.
        width: u32,
        /// Height in pixels.
        height: u32,
    },
    /// The decoded RGBA size exceeded [`MAX_CLIPBOARD_IMAGE_BYTES`].
    #[error(
        "clipboard image of {bytes} bytes exceeds the {max}-byte cap",
        max = MAX_CLIPBOARD_IMAGE_BYTES
    )]
    TooLarge {
        /// Decoded RGBA byte size.
        bytes: u64,
    },
    /// `rgba.len()` did not equal `width * height * 4`.
    #[error("clipboard image data length {actual} does not match {expected}")]
    LengthMismatch {
        /// Actual byte length.
        actual: usize,
        /// Expected byte length (`width * height * 4`).
        expected: u64,
    },
}

/// Check `width × height` against the clipboard-image caps and return the RGBA
/// byte length it would need. Call this **before** allocating a pixel buffer for
/// an untrusted image.
pub fn check_clipboard_image_size(width: u32, height: u32) -> Result<u64, ClipboardImageViolation> {
    if width == 0 || height == 0 {
        return Err(ClipboardImageViolation::ZeroDimension { width, height });
    }
    if width > MAX_CLIPBOARD_IMAGE_DIMENSION || height > MAX_CLIPBOARD_IMAGE_DIMENSION {
        return Err(ClipboardImageViolation::Oversize { width, height });
    }
    // Both sides are ≤ 8192 here, so this cannot overflow; stay checked anyway.
    let bytes =
        rgba_len(width, height).ok_or(ClipboardImageViolation::Oversize { width, height })?;
    if bytes > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(ClipboardImageViolation::TooLarge { bytes });
    }
    Ok(bytes)
}

impl ClipboardImage {
    /// Build a validated image; rejects anything [`Self::validate`] would.
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Self, ClipboardImageViolation> {
        let image = Self {
            width,
            height,
            rgba,
        };
        image.validate()?;
        Ok(image)
    }

    /// Check the dimensions against the caps and the buffer length against
    /// `width * height * 4`.
    pub fn validate(&self) -> Result<(), ClipboardImageViolation> {
        let expected = check_clipboard_image_size(self.width, self.height)?;
        if self.rgba.len() as u64 != expected {
            return Err(ClipboardImageViolation::LengthMismatch {
                actual: self.rgba.len(),
                expected,
            });
        }
        Ok(())
    }

    /// The image's dimensions, for surfacing to the frontend.
    pub fn info(&self) -> ClipboardImageInfo {
        ClipboardImageInfo {
            width: self.width,
            height: self.height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_well_formed_image() {
        let img = ClipboardImage::new(2, 3, vec![0; 2 * 3 * 4]).unwrap();
        assert_eq!(
            img.info(),
            ClipboardImageInfo {
                width: 2,
                height: 3
            }
        );
    }

    #[test]
    fn rejects_zero_dimensions() {
        assert_eq!(
            check_clipboard_image_size(0, 10),
            Err(ClipboardImageViolation::ZeroDimension {
                width: 0,
                height: 10
            })
        );
    }

    #[test]
    fn rejects_a_dimension_over_the_cap() {
        assert_eq!(
            check_clipboard_image_size(MAX_CLIPBOARD_IMAGE_DIMENSION + 1, 1),
            Err(ClipboardImageViolation::Oversize {
                width: MAX_CLIPBOARD_IMAGE_DIMENSION + 1,
                height: 1
            })
        );
        assert!(check_clipboard_image_size(u32::MAX, u32::MAX).is_err());
    }

    #[test]
    fn rejects_an_image_over_the_byte_cap() {
        // 8192 × 8192 passes the per-side cap but is 256 MiB of RGBA.
        assert_eq!(
            check_clipboard_image_size(8192, 8192),
            Err(ClipboardImageViolation::TooLarge {
                bytes: 8192 * 8192 * 4
            })
        );
    }

    #[test]
    fn a_4k_screenshot_fits() {
        assert_eq!(check_clipboard_image_size(3840, 2160), Ok(3840 * 2160 * 4));
    }

    #[test]
    fn rejects_a_length_mismatch() {
        assert_eq!(
            ClipboardImage::new(2, 2, vec![0; 15]),
            Err(ClipboardImageViolation::LengthMismatch {
                actual: 15,
                expected: 16
            })
        );
    }
}
