#![cfg(feature = "vnc")]
//! VNC (RFB) Integration Tests (VNC-01 through VNC-04).
//!
//! Exercises termiHub's `vnc` graphical backend against a real VNC server — the
//! live negotiate -> authenticate -> decode path (#1681/#1715) that only exists
//! against an actual RFB server. Per-PR CI runs `-m "not integration"` and never
//! brings up Docker, so this path is otherwise uncovered; these tests are the
//! `require_docker!`-gated coverage that a *local* container run verifies.
//!
//! Container: `vnc-server` on port 2501 (base; per-checkout offset applied).
//! It serves a static four-quadrant test pattern (TL red, TR green, BL blue,
//! BR white) at 1024x768 over classic RFB VncAuth, password `testpass`.
//!
//! Requires: `cd tests/docker && docker compose up -d vnc-server`
//! (or `docker compose --profile vnc up -d`). Skips gracefully otherwise.

mod common;

use std::time::Duration;

use common::{port_vnc, require_docker};
use termihub_core::backends::vnc::Vnc;
use termihub_core::connection::{ConnectionType, FrameUpdate, InputEvent};

/// The fixture's password (see `tests/docker/vnc-server`).
const VNC_PASSWORD: &str = "testpass";
/// The fixture's framebuffer geometry.
const FB_WIDTH: u32 = 1024;
const FB_HEIGHT: u32 = 768;

/// Settings JSON for the fixture with the correct password.
fn vnc_settings(port: u16) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "password": VNC_PASSWORD,
    })
}

/// A reconstructed RGBA framebuffer, assembled from decoded dirty rects.
struct Framebuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
    fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: Vec::new(),
        }
    }

    /// Resize to `width` x `height`, preserving already-painted pixels where the
    /// dimensions overlap (the first frame usually establishes the final size).
    fn resize(&mut self, width: u32, height: u32) {
        if width == self.width && height == self.height {
            return;
        }
        let mut next = vec![0u8; (width as usize) * (height as usize) * 4];
        let copy_w = self.width.min(width) as usize;
        let copy_h = self.height.min(height) as usize;
        for row in 0..copy_h {
            let src = row * self.width as usize * 4;
            let dst = row * width as usize * 4;
            next[dst..dst + copy_w * 4].copy_from_slice(&self.pixels[src..src + copy_w * 4]);
        }
        self.width = width;
        self.height = height;
        self.pixels = next;
    }

    /// Fold every dirty rect of a decoded `FrameUpdate` into the framebuffer.
    fn apply(&mut self, frame: &FrameUpdate) {
        if frame.width > 0 && frame.height > 0 {
            self.resize(frame.width, frame.height);
        }
        for rect in &frame.rects {
            let expected = (rect.width as usize) * (rect.height as usize) * 4;
            if rect.data.len() != expected {
                continue;
            }
            for row in 0..rect.height {
                let dy = rect.y + row;
                if dy >= self.height {
                    break;
                }
                let dst = (dy as usize * self.width as usize + rect.x as usize) * 4;
                let src = (row as usize * rect.width as usize) * 4;
                let copy_w = (rect.width.min(self.width.saturating_sub(rect.x)) as usize) * 4;
                if copy_w == 0 {
                    continue;
                }
                self.pixels[dst..dst + copy_w].copy_from_slice(&rect.data[src..src + copy_w]);
            }
        }
    }

    /// RGBA of the pixel at (`x`, `y`), or `None` if unpainted / out of range.
    fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let i = (y as usize * self.width as usize + x as usize) * 4;
        let p = [
            self.pixels[i],
            self.pixels[i + 1],
            self.pixels[i + 2],
            self.pixels[i + 3],
        ];
        Some(p)
    }
}

// ── VNC-01: Connect and authenticate ────────────────────────────────

#[tokio::test]
async fn vnc_01_connect_and_authenticate() {
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(vnc_settings(port_vnc()))
        .await
        .expect("VNC-01: connect + VncAuth should succeed against the fixture");

    assert!(vnc.is_connected(), "VNC-01: session should be connected");
    assert!(
        vnc.graphical().is_some(),
        "VNC-01: a connected VNC session exposes the graphical backend"
    );

    vnc.disconnect().await.expect("disconnect should succeed");
    assert!(!vnc.is_connected(), "VNC-01: disconnect clears the session");
}

// ── VNC-02: Decode a real framebuffer end to end ────────────────────

