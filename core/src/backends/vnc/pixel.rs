//! Convert decoded RFB pixels into the shared RGBA frame contract (#3464).
//!
//! The vendored `vnc-rs` decoders emit `RawImage` rectangles (Raw, ZRLE, Tight
//! fill/copy/palette/gradient) in the **negotiated** RFB pixel format. termiHub
//! negotiates either 32-bit RGBA — byte-identical to the shared contract, passed
//! through untouched — or 16-bit high colour, which is expanded here.
//!
//! The conversion is driven entirely by the negotiated [`PixelFormat`]: its
//! bytes per pixel, its big-endian flag, and each channel's shift and maximum.
//! Nothing assumes RGB565 masks, so a server-side byte order or channel layout
//! is decoded as announced. Tight JPEG sub-rects and cursor shapes arrive as RGBA
//! already and do not come through here; CopyRect is resolved against the RGBA
//! shadow framebuffer.

use vnc::PixelFormat;

/// Converts negotiated-format pixel buffers to tightly packed RGBA.
#[derive(Debug, Clone)]
pub struct PixelConverter {
    format: PixelFormat,
    bytes_per_pixel: usize,
    /// The format already is byte-order RGBA: no conversion needed.
    passthrough: bool,
    /// Per-channel lookup tables: channel value (`0..=max`) → 8-bit intensity.
    luts: [Vec<u8>; 3],
}

impl PixelConverter {
    /// A converter for `format`, or an error message for a format this client
    /// cannot render (colour-map, or not 8/16/32 bits per pixel).
    pub fn new(format: PixelFormat) -> Result<Self, String> {
        if format.true_color_flag == 0 {
            return Err("colour-map pixel formats are not supported".to_string());
        }
        if !matches!(format.bits_per_pixel, 8 | 16 | 32) {
            return Err(format!(
                "{}-bit pixel formats are not supported",
                format.bits_per_pixel
            ));
        }
        let lut = |max: u16| -> Vec<u8> {
            let max_u32 = u32::from(max);
            (0..=max_u32)
                .map(|v| {
                    (v * 255 + max_u32 / 2)
                        .checked_div(max_u32)
                        .map_or(0, |scaled| scaled as u8)
                })
                .collect()
        };
        Ok(Self {
            bytes_per_pixel: format.bits_per_pixel as usize / 8,
            passthrough: is_rgba(&format),
            luts: [
                lut(format.red_max),
                lut(format.green_max),
                lut(format.blue_max),
            ],
            format,
        })
    }

    /// Convert `data` (exactly `pixels` negotiated-format pixels) to RGBA, or
    /// `None` when its length does not match — a malformed update is dropped,
    /// never partially rendered.
    pub fn to_rgba(&self, data: Vec<u8>, pixels: usize) -> Option<Vec<u8>> {
        if pixels.checked_mul(self.bytes_per_pixel) != Some(data.len()) {
            return None;
        }
        if self.passthrough {
            return Some(data);
        }
        let big_endian = self.format.big_endian_flag != 0;
        let channels = [
            (self.format.red_max, self.format.red_shift),
            (self.format.green_max, self.format.green_shift),
            (self.format.blue_max, self.format.blue_shift),
        ];
        let mut out = Vec::with_capacity(pixels * 4);
        for chunk in data.chunks_exact(self.bytes_per_pixel) {
            let value = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| {
                let shift = if big_endian {
                    8 * (self.bytes_per_pixel - 1 - i)
                } else {
                    8 * i
                };
                acc | (u32::from(*b) << shift)
            });
            for (lut, (max, shift)) in self.luts.iter().zip(channels) {
                let raw = value.checked_shr(u32::from(shift)).unwrap_or(0) & u32::from(max);
                out.push(lut.get(raw as usize).copied().unwrap_or(0));
            }
            out.push(255);
        }
        Some(out)
    }
}

