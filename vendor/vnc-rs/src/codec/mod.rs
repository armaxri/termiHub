mod cursor;
mod raw;
mod tight;
mod trle;
mod zlib;
mod zrle;
pub(crate) use cursor::Decoder as CursorDecoder;
pub(crate) use raw::Decoder as RawDecoder;
pub(crate) use tight::Decoder as TightDecoder;
pub(crate) use trle::Decoder as TrleDecoder;
pub(crate) use zrle::Decoder as ZrleDecoder;

use crate::{PixelFormat, Rect, VncError};

/// Largest rectangle area (in pixels) accepted from the server (termiHub fork,
/// #3473). Mirrors termiHub's `MAX_FRAMEBUFFER_DIMENSION` squared (8192 x 8192,
/// 256 MiB at 32 bpp): the rectangle geometry is server-chosen and untrusted, and
/// upstream allocated `width * height * bpp` verbatim — up to ~17 GiB for a
/// 65535 x 65535 rectangle, which aborts the process on allocation failure.
/// Bounding the *area* (not each side) keeps very wide but short strips legal.
pub(crate) const MAX_RECT_PIXELS: usize = 8192 * 8192;

/// Largest length-prefixed compressed payload (ZRLE `u32` length)
/// accepted from the server (termiHub fork, #3473): a maximal rectangle's raw
/// size plus deflate's worst-case expansion headroom.
pub(crate) const MAX_ENCODED_BYTES: usize = MAX_RECT_PIXELS * 4 + (1 << 20);

/// A zero-initialised buffer of `len` bytes.
///
/// Upstream used an uninitialised `Vec` (`set_len` over spare capacity) and then
/// read into it, which is unsound for `u8` and hands garbage to the consumer if
/// a decoder ever under-fills it. All callers bound `len` first.
fn zeroed_vec(len: usize) -> Vec<u8> {
    vec![0; len]
}

/// Checked `width * height` for a server-supplied rectangle, rejecting anything
/// larger than [`MAX_RECT_PIXELS`] before a single byte is allocated.
pub(crate) fn rect_pixels(rect: &Rect) -> Result<usize, VncError> {
    let pixels = rect.width as usize * rect.height as usize;
    if pixels > MAX_RECT_PIXELS {
        return Err(VncError::Protocol(format!(
            "server rectangle {}x{} exceeds the {MAX_RECT_PIXELS}-pixel limit",
            rect.width, rect.height
        )));
    }
    Ok(pixels)
}

/// Validate a server-supplied image rectangle before it is decoded: its far
/// edges must be representable (`x + width` and `y + height` fit in `u16`, so
/// per-tile offsets inside it can never overflow) and its area must be within
/// [`MAX_RECT_PIXELS`].
pub(crate) fn validate_image_rect(rect: &Rect) -> Result<(), VncError> {
    if rect.x.checked_add(rect.width).is_none() || rect.y.checked_add(rect.height).is_none() {
        return Err(VncError::Protocol(format!(
            "server rectangle at ({}, {}) size {}x{} overflows the 16-bit coordinate space",
            rect.x, rect.y, rect.width, rect.height
        )));
    }
    rect_pixels(rect)?;
    Ok(())
}

/// Largest framebuffer side accepted from `ServerInit` / `DesktopSize`
/// (termiHub fork, #3499 — upstream 0.6.0 bounds it at 8192 too). Matches
/// termiHub's `MAX_FRAMEBUFFER_DIMENSION`. Upstream 0.6.0 additionally caps the
/// area at 3840 x 2160 and rejects zero sizes; termiHub keeps its 8192 x 8192
/// area bound ([`MAX_RECT_PIXELS`]) so 5K/8K desktops still connect.
pub(crate) const MAX_SCREEN_DIMENSION: u16 = 8192;

/// Validate a server-announced framebuffer size.
pub(crate) fn validate_screen(width: u16, height: u16) -> Result<(), VncError> {
    if width > MAX_SCREEN_DIMENSION || height > MAX_SCREEN_DIMENSION {
        return Err(VncError::Protocol(format!(
            "server framebuffer {width}x{height} exceeds the {MAX_SCREEN_DIMENSION}-pixel side limit"
        )));
    }
    Ok(())
}

/// Require a pixel-carrying rectangle to lie inside the current framebuffer
/// (termiHub fork, #3499 — ported from upstream 0.6.0 `623b894`). RFB only
/// defines updates for framebuffer pixels; anything outside is a protocol
/// violation that consumers would otherwise have to clip.
pub(crate) fn validate_rect_on_screen(rect: &Rect, screen: (u16, u16)) -> Result<(), VncError> {
    if u32::from(rect.x) + u32::from(rect.width) > u32::from(screen.0)
        || u32::from(rect.y) + u32::from(rect.height) > u32::from(screen.1)
    {
        return Err(VncError::Protocol(format!(
            "server rectangle at ({}, {}) size {}x{} lies outside the {}x{} framebuffer",
            rect.x, rect.y, rect.width, rect.height, screen.0, screen.1
        )));
    }
    Ok(())
}