#[tokio::test]
async fn vnc_02_decode_frame() {
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(vnc_settings(port_vnc()))
        .await
        .expect("VNC-02: connect should succeed");

    let graphical = vnc.graphical().expect("VNC-02: graphical backend present");
    let mut frames = graphical.subscribe_frames();

    // Quadrant sample points and their expected colours (see the fixture).
    let quarter_w = FB_WIDTH / 4;
    let quarter_h = FB_HEIGHT / 4;
    let samples: [(u32, u32, &str); 4] = [
        (quarter_w, quarter_h, "red"),               // top-left
        (3 * quarter_w, quarter_h, "green"),         // top-right
        (quarter_w, 3 * quarter_h, "blue"),          // bottom-left
        (3 * quarter_w, 3 * quarter_h, "white"),     // bottom-right
    ];

    let mut fb = Framebuffer::new();
    let mut frame_count = 0usize;

    // Accumulate decoded frames until the whole pattern is painted.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let all_painted = loop {
        match tokio::time::timeout_at(deadline, frames.recv()).await {
            Ok(Some(frame)) => {
                frame_count += 1;
                fb.apply(&frame);
                if samples
                    .iter()
                    .all(|(x, y, _)| fb.pixel(*x, *y).is_some_and(|p| p != [0, 0, 0, 0]))
                {
                    break true;
                }
            }
            Ok(None) => break false,
            Err(_) => break false,
        }
    };

    assert!(frame_count > 0, "VNC-02: at least one FrameUpdate must arrive");
    assert_eq!(
        (fb.width, fb.height),
        (FB_WIDTH, FB_HEIGHT),
        "VNC-02: decoded framebuffer geometry should match the fixture"
    );
    assert!(
        all_painted,
        "VNC-02: timed out before the full test pattern decoded ({frame_count} frames)"
    );

    // Every quadrant must decode to its known solid colour. Solid regions carry
    // no lossy compression, so a wide tolerance still proves an exact decode.
    for (x, y, expected) in samples {
        let [r, g, b, a] = fb.pixel(x, y).expect("sampled pixel painted");
        let ok = match expected {
            "red" => r > 200 && g < 60 && b < 60,
            "green" => g > 200 && r < 60 && b < 60,
            "blue" => b > 200 && r < 60 && g < 60,
            "white" => r > 200 && g > 200 && b > 200,
            _ => unreachable!(),
        };
        assert!(
            ok,
            "VNC-02: quadrant at ({x},{y}) expected {expected}, decoded rgba=({r},{g},{b},{a})"
        );
    }

    vnc.disconnect().await.expect("disconnect should succeed");
}

// ── VNC-03: Input and clipboard round-trip over the live wire ───────

#[tokio::test]
async fn vnc_03_input_and_clipboard() {
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(vnc_settings(port_vnc()))
        .await
        .expect("VNC-03: connect should succeed");

    let graphical = vnc.graphical().expect("VNC-03: graphical backend present");

    // Pointer + key events serialise to RFB PointerEvent / KeyEvent and are
    // written to the live socket; success proves the input path reaches the
    // server without erroring.
    graphical
        .send_input(InputEvent::Pointer {
            x: 100,
            y: 100,
            buttons: 0,
        })
        .await
        .expect("VNC-03: pointer event should reach the server");
    graphical
        .send_input(InputEvent::Key {
            code: "KeyA".to_string(),
            pressed: true,
        })
        .await
        .expect("VNC-03: key-down should reach the server");
    graphical
        .send_input(InputEvent::Key {
            code: "KeyA".to_string(),
            pressed: false,
        })
        .await
        .expect("VNC-03: key-up should reach the server");

    // Clipboard client->server: set_clipboard sends an RFB ClientCutText.
    graphical
        .set_clipboard("termiHub vnc clipboard".to_string())
        .await
        .expect("VNC-03: set_clipboard should reach the server");

    // get_clipboard reads the last server-pushed cut text; the fixture pushes
    // none, so this must not error and simply reports no remote clipboard.
    let remote = graphical.get_clipboard().await;
    assert!(
        remote.is_none(),
        "VNC-03: fixture pushes no clipboard, expected None, got {remote:?}"
    );

    vnc.disconnect().await.expect("disconnect should succeed");
}

// ── VNC-04: Wrong password is rejected ──────────────────────────────

#[tokio::test]
async fn vnc_04_wrong_password_rejected() {
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port_vnc(),
        "password": "wrongpw",
    });

    let result = vnc.connect(settings).await;
    assert!(
        result.is_err(),
        "VNC-04: VncAuth with a wrong password must fail, got {result:?}"
    );
    assert!(
        !vnc.is_connected(),
        "VNC-04: a rejected auth leaves the session disconnected"
    );
}