/// Whether `format` lays pixels out as `r, g, b, x` bytes — the shared contract.
fn is_rgba(format: &PixelFormat) -> bool {
    format.bits_per_pixel == 32
        && [format.red_max, format.green_max, format.blue_max] == [255; 3]
        && if format.big_endian_flag == 0 {
            (format.red_shift, format.green_shift, format.blue_shift) == (0, 8, 16)
        } else {
            (format.red_shift, format.green_shift, format.blue_shift) == (24, 16, 8)
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le(pixels: &[u16]) -> Vec<u8> {
        pixels.iter().flat_map(|p| p.to_le_bytes()).collect()
    }

    fn be(pixels: &[u16]) -> Vec<u8> {
        pixels.iter().flat_map(|p| p.to_be_bytes()).collect()
    }

    #[test]
    fn rgba_is_passed_through_untouched() {
        let conv = PixelConverter::new(PixelFormat::rgba()).unwrap();
        let data = vec![1, 2, 3, 0, 4, 5, 6, 0];
        assert_eq!(conv.to_rgba(data.clone(), 2), Some(data));
    }

    #[test]
    fn bgra_is_swizzled_into_rgba() {
        let conv = PixelFormat::bgra();
        let conv = PixelConverter::new(conv).unwrap();
        // BGRA wire bytes (little-endian 0x00RRGGBB).
        assert_eq!(conv.to_rgba(vec![3, 2, 1, 0], 1), Some(vec![1, 2, 3, 255]));
    }

    #[test]
    fn rgb565_little_endian_expands_to_full_intensity() {
        let conv = PixelConverter::new(PixelFormat::rgb565()).unwrap();
        let rgba = conv
            .to_rgba(le(&[0xF800, 0x07E0, 0x001F, 0xFFFF, 0x0000]), 5)
            .unwrap();
        assert_eq!(
            rgba,
            vec![
                255, 0, 0, 255, //
                0, 255, 0, 255, //
                0, 0, 255, 255, //
                255, 255, 255, 255, //
                0, 0, 0, 255,
            ]
        );
    }

    #[test]
    fn rgb565_mid_scale_rounds_to_nearest() {
        let conv = PixelConverter::new(PixelFormat::rgb565()).unwrap();
        // red 16/31, green 32/63, blue 8/31.
        let px = (16 << 11) | (32 << 5) | 8;
        assert_eq!(conv.to_rgba(le(&[px]), 1), Some(vec![132, 130, 66, 255]));
    }

    #[test]
    fn big_endian_flag_selects_the_byte_order() {
        let mut format = PixelFormat::rgb565();
        format.big_endian_flag = 1;
        let conv = PixelConverter::new(format).unwrap();
        assert_eq!(
            conv.to_rgba(be(&[0xF800, 0x001F]), 2),
            Some(vec![255, 0, 0, 255, 0, 0, 255, 255])
        );
        // The same bytes read little-endian would be different colours.
        let le_conv = PixelConverter::new(PixelFormat::rgb565()).unwrap();
        assert_ne!(
            le_conv.to_rgba(be(&[0xF800, 0x001F]), 2),
            Some(vec![255, 0, 0, 255, 0, 0, 255, 255])
        );
    }

    #[test]
    fn shifts_and_maxima_come_from_the_format() {
        // BGR555 (x1-5-5-5): red in the low bits, 5-bit green.
        let mut format = PixelFormat::rgb565();
        format.depth = 15;
        format.red_shift = 0;
        format.green_shift = 5;
        format.blue_shift = 10;
        format.green_max = 31;
        let conv = PixelConverter::new(format).unwrap();
        assert_eq!(
            conv.to_rgba(le(&[0x001F, 0x03E0, 0x7C00]), 3),
            Some(vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
        );
    }

    #[test]
    fn eight_bit_true_colour_is_supported() {
        // BGR233.
        let mut format = PixelFormat::rgba();
        format.bits_per_pixel = 8;
        format.depth = 8;
        format.red_max = 7;
        format.green_max = 7;
        format.blue_max = 3;
        format.red_shift = 0;
        format.green_shift = 3;
        format.blue_shift = 6;
        let conv = PixelConverter::new(format).unwrap();
        assert_eq!(
            conv.to_rgba(vec![0x07, 0xC0], 2),
            Some(vec![255, 0, 0, 255, 0, 0, 255, 255])
        );
    }

    #[test]
    fn length_mismatch_is_rejected() {
        let conv = PixelConverter::new(PixelFormat::rgb565()).unwrap();
        assert_eq!(conv.to_rgba(vec![0; 3], 2), None);
        assert_eq!(conv.to_rgba(vec![0; 4], usize::MAX), None);
        let rgba = PixelConverter::new(PixelFormat::rgba()).unwrap();
        assert_eq!(rgba.to_rgba(vec![0; 4], 2), None);
    }

    #[test]
    fn colour_map_formats_are_rejected() {
        let mut format = PixelFormat::rgba();
        format.bits_per_pixel = 8;
        format.depth = 8;
        format.true_color_flag = 0;
        assert!(PixelConverter::new(format).is_err());
    }

    #[test]
    fn out_of_range_shifts_never_panic() {
        let mut format = PixelFormat::rgb565();
        format.red_shift = 200;
        let conv = PixelConverter::new(format).unwrap();
        assert_eq!(conv.to_rgba(le(&[0xFFFF]), 1), Some(vec![0, 255, 255, 255]));
    }
}
