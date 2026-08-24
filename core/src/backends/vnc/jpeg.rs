//! JPEG sub-rect decoding for the VNC **Tight** encoding.
//!
//! Tight (#1715) is the most bandwidth-efficient common RFB encoding. Its
//! photographic rectangles are compressed as baseline JPEG, which `vnc-rs`
//! surfaces as [`VncEvent::JpegImage`](vnc::VncEvent::JpegImage) carrying the raw
//! JPEG byte stream. Unlike the other encodings, the negotiated RFB pixel format
//! does **not** apply to these bytes — a Tight JPEG is a self-describing JPEG.
//!
//! This module decodes that stream to tightly-packed RGBA (`width * height * 4`,
//! row-major, alpha forced opaque) so it blits into the shared shadow framebuffer
//! and shared [`DirtyRect`](crate::connection::DirtyRect) stream exactly like a
//! Raw rect. Decode is via `zune-jpeg` (pure Rust, no RustCrypto deps) requesting
//! RGBA output directly, so no per-pixel channel expansion is needed here.

use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

/// A decoded JPEG rectangle: its pixel dimensions plus tightly-packed RGBA
/// (`width * height * 4` bytes, row-major, opaque alpha).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedJpeg {
    /// Decoded width in pixels.
    pub width: u32,
    /// Decoded height in pixels.
    pub height: u32,
    /// RGBA pixels, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
}

/// Decode a Tight JPEG sub-rect into RGBA.
///
/// Returns an `Err(String)` on malformed input, a header the decoder cannot
/// read, or an output whose length does not match the reported dimensions — so
/// the caller can log and drop the rectangle rather than corrupt the shadow
/// framebuffer, matching how Raw handles a size mismatch.
pub fn decode_jpeg_rgba(bytes: &[u8]) -> Result<DecodedJpeg, String> {
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(bytes, options);
    let rgba = decoder
        .decode()
        .map_err(|e| format!("jpeg decode failed: {e}"))?;
    let info = decoder
        .info()
        .ok_or_else(|| "jpeg missing header info after decode".to_string())?;
    let (width, height) = (info.width as u32, info.height as u32);
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err(format!(
            "jpeg decoded size mismatch: got {} bytes, expected {width}x{height}x4",
            rgba.len()
        ));
    }
    Ok(DecodedJpeg {
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A solid 16×16 red JPEG (quality 100, no chroma subsampling).
    const RED_16X16: &[u8] = include_bytes!("testdata/red_16x16.jpg");
    /// A solid 8×4 green JPEG — non-square to catch row-stride errors.
    const GREEN_8X4: &[u8] = include_bytes!("testdata/green_8x4.jpg");

    /// JPEG is lossy, so assert channels are *near* the encoded color, not exact.
    fn assert_near(actual: u8, expected: u8, chan: &str) {
        let diff = (actual as i16 - expected as i16).abs();
        assert!(
            diff <= 12,
            "{chan} channel {actual} too far from expected {expected}"
        );
    }

    #[test]
    fn decodes_dimensions_and_rgba_length() {
        let img = decode_jpeg_rgba(RED_16X16).expect("decode red");
        assert_eq!(img.width, 16);
        assert_eq!(img.height, 16);
        assert_eq!(img.rgba.len(), 16 * 16 * 4);
    }

    #[test]
    fn decodes_solid_red_with_opaque_alpha() {
        let img = decode_jpeg_rgba(RED_16X16).expect("decode red");
        // Sample the centre pixel to avoid any block-edge ringing.
        let idx = ((8 * 16) + 8) * 4;
        assert_near(img.rgba[idx], 255, "R");
        assert_near(img.rgba[idx + 1], 0, "G");
        assert_near(img.rgba[idx + 2], 0, "B");
        assert_eq!(img.rgba[idx + 3], 255, "alpha must be opaque");
    }

    #[test]
    fn decodes_non_square_green_rect() {
        let img = decode_jpeg_rgba(GREEN_8X4).expect("decode green");
        assert_eq!(img.width, 8);
        assert_eq!(img.height, 4);
        assert_eq!(img.rgba.len(), 8 * 4 * 4);
        // Every pixel opaque, and roughly green.
        let mid = ((2 * 8) + 4) * 4;
        assert_near(img.rgba[mid], 0, "R");
        assert_near(img.rgba[mid + 1], 200, "G");
        assert_near(img.rgba[mid + 2], 0, "B");
        for px in img.rgba.as_chunks::<4>().0 {
            assert_eq!(px[3], 255, "alpha must be opaque");
        }
    }

    #[test]
    fn rejects_garbage_bytes() {
        assert!(decode_jpeg_rgba(&[0xde, 0xad, 0xbe, 0xef]).is_err());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(decode_jpeg_rgba(&[]).is_err());
    }
}
