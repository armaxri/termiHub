//! Windows device-independent bitmap (DIB) ↔ RGBA conversion for the CLIPRDR
//! image clipboard (PROD-021).
//!
//! RDP carries clipboard images as `CF_DIB` (a `BITMAPINFO`: header, optional
//! masks / color table, then the pixel rows) or `CF_DIBV5` (the same with a
//! `BITMAPV5HEADER`). The shared remote-desktop layer speaks top-down RGBA
//! ([`ClipboardImage`]), so the sidecar converts at the protocol edge:
//!
//! - **remote → host** ([`dib_to_image`]): 16/24/32-bit uncompressed (`BI_RGB`)
//!   and bit-field (`BI_BITFIELDS` / `BI_ALPHABITFIELDS`) DIBs, bottom-up or
//!   top-down. Palettized (≤ 8 bpp) and compressed (RLE / JPEG / PNG) DIBs are
//!   rejected as unsupported — Windows always synthesizes a 24/32-bit `CF_DIB`
//!   for screenshots and pictures, which is what a paste asks for.
//! - **host → remote** ([`image_to_dib`]): a 32-bit bottom-up `BI_RGB`
//!   `CF_DIB`, the most widely accepted form; the server synthesizes
//!   `CF_BITMAP` / `CF_DIBV5` from it for local applications.
//!
//! ## Untrusted input
//!
//! The DIB comes from the remote, so every field is bounds-checked: the
//! dimensions go through [`check_clipboard_image_size`] (per-side and byte caps)
//! **before** the RGBA buffer is allocated, all offsets/lengths use checked
//! arithmetic, and the raw payload itself is capped at
//! [`MAX_DIB_BYTES`]. A violating DIB is rejected with a typed [`DibError`] —
//! never truncated, scaled or partially read.

use termihub_core::connection::{
    check_clipboard_image_size, ClipboardImage, ClipboardImageViolation, MAX_CLIPBOARD_IMAGE_BYTES,
};

/// Cap on a raw DIB payload from the remote: the RGBA byte cap plus room for the
/// largest header, masks and a full 256-entry color table. A 32-bit DIB is the
/// same size as its RGBA decode; 16/24-bit ones are smaller.
pub const MAX_DIB_BYTES: u64 = MAX_CLIPBOARD_IMAGE_BYTES + 64 * 1024;

/// `BITMAPINFOHEADER` size — the smallest header this decoder accepts.
const BITMAPINFOHEADER_SIZE: usize = 40;
/// Largest standard header (`BITMAPV5HEADER`); larger claims are rejected.
const BITMAPV5HEADER_SIZE: usize = 124;

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;

/// Why a DIB could not be converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DibError {
    /// The payload exceeded [`MAX_DIB_BYTES`].
    PayloadTooLarge(u64),
    /// The payload is shorter than its header / pixel data claims.
    Truncated,
    /// A header field is malformed (bad header size, planes, …).
    Malformed(&'static str),
    /// A valid DIB variant this decoder does not handle (palettized, RLE, …).
    Unsupported(&'static str),
    /// The dimensions violate the clipboard-image caps.
    Bounds(ClipboardImageViolation),
}

impl std::fmt::Display for DibError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PayloadTooLarge(n) => {
                write!(
                    f,
                    "DIB payload of {n} bytes exceeds the {MAX_DIB_BYTES}-byte cap"
                )
            }
            Self::Truncated => f.write_str("DIB is truncated"),
            Self::Malformed(what) => write!(f, "malformed DIB: {what}"),
            Self::Unsupported(what) => write!(f, "unsupported DIB: {what}"),
            Self::Bounds(v) => write!(f, "{v}"),
        }
    }
}

impl std::error::Error for DibError {}

impl From<ClipboardImageViolation> for DibError {
    fn from(v: ClipboardImageViolation) -> Self {
        Self::Bounds(v)
    }
}

