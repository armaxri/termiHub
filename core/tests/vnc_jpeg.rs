#![cfg(feature = "vnc")]
//! VNC Tight JPEG integration test (VNC-18, #4821).
//!
//! The `vnc-jpeg-server` fixture (TigerVNC Xvnc, classic VncAuth, port 2504;
//! see `tests/docker/vnc-jpeg-server`) serves a 1024x768 grey desktop with a
//! smooth 512x384 gradient at the top left, which a Tight encoder sends as
//! JPEG, and loops a server-side copy of that gradient onto the bottom-right
//! 512x384 (fill grey, then X `CopyArea`, which Xvnc sends as an RFB CopyRect).
//!
//! This is the live proof of the JPEG pass-through path (#4424): JPEG rects
//! arrive carrying their compressed source ([`DirtyRect::jpeg`]), their decoded
//! RGBA matches the known gradient within a JPEG tolerance, and a CopyRect whose
//! source is the JPEG area resolves to exactly the decoded pixels — i.e. the
//! backend's shadow framebuffer holds the decoded JPEG, not stale black.
//!
//! Requires: `cd tests/docker && docker compose --profile vnc up -d
//! vnc-jpeg-server`. Skips gracefully otherwise. Port via
//! `TERMIHUB_TEST_VNC_JPEG_PORT` (per-checkout offset applied).

mod common;

use std::time::Duration;

use common::{port_vnc_jpeg, require_docker};
use termihub_core::backends::vnc::Vnc;
use termihub_core::connection::{ConnectionType, DirtyRect};

/// The fixture's framebuffer and gradient geometry (see `make_pattern.py`).
const FB_W: u32 = 1024;
const FB_H: u32 = 768;
const GRAD_W: u32 = 512;
const GRAD_H: u32 = 384;
/// Origin of the CopyRect target the fixture copies the gradient onto.
const TARGET: (u32, u32) = (512, 384);
/// The grey the fixture fills the background (and the target) with.
const GREY: u8 = 64;
/// Max per-channel error of a JPEG-decoded gradient pixel.
const JPEG_TOLERANCE: i16 = 24;

/// Expected RGB of the gradient at (`x`, `y`) within the gradient area.
fn gradient(x: u32, y: u32) -> [u8; 3] {
    [
        (x * 255 / (GRAD_W - 1)) as u8,
        (y * 255 / (GRAD_H - 1)) as u8,
        160,
    ]
}

/// The client-side framebuffer, folded from every decoded rect in order.
struct Framebuffer(Vec<u8>);

impl Framebuffer {
    fn new() -> Self {
        Self(vec![0; (FB_W * FB_H * 4) as usize])
    }

    fn offset(x: u32, y: u32) -> usize {
        ((y * FB_W + x) * 4) as usize
    }

    fn apply(&mut self, rect: &DirtyRect) {
        if rect.x + rect.width > FB_W || rect.y + rect.height > FB_H {
            return;
        }
        let row = (rect.width * 4) as usize;
        for r in 0..rect.height {
            let dst = Self::offset(rect.x, rect.y + r);
            let src = r as usize * row;
            self.0[dst..dst + row].copy_from_slice(&rect.data[src..src + row]);
        }
    }

    /// The RGBA of a `w x h` region, row-major.
    fn region(&self, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
        let row = (w * 4) as usize;
        let mut out = Vec::with_capacity(row * h as usize);
        for r in 0..h {
            let start = Self::offset(x, y + r);
            out.extend_from_slice(&self.0[start..start + row]);
        }
        out
    }

    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = Self::offset(x, y);
        [self.0[i], self.0[i + 1], self.0[i + 2], self.0[i + 3]]
    }
}

/// Sample points well inside the gradient (away from its edges).
fn gradient_samples() -> Vec<(u32, u32)> {
    let mut points = Vec::new();
    for fx in [0.1, 0.3, 0.5, 0.7, 0.9] {
        for fy in [0.1, 0.5, 0.9] {
            points.push(((GRAD_W as f64 * fx) as u32, (GRAD_H as f64 * fy) as u32));
        }
    }
    points
}

