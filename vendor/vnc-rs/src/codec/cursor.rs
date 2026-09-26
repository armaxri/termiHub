use crate::{PixelFormat, Rect, VncError, VncEvent};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncReadExt};

use tracing::warn;

use super::zeroed_vec;

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
        // with 8-bit RGB lanes. The cursor is cosmetic: skip an undecodable shape
        // instead of ending (or panicking) the session.
        let alpha_shift = match super::alpha_shift(format) {
            Ok(shift) => shift,
            Err(_) => {
                warn!(
                    bits_per_pixel = format.bits_per_pixel,
                    "cursor shape in an unsupported pixel format skipped"
                );
                return Ok(());
            }
        };
        // Byte index of the alpha channel within a 4-byte pixel in wire order.
        let mut alpha_idx = 3 - (alpha_shift / 8) as usize;
        if format.big_endian_flag == 0 {
            alpha_idx = 3 - alpha_idx;
        }

        let mut image = pixels;
        for y in 0..h {
            for x in 0..w {
                let opaque = mask
                    .get(y * mask_row + x / 8)
                    .is_some_and(|m| (m << (x % 8)) & 0x80 > 0);
                let pix_idx = (y * w + x) * 4;
                // use alpha from the bitmask to cover it.
                if let Some(a) = image.get_mut(pix_idx + alpha_idx) {
                    *a = if opaque { 255 } else { 0 };
                }
            }
        }

        output_func(VncEvent::SetCursor(*rect, image)).await?;

        Ok(())
    }
}
