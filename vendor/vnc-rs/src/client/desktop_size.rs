//! RFB ExtendedDesktopSize (pseudo-encoding -308) and `SetDesktopSize`
//! (client message 251) — termiHub fork, #3463.
//!
//! Wire formats follow the community RFB specification
//! (<https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst>,
//! "ExtendedDesktopSize Pseudo-encoding" and "SetDesktopSize"). Upstream 0.5.3
//! has neither; upstream 0.6.0's desktop-resize feature was not ported (see the
//! fork README), so this is termiHub's own, hostile-server-hardened version:
//! every length is bounded before it is read and a malformed layout is a typed
//! [`VncError::Protocol`], never a panic or an unbounded allocation.

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::codec;
use crate::{
    DesktopScreen, DesktopSizeReason, DesktopSizeRequest, DesktopSizeStatus, ExtendedDesktopSize,
    Rect, VncError,
};

/// Most screens accepted in a server layout or sent in a `SetDesktopSize`.
/// The wire count is a `u8` (so at most 255 x 16 bytes are ever read), but a
/// layout beyond this is treated as hostile rather than kept.
pub(crate) const MAX_DESKTOP_SCREENS: usize = 16;

/// RFB message type of `SetDesktopSize`.
const SET_DESKTOP_SIZE: u8 = 251;

/// Size of one `SCREEN` structure on the wire.
const SCREEN_BYTES: usize = 16;

fn read_screen(buf: &[u8; SCREEN_BYTES]) -> DesktopScreen {
    let u16_at = |i: usize| u16::from_be_bytes([buf[i], buf[i + 1]]);
    let u32_at = |i: usize| u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
    DesktopScreen {
        id: u32_at(0),
        x: u16_at(4),
        y: u16_at(6),
        width: u16_at(8),
        height: u16_at(10),
        flags: u32_at(12),
    }
}

/// Read the body of an ExtendedDesktopSize rectangle whose header is `rect`
/// (`x` = reason, `y` = status, `width` / `height` = framebuffer size).
///
/// ```text
/// +--------------+--------------+-------------------+
/// | No. of bytes | Type [Value] | Description       |
/// +--------------+--------------+-------------------+
/// | 1            | U8           | number-of-screens |
/// | 3            |              | padding           |
/// | 16 x N       | SCREEN array | screens           |
/// +--------------+--------------+-------------------+
/// ```
///
/// A layout with more than [`MAX_DESKTOP_SCREENS`] screens, or an accepted
/// (status 0) size beyond the framebuffer side limit, is a protocol error.
pub(super) async fn read_extended_desktop_size<S>(
    reader: &mut S,
    rect: &Rect,
) -> Result<ExtendedDesktopSize, VncError>
where
    S: AsyncRead + Unpin,
{
    let count = usize::from(reader.read_u8().await?);
    let mut padding = [0_u8; 3];
    reader.read_exact(&mut padding).await?;
    if count > MAX_DESKTOP_SCREENS {
        return Err(VncError::Protocol(format!(
            "server desktop layout of {count} screens exceeds the {MAX_DESKTOP_SCREENS}-screen limit"
        )));
    }
    let status = DesktopSizeStatus::from(rect.y);
    if status == DesktopSizeStatus::Ok {
        codec::validate_screen(rect.width, rect.height)?;
    }
    let mut screens = Vec::with_capacity(count);
    for _ in 0..count {
        let mut buf = [0_u8; SCREEN_BYTES];
        reader.read_exact(&mut buf).await?;
        screens.push(read_screen(&buf));
    }
    Ok(ExtendedDesktopSize {
        reason: DesktopSizeReason::from(rect.x),
        status,
        width: rect.width,
        height: rect.height,
        screens,
    })
}

/// Check a client `SetDesktopSize` request before it is queued: a size inside
/// the framebuffer side limit, and 1..=[`MAX_DESKTOP_SCREENS`] non-empty
/// screens that each lie inside it. A rejected request never reaches the
/// socket, so it cannot end the session.
pub(super) fn validate_request(req: &DesktopSizeRequest) -> Result<(), VncError> {
    let invalid = |why: String| Err(VncError::General(format!("invalid SetDesktopSize: {why}")));
    if req.width == 0 || req.height == 0 {
        return invalid(format!("empty desktop {}x{}", req.width, req.height));
    }
    if codec::validate_screen(req.width, req.height).is_err() {
        return invalid(format!("desktop {}x{} is too large", req.width, req.height));
    }
    if req.screens.is_empty() || req.screens.len() > MAX_DESKTOP_SCREENS {
        return invalid(format!(
            "{} screens (1..={MAX_DESKTOP_SCREENS} allowed)",
            req.screens.len()
        ));
    }
    for s in &req.screens {
        let fits = u32::from(s.x) + u32::from(s.width) <= u32::from(req.width)
            && u32::from(s.y) + u32::from(s.height) <= u32::from(req.height);
        if s.width == 0 || s.height == 0 || !fits {
            return invalid(format!(
                "screen {} at ({}, {}) size {}x{} is outside the {}x{} desktop",
                s.id, s.x, s.y, s.width, s.height, req.width, req.height
            ));
        }
    }
    Ok(())
}

/// Encode a (validated) `SetDesktopSize` message.
///
/// ```text
/// +--------------+--------------+-------------------+
/// | No. of bytes | Type [Value] | Description       |
/// +--------------+--------------+-------------------+
/// | 1            | U8 [251]     | message-type      |
/// | 1            |              | padding           |
/// | 2            | U16          | width             |
/// | 2            | U16          | height            |
/// | 1            | U8           | number-of-screens |
/// | 1            |              | padding           |
/// | 16 x N       | SCREEN array | screens           |
/// +--------------+--------------+-------------------+
/// ```
pub(super) fn encode_set_desktop_size(req: &DesktopSizeRequest) -> Vec<u8> {
    // `validate_request` bounds the count by MAX_DESKTOP_SCREENS; the `min`
    // keeps the count byte and the payload consistent regardless.
    let screens = &req.screens[..req.screens.len().min(MAX_DESKTOP_SCREENS)];
    let mut out = Vec::with_capacity(8 + SCREEN_BYTES * screens.len());
    out.extend_from_slice(&[SET_DESKTOP_SIZE, 0]);
    out.extend_from_slice(&req.width.to_be_bytes());
    out.extend_from_slice(&req.height.to_be_bytes());
    out.extend_from_slice(&[screens.len() as u8, 0]);
    for s in screens {
        out.extend_from_slice(&s.id.to_be_bytes());
        out.extend_from_slice(&s.x.to_be_bytes());
        out.extend_from_slice(&s.y.to_be_bytes());
        out.extend_from_slice(&s.width.to_be_bytes());
        out.extend_from_slice(&s.height.to_be_bytes());
        out.extend_from_slice(&s.flags.to_be_bytes());
    }
    out
}