/// Whether `rgba` is opaque and within the JPEG tolerance of `rgb`.
fn near(rgba: [u8; 4], rgb: [u8; 3]) -> bool {
    rgba[3] == 255
        && rgba[..3]
            .iter()
            .zip(rgb)
            .all(|(&got, want)| (got as i16 - want as i16).abs() <= JPEG_TOLERANCE)
}

/// Whether the gradient (at `origin`) shows the known colours within tolerance.
fn gradient_matches(fb: &Framebuffer, origin: (u32, u32)) -> bool {
    gradient_samples()
        .into_iter()
        .all(|(x, y)| near(fb.pixel(origin.0 + x, origin.1 + y), gradient(x, y)))
}

/// A rect inside the CopyRect target whose pixels are exactly the current
/// pixels of the matching source area, and are not the grey fill: a CopyRect
/// resolved from the backend's shadow. A re-encoded (JPEG) copy would never be
/// bit-identical, and the fill is grey.
fn is_resolved_copy(fb: &Framebuffer, rect: &DirtyRect) -> bool {
    let inside = rect.x >= TARGET.0
        && rect.y >= TARGET.1
        && rect.x + rect.width <= TARGET.0 + GRAD_W
        && rect.y + rect.height <= TARGET.1 + GRAD_H;
    if !inside || rect.jpeg.is_some() || rect.width < 64 || rect.height < 64 {
        return false;
    }
    let source = fb.region(
        rect.x - TARGET.0,
        rect.y - TARGET.1,
        rect.width,
        rect.height,
    );
    let not_grey = rect.data.as_chunks::<4>().0.iter().any(|p| p[0] != GREY);
    rect.data == source && not_grey
}

#[tokio::test]
async fn vnc_18_tight_jpeg_rects_pass_through_and_copy_rect_resolves() {
    require_docker!(port_vnc_jpeg());

    let mut vnc = Vnc::new();
    vnc.connect(serde_json::json!({
        "host": "127.0.0.1",
        "port": port_vnc_jpeg(),
        "password": "testpass",
        "quality": "high",
    }))
    .await
    .expect("VNC-18: connect should succeed");
    let mut frames = vnc
        .graphical()
        .expect("graphical backend")
        .subscribe_frames();

    let mut fb = Framebuffer::new();
    let mut jpeg_rects = 0usize;
    let mut copy_seen = false;
    // The fixture copies every 4 s; allow several cycles.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        let frame = match tokio::time::timeout_at(deadline, frames.recv()).await {
            Ok(Some(frame)) => frame,
            Ok(None) => panic!("VNC-18: frame stream closed"),
            Err(_) => break,
        };
        assert_eq!((frame.width, frame.height), (FB_W, FB_H));
        for rect in &frame.rects {
            if let Some(jpeg) = &rect.jpeg {
                jpeg_rects += 1;
                assert!(jpeg.starts_with(&[0xFF, 0xD8]), "VNC-18: not a JPEG stream");
                assert_eq!(
                    rect.data.len(),
                    (rect.width * rect.height * 4) as usize,
                    "VNC-18: a JPEG rect's decoded RGBA must match its size"
                );
            }
            // Checked against the framebuffer *before* the rect is applied.
            copy_seen |= gradient_matches(&fb, (0, 0)) && is_resolved_copy(&fb, rect);
            fb.apply(rect);
        }
        if jpeg_rects > 0 && copy_seen && gradient_matches(&fb, (0, 0)) {
            break;
        }
    }

    assert!(
        jpeg_rects > 0,
        "VNC-18: the server never sent a Tight JPEG rect"
    );
    assert!(
        gradient_matches(&fb, (0, 0)),
        "VNC-18: the JPEG-decoded gradient does not match the reference"
    );
    assert!(
        copy_seen,
        "VNC-18: no CopyRect over the JPEG area resolved to the decoded pixels"
    );
    vnc.disconnect().await.expect("disconnect should succeed");
}
