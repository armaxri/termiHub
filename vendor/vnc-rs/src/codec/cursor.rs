use crate::{PixelFormat, Rect, VncError, VncEvent};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncReadExt};

use tracing::warn;

use super::zeroed_vec;

/// Decodes the RFB Cursor pseudo-encoding (RFC 6143 §7.8.1).
///
/// termiHub fork (#3464): the emitted [`VncEvent::SetCursor`] pixels are always
/// RGBA8888 (`r, g, b, a` bytes, alpha from the cursor bitmask), whatever the
/// negotiated pixel format.
pub struct Decoder {}

impl Decoder {
    pub fn new() -> Self {
        Self {}
    }

    pub async fn decode<S, F, Fut>(
        &mut self,
        format: &PixelFormat,
        rect: &Rect,
        input: &mut S,
        output_func: &F,
    ) -> Result<(), VncError>
    where
        S: AsyncRead + Unpin,
        F: Fn(VncEvent) -> Fut,
        Fut: Future<Output = Result<(), VncError>>,
    {
        let _hotx = rect.x;
        let _hoty = rect.y;
        let w = rect.width as usize;
        let h = rect.height as usize;

        // termiHub fork (#3473): the cursor geometry and pixel format are
        // server-influenced. Bound the allocation first, then always consume the
        // full payload so the stream stays in sync, and only then decide whether
        // the shape can be rendered.
        let pixel_count = super::rect_pixels(rect)?;
        let bytes_per_pixel = (format.bits_per_pixel / 8) as usize;
        let pixels_length = pixel_count * bytes_per_pixel;
        let mask_row = w.div_ceil(8);
        let mask_length = mask_row * h;

        let mut pixels = zeroed_vec(pixels_length);
        input.read_exact(&mut pixels).await?;
        let mut mask = zeroed_vec(mask_length);
        input.read_exact(&mut mask).await?;

        // Upstream hit `unreachable!()` for any pixel format other than 32 bpp
        // with 8-bit RGB lanes. termiHub fork (#3464): every valid true-colour
        // format (32-bit, 16-bit high colour, 8-bit true colour; either
        // endianness) now decodes to RGBA8888 with the bitmask as alpha. A
        // colour-map or malformed format cannot be rendered; the cursor is
        // cosmetic, so skip the shape instead of ending (or panicking) the session.
        if format.true_color_flag == 0 || format.validate().is_err() {
            warn!(
                bits_per_pixel = format.bits_per_pixel,
                true_color = format.true_color_flag,
                "cursor shape in an unsupported pixel format skipped"
            );
            return Ok(());
        }

        let mut image = Vec::with_capacity(pixel_count * 4);
        for y in 0..h {
            for x in 0..w {
                let opaque = mask
                    .get(y * mask_row + x / 8)
                    .is_some_and(|m| (m << (x % 8)) & 0x80 > 0);
                let start = (y * w + x) * bytes_per_pixel;
                let bytes = pixels
                    .get(start..start + bytes_per_pixel)
                    .ok_or(VncError::InvalidImageData)?;
                let [r, g, b] = super::pixel_rgb(format, super::pixel_value(format, bytes));
                image.extend_from_slice(&[r, g, b, if opaque { 255 } else { 0 }]);
            }
        }

        output_func(VncEvent::SetCursor(*rect, image)).await?;

        Ok(())
    }
}