fn read_u16(data: &[u8], at: usize) -> Result<u16, DibError> {
    let bytes = data.get(at..at + 2).ok_or(DibError::Truncated)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], at: usize) -> Result<u32, DibError> {
    let bytes = data.get(at..at + 4).ok_or(DibError::Truncated)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_i32(data: &[u8], at: usize) -> Result<i32, DibError> {
    read_u32(data, at).map(|v| v as i32)
}

/// One channel's bit mask, pre-split into shift and width so a pixel value can
/// be scaled to 8 bits.
#[derive(Debug, Clone, Copy)]
struct Channel {
    mask: u32,
    shift: u32,
    max: u32,
}

impl Channel {
    fn new(mask: u32) -> Self {
        if mask == 0 {
            return Self {
                mask: 0,
                shift: 0,
                max: 0,
            };
        }
        let shift = mask.trailing_zeros();
        let max = mask >> shift;
        Self { mask, shift, max }
    }

    /// Extract and scale this channel to 0..=255; `None` for an absent channel.
    fn extract(&self, pixel: u32) -> Option<u8> {
        if self.mask == 0 {
            return None;
        }
        let value = u64::from((pixel & self.mask) >> self.shift);
        // `max` ≥ 1 because the mask is non-zero; the result is ≤ 255.
        Some((value * 255 / u64::from(self.max)) as u8)
    }
}

/// Decode a `CF_DIB` / `CF_DIBV5` payload into a capped, top-down RGBA image.
pub fn dib_to_image(data: &[u8]) -> Result<ClipboardImage, DibError> {
    if data.len() as u64 > MAX_DIB_BYTES {
        return Err(DibError::PayloadTooLarge(data.len() as u64));
    }
    let header_size = read_u32(data, 0)? as usize;
    if header_size == 12 {
        return Err(DibError::Unsupported("BITMAPCOREHEADER"));
    }
    if !(BITMAPINFOHEADER_SIZE..=BITMAPV5HEADER_SIZE).contains(&header_size) {
        return Err(DibError::Malformed("header size"));
    }
    if data.len() < header_size {
        return Err(DibError::Truncated);
    }
    let raw_width = read_i32(data, 4)?;
    let raw_height = read_i32(data, 8)?;
    let planes = read_u16(data, 12)?;
    let bit_count = read_u16(data, 14)?;
    let compression = read_u32(data, 16)?;
    let colors_used = read_u32(data, 32)?;

    if planes != 1 {
        return Err(DibError::Malformed("planes"));
    }
    if raw_width <= 0 || raw_height == 0 {
        return Err(DibError::Malformed("dimensions"));
    }
    let width = raw_width as u32;
    let top_down = raw_height < 0;
    let height = raw_height.unsigned_abs();
    // Caps first: nothing below allocates before the image is known to fit.
    let rgba_bytes = check_clipboard_image_size(width, height)?;

    let (red, green, blue, alpha, mask_bytes) = match (compression, bit_count) {
        (BI_RGB, 24) => (
            Channel::new(0x00FF_0000),
            Channel::new(0x0000_FF00),
            Channel::new(0x0000_00FF),
            Channel::new(0),
            0,
        ),
        (BI_RGB, 32) => (
            Channel::new(0x00FF_0000),
            Channel::new(0x0000_FF00),
            Channel::new(0x0000_00FF),
            // Nominally reserved; honoured only if any pixel sets it (below).
            Channel::new(0xFF00_0000),
            0,
        ),
        (BI_RGB, 16) => (
            Channel::new(0x7C00),
            Channel::new(0x03E0),
            Channel::new(0x001F),
            Channel::new(0),
            0,
        ),
        (BI_BITFIELDS | BI_ALPHABITFIELDS, 16 | 32) => {
            let has_alpha_mask = compression == BI_ALPHABITFIELDS || header_size >= 56;
            // A BITMAPINFOHEADER carries the masks right after it; V2+ headers
            // hold them inside the header itself (at the same offsets).
            let mask_count = if compression == BI_ALPHABITFIELDS {
                4
            } else {
                3
            };
            let mask_bytes = if header_size == BITMAPINFOHEADER_SIZE {
                mask_count * 4
            } else {
                0
            };
            let alpha = if has_alpha_mask {
                read_u32(data, 52)?
            } else {
                0
            };
            (
                Channel::new(read_u32(data, 40)?),
                Channel::new(read_u32(data, 44)?),
                Channel::new(read_u32(data, 48)?),
                Channel::new(alpha),
                mask_bytes,
            )
        }
        (_, 1 | 4 | 8) => return Err(DibError::Unsupported("palettized bitmap")),
        (BI_RGB | BI_BITFIELDS | BI_ALPHABITFIELDS, _) => {
            return Err(DibError::Unsupported("bit depth"))
        }
        _ => return Err(DibError::Unsupported("compression")),
    };

    // An optional color table may follow even a true-color DIB; skip it.
    if colors_used > 256 {
        return Err(DibError::Malformed("color table size"));
    }
    let offset = header_size + mask_bytes + colors_used as usize * 4;
    let bytes_per_pixel = usize::from(bit_count / 8);
    let stride = (width as usize * usize::from(bit_count)).div_ceil(32) * 4;
    let pixel_bytes = stride
        .checked_mul(height as usize)
        .ok_or(DibError::Malformed("dimensions"))?;
    let end = offset
        .checked_add(pixel_bytes)
        .ok_or(DibError::Malformed("dimensions"))?;
    let pixels = data.get(offset..end).ok_or(DibError::Truncated)?;

    let mut rgba = Vec::with_capacity(rgba_bytes as usize);
    let mut any_alpha = false;
    for out_row in 0..height as usize {
        let src_row = if top_down {
            out_row
        } else {
            height as usize - 1 - out_row
        };
        let row = &pixels[src_row * stride..src_row * stride + stride];
        for x in 0..width as usize {
            let p = &row[x * bytes_per_pixel..x * bytes_per_pixel + bytes_per_pixel];
            let pixel = match bytes_per_pixel {
                2 => u32::from(u16::from_le_bytes([p[0], p[1]])),
                3 => u32::from_le_bytes([p[0], p[1], p[2], 0]),
                _ => u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
            };
            let a = alpha.extract(pixel);
            any_alpha |= a.is_some_and(|a| a != 0);
            rgba.extend_from_slice(&[
                red.extract(pixel).unwrap_or(0),
                green.extract(pixel).unwrap_or(0),
                blue.extract(pixel).unwrap_or(0),
                a.unwrap_or(0xFF),
            ]);
        }
    }
    // Many producers leave the alpha byte zero; an all-transparent image is
    // never what was copied, so treat "no pixel sets alpha" as opaque.
    if !any_alpha {
        for px in rgba.as_chunks_mut::<4>().0 {
            px[3] = 0xFF;
        }
    }
    Ok(ClipboardImage::new(width, height, rgba)?)
}

/// Encode an RGBA image as a 32-bit bottom-up `BI_RGB` `CF_DIB`.
///
/// The image must already satisfy the clipboard-image caps (callers validate
/// it on receipt); the output is then bounded by [`MAX_DIB_BYTES`].
pub fn image_to_dib(image: &ClipboardImage) -> Vec<u8> {
    let width = image.width as usize;
    let height = image.height as usize;
    let stride = width * 4;
    let pixel_bytes = stride * height;
    let mut dib = Vec::with_capacity(BITMAPINFOHEADER_SIZE + pixel_bytes);
    dib.extend_from_slice(&(BITMAPINFOHEADER_SIZE as u32).to_le_bytes()); // biSize
    dib.extend_from_slice(&(image.width as i32).to_le_bytes()); // biWidth
    dib.extend_from_slice(&(image.height as i32).to_le_bytes()); // biHeight (bottom-up)
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&BI_RGB.to_le_bytes()); // biCompression
    dib.extend_from_slice(&(pixel_bytes as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&2835i32.to_le_bytes()); // biXPelsPerMeter (72 dpi)
    dib.extend_from_slice(&2835i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for row in (0..height).rev() {
        for px in image.rgba[row * stride..row * stride + stride]
            .as_chunks::<4>()
            .0
        {
            dib.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    dib
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a BITMAPINFOHEADER-based DIB from rows of pre-encoded pixel bytes.
    fn dib(
        header_size: u32,
        width: i32,
        height: i32,
        bit_count: u16,
        compression: u32,
        extra_after_header: &[u8],
        rows: &[&[u8]],
    ) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&header_size.to_le_bytes());
        d.extend_from_slice(&width.to_le_bytes());
        d.extend_from_slice(&height.to_le_bytes());
        d.extend_from_slice(&1u16.to_le_bytes());
        d.extend_from_slice(&bit_count.to_le_bytes());
        d.extend_from_slice(&compression.to_le_bytes());
        d.extend_from_slice(&[0; 20]); // size image, ppm x/y, clr used/important
        d.resize(header_size as usize, 0);
        d.extend_from_slice(extra_after_header);
        for row in rows {
            d.extend_from_slice(row);
        }
        d
    }

    #[test]
    fn decodes_a_bottom_up_24_bit_dib_with_row_padding() {
        // 1×2, bottom-up: the first stored row is the bottom (blue), then top (red).
        // Each 3-byte row pads to 4.
        let data = dib(
            40,
            1,
            2,
            24,
            BI_RGB,
            &[],
            &[&[255, 0, 0, 0], &[0, 0, 255, 0]],
        );
        let img = dib_to_image(&data).unwrap();
        assert_eq!((img.width, img.height), (1, 2));
        assert_eq!(img.rgba, vec![255, 0, 0, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn decodes_a_top_down_32_bit_dib_treating_zero_alpha_as_opaque() {
        let data = dib(40, 2, -1, 32, BI_RGB, &[], &[&[1, 2, 3, 0, 4, 5, 6, 0]]);
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![3, 2, 1, 255, 6, 5, 4, 255]);
    }

    #[test]
    fn keeps_real_alpha_in_a_32_bit_dib() {
        let data = dib(40, 2, 1, 32, BI_RGB, &[], &[&[1, 2, 3, 128, 4, 5, 6, 0]]);
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![3, 2, 1, 128, 6, 5, 4, 0]);
    }

    #[test]
    fn decodes_bitfields_masks_after_an_info_header() {
        // BGRX masks spelled out explicitly, as Windows' synthesized CF_DIB does.
        let mut masks = Vec::new();
        for m in [0x00FF_0000u32, 0x0000_FF00, 0x0000_00FF] {
            masks.extend_from_slice(&m.to_le_bytes());
        }
        let data = dib(40, 1, 1, 32, BI_BITFIELDS, &masks, &[&[10, 20, 30, 0]]);
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![30, 20, 10, 255]);
    }

    #[test]
    fn decodes_a_v5_header_with_in_header_masks_and_alpha() {
        let mut data = dib(124, 1, 1, 32, BI_BITFIELDS, &[], &[&[10, 20, 30, 40]]);
        for (i, m) in [0x00FF_0000u32, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000]
            .into_iter()
            .enumerate()
        {
            data[40 + i * 4..44 + i * 4].copy_from_slice(&m.to_le_bytes());
        }
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![30, 20, 10, 40]);
    }

    #[test]
    fn decodes_a_16_bit_555_dib() {
        // Pure red in 5-5-5: 0x7C00, padded to a 4-byte row.
        let data = dib(40, 1, 1, 16, BI_RGB, &[], &[&[0x00, 0x7C, 0, 0]]);
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![255, 0, 0, 255]);
    }

    #[test]
    fn skips_an_optional_color_table_on_a_true_color_dib() {
        let mut data = dib(40, 1, 1, 24, BI_RGB, &[9, 9, 9, 9], &[&[1, 2, 3, 0]]);
        data[32..36].copy_from_slice(&1u32.to_le_bytes()); // biClrUsed = 1
        let img = dib_to_image(&data).unwrap();
        assert_eq!(img.rgba, vec![3, 2, 1, 255]);
    }

    #[test]
    fn rejects_a_truncated_pixel_array() {
        let data = dib(40, 4, 4, 32, BI_RGB, &[], &[&[0; 16]]);
        assert_eq!(dib_to_image(&data), Err(DibError::Truncated));
        assert_eq!(dib_to_image(&[40, 0]), Err(DibError::Truncated));
    }

    #[test]
    fn rejects_oversize_dimensions_before_allocating() {
        // Claims 100000×100000 but carries no pixels: must fail on the cap, not
        // on an attempted multi-gigabyte allocation.
        let data = dib(40, 100_000, 100_000, 32, BI_RGB, &[], &[]);
        assert!(matches!(
            dib_to_image(&data),
            Err(DibError::Bounds(ClipboardImageViolation::Oversize { .. }))
        ));
        let data = dib(40, 8192, 8192, 32, BI_RGB, &[], &[]);
        assert!(matches!(
            dib_to_image(&data),
            Err(DibError::Bounds(ClipboardImageViolation::TooLarge { .. }))
        ));
        // i32::MIN height must not overflow when taking its magnitude.
        let data = dib(40, 1, i32::MIN, 32, BI_RGB, &[], &[]);
        assert!(matches!(dib_to_image(&data), Err(DibError::Bounds(_))));
    }

    #[test]
    fn rejects_an_oversize_payload() {
        let data = vec![0u8; MAX_DIB_BYTES as usize + 1];
        assert!(matches!(
            dib_to_image(&data),
            Err(DibError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn rejects_unsupported_and_malformed_variants() {
        let palettized = dib(40, 1, 1, 8, BI_RGB, &[], &[&[0; 4]]);
        assert!(matches!(
            dib_to_image(&palettized),
            Err(DibError::Unsupported(_))
        ));
        let rle = dib(40, 1, 1, 32, 1, &[], &[&[0; 4]]);
        assert!(matches!(dib_to_image(&rle), Err(DibError::Unsupported(_))));
        let bad_header = dib(40, 1, 1, 32, BI_RGB, &[], &[&[0; 4]]);
        let mut bad_header = bad_header;
        bad_header[0..4].copy_from_slice(&999u32.to_le_bytes());
        assert!(matches!(
            dib_to_image(&bad_header),
            Err(DibError::Malformed(_))
        ));
        let zero_width = dib(40, 0, 1, 32, BI_RGB, &[], &[]);
        assert!(matches!(
            dib_to_image(&zero_width),
            Err(DibError::Malformed(_))
        ));
    }

    #[test]
    fn image_round_trips_through_an_encoded_dib() {
        let image = ClipboardImage::new(
            2,
            2,
            vec![
                255, 0, 0, 255, 0, 255, 0, 200, //
                0, 0, 255, 255, 10, 20, 30, 40,
            ],
        )
        .unwrap();
        let dib = image_to_dib(&image);
        assert_eq!(dib.len(), 40 + 16);
        assert_eq!(dib_to_image(&dib).unwrap(), image);
    }
}