/// Read a server `u32` length prefix for a compressed payload and bound it by
/// [`MAX_ENCODED_BYTES`].
pub(crate) fn encoded_len(len: u32) -> Result<usize, VncError> {
    let len = len as usize;
    if len > MAX_ENCODED_BYTES {
        return Err(VncError::Protocol(format!(
            "server compressed payload of {len} bytes exceeds the {MAX_ENCODED_BYTES}-byte limit"
        )));
    }
    Ok(len)
}

/// `value << shift`, or `0` when the (server-influenced) shift is out of range.
/// A plain `<<` panics for `shift >= 32` under overflow checks, which termiHub
/// enables in release builds (ERR-010).
fn shl_or_zero(value: u32, shift: u8) -> u32 {
    value.checked_shl(u32::from(shift)).unwrap_or(0)
}

/// The combined RGB bit mask of a true-colour pixel format.
pub(crate) fn pixel_mask(format: &PixelFormat) -> u32 {
    shl_or_zero(format.red_max as u32, format.red_shift)
        | shl_or_zero(format.green_max as u32, format.green_shift)
        | shl_or_zero(format.blue_max as u32, format.blue_shift)
}

/// For a 32-bpp pixel format whose RGB channels are three 8-bit lanes, the bit
/// shift of the remaining (alpha) byte. Any other format is unsupported by the
/// decoders that emit RGBA directly (Tight, cursor) — upstream hit
/// `unreachable!()` here.
pub(crate) fn alpha_shift(format: &PixelFormat) -> Result<u32, VncError> {
    if format.bits_per_pixel != 32 {
        return Err(VncError::WrongPixelFormat);
    }
    match pixel_mask(format) {
        0xff_ff_ff_00 => Ok(0),
        0xff_ff_00_ff => Ok(8),
        0xff_00_ff_ff => Ok(16),
        0x00_ff_ff_ff => Ok(24),
        _ => Err(VncError::WrongPixelFormat),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn validate_rejects_edge_overflow() {
        assert!(validate_image_rect(&rect(u16::MAX, 0, 1, 1)).is_err());
        assert!(validate_image_rect(&rect(0, 65_000, 1, 600)).is_err());
        assert!(validate_image_rect(&rect(100, 100, 640, 480)).is_ok());
    }

    #[test]
    fn validate_rejects_oversize_area_but_allows_wide_strips() {
        assert!(validate_image_rect(&rect(0, 0, u16::MAX, u16::MAX)).is_err());
        assert!(validate_image_rect(&rect(0, 0, 60_000, 64)).is_ok());
    }

    #[test]
    fn rect_must_lie_inside_the_framebuffer() {
        assert!(validate_rect_on_screen(&rect(0, 0, 640, 480), (640, 480)).is_ok());
        assert!(validate_rect_on_screen(&rect(1, 0, 640, 480), (640, 480)).is_err());
        assert!(validate_rect_on_screen(&rect(0, 480, 1, 1), (640, 480)).is_err());
        assert!(validate_rect_on_screen(&rect(640, 480, 0, 0), (640, 480)).is_ok());
    }

    #[test]
    fn screen_sides_are_bounded() {
        assert!(validate_screen(8192, 8192).is_ok());
        assert!(validate_screen(8193, 1).is_err());
        assert!(validate_screen(1, u16::MAX).is_err());
    }

    #[test]
    fn encoded_len_is_bounded() {
        assert!(encoded_len(u32::MAX).is_err());
        assert_eq!(encoded_len(1024).unwrap(), 1024);
    }

    #[test]
    fn pixel_mask_never_panics_on_huge_shifts() {
        let mut pf = PixelFormat::rgba();
        pf.red_shift = 200;
        pf.green_shift = 32;
        pf.blue_shift = 255;
        assert_eq!(pixel_mask(&pf), 0);
        assert!(alpha_shift(&pf).is_err());
    }

    #[test]
    fn alpha_shift_accepts_rgba_and_bgra_only_at_32bpp() {
        assert_eq!(alpha_shift(&PixelFormat::rgba()).unwrap(), 24);
        assert_eq!(alpha_shift(&PixelFormat::bgra()).unwrap(), 24);
        let mut pf = PixelFormat::rgba();
        pf.bits_per_pixel = 16;
        assert!(alpha_shift(&pf).is_err());
    }
}
