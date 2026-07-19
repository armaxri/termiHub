#![cfg(feature = "vnc")]
//! VNC (RFB) Integration Tests (VNC-01 through VNC-07).
//!
//! Exercises termiHub's `vnc` graphical backend against a real VNC server — the
//! live negotiate -> authenticate -> decode path (#1681/#1715) that only exists
//! against an actual RFB server. Per-PR CI runs `-m "not integration"` and never
//! brings up Docker, so this path is otherwise uncovered; these tests are the
//! `require_docker!`-gated coverage that a *local* container run verifies.
//!
//! Two fixtures, both under the `vnc` compose profile:
//!
//! * `vnc-server` on port 2501 (x11vnc + Xvfb) — classic RFB VncAuth, password
//!   `testpass`. Covers VNC-01..05.
//! * `vnc-vencrypt-server` on port 2502 (TigerVNC Xvnc) — VeNCrypt (RFB security
//!   type 19, X509Vnc sub-type): a TLS handshake then the VNC-password stage.
//!   Covers VNC-06 (`tlsVerify=insecure`) and VNC-07 (`tlsVerify=ca`), the
//!   VeNCrypt/TLS path added in #1714.
//!
//! Both serve the same static four-quadrant test pattern (TL red, TR green,
//! BL blue, BR white) at 1024x768, so a decoded framebuffer asserts exactly.
//!
//! Requires: `cd tests/docker && docker compose --profile vnc up -d`
//! (brings up both fixtures). Skips gracefully otherwise. Ports via
//! `TERMIHUB_TEST_VNC_PORT` / `TERMIHUB_TEST_VNC_VENCRYPT_PORT` (per-checkout
//! offset applied).

mod common;

use std::time::Duration;

use common::{port_vnc, port_vnc_vencrypt, require_docker};
use termihub_core::backends::vnc::Vnc;
use termihub_core::connection::{ConnectionType, FrameUpdate, InputEvent};

/// The fixture's password (see `tests/docker/vnc-server`).
const VNC_PASSWORD: &str = "testpass";
/// The fixture's framebuffer geometry.
const FB_WIDTH: u32 = 1024;
const FB_HEIGHT: u32 = 768;
/// The known X selection the fixture owns, which x11vnc forwards to the client
/// as an RFB `ServerCutText`. MUST match `CLIPBOARD_TEXT` in
/// `tests/docker/vnc-server/entrypoint.sh`.
const VNC_SERVER_CLIPBOARD: &str = "termiHub vnc server clipboard 4711";

/// Settings JSON for the fixture with the correct password.
fn vnc_settings(port: u16) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "password": VNC_PASSWORD,
    })
}

/// Path to the VeNCrypt fixture's committed CA certificate
/// (`tests/docker/vnc-vencrypt-server/certs/ca.crt`), used by the `tlsVerify=ca`
/// test to trust the fixture's self-signed leaf.
fn vencrypt_ca_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate should be in workspace root")
        .join("tests")
        .join("docker")
        .join("vnc-vencrypt-server")
        .join("certs")
        .join("ca.crt")
}

/// Settings JSON for the VeNCrypt X509 fixture. The backend auto-negotiates
/// VeNCrypt (security type 19) when the server offers it, then runs the VNC
/// password (X509Vnc) second stage. `tls_verify` picks the certificate policy:
/// `"insecure"` accepts the self-signed leaf, `"ca"` trusts `ca_path`.
fn vencrypt_settings(port: u16, tls_verify: &str, ca_path: Option<&str>) -> serde_json::Value {
    let mut settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "password": VNC_PASSWORD,
        "tlsVerify": tls_verify,
    });
    if let Some(path) = ca_path {
        settings["tlsCaPath"] = serde_json::Value::String(path.to_string());
    }
    settings
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

/// Subscribe to an already-connected session's frames, accumulate decoded dirty
/// rects until the whole four-quadrant pattern is painted, and assert every
/// quadrant decoded to its known solid colour. Shared by the plain VncAuth
/// decode test and the VeNCrypt (TLS) decode tests — the decode path is identical
/// once the session is connected, only the auth/transport differs.
async fn assert_pattern_decodes(vnc: &Vnc, label: &str) {
    let graphical = vnc
        .graphical()
        .unwrap_or_else(|| panic!("{label}: graphical backend present"));
    let mut frames = graphical.subscribe_frames();

    // Quadrant sample points and their expected colours (see the fixture).
    let quarter_w = FB_WIDTH / 4;
    let quarter_h = FB_HEIGHT / 4;
    let samples: [(u32, u32, &str); 4] = [
        (quarter_w, quarter_h, "red"),           // top-left
        (3 * quarter_w, quarter_h, "green"),     // top-right
        (quarter_w, 3 * quarter_h, "blue"),      // bottom-left
        (3 * quarter_w, 3 * quarter_h, "white"), // bottom-right
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

    assert!(
        frame_count > 0,
        "{label}: at least one FrameUpdate must arrive"
    );
    assert_eq!(
        (fb.width, fb.height),
        (FB_WIDTH, FB_HEIGHT),
        "{label}: decoded framebuffer geometry should match the fixture"
    );
    assert!(
        all_painted,
        "{label}: timed out before the full test pattern decoded ({frame_count} frames)"
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
            "{label}: quadrant at ({x},{y}) expected {expected}, decoded rgba=({r},{g},{b},{a})"
        );
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

    assert_pattern_decodes(&vnc, "VNC-02").await;

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

    // get_clipboard reads the last server-pushed cut text. It must never error;
    // its value is timing-dependent (the fixture pushes asynchronously), so the
    // deterministic server->client assertion lives in VNC-05, not here.
    let _ = graphical.get_clipboard().await;

    vnc.disconnect().await.expect("disconnect should succeed");
}

// ── VNC-05: Server->client clipboard echo (ServerCutText) ───────────

#[tokio::test]
async fn vnc_05_server_clipboard_echo() {
    require_docker!(port_vnc());

    let mut vnc = Vnc::new();
    vnc.connect(vnc_settings(port_vnc()))
        .await
        .expect("VNC-05: connect should succeed");

    let graphical = vnc.graphical().expect("VNC-05: graphical backend present");

    // The fixture owns a known X selection that x11vnc forwards as an RFB
    // ServerCutText; the backend routes it (VncEvent::Text) into get_clipboard.
    // Delivery is asynchronous and the fixture alternates the selection with a
    // priming value to force genuine changes, so get_clipboard may transiently
    // report the priming value — poll until the known value surfaces. The
    // timeout is generous because x11vnc's selection forwarding takes a little
    // while to warm up after the fixture starts (see tests/docker/vnc-server).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut received = None;
    while tokio::time::Instant::now() < deadline {
        received = graphical.get_clipboard().await;
        if received.as_deref() == Some(VNC_SERVER_CLIPBOARD) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    assert_eq!(
        received.as_deref(),
        Some(VNC_SERVER_CLIPBOARD),
        "VNC-05: expected the server->client clipboard echo to surface the \
         fixture's known selection, got {received:?}"
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

// ── VNC-06: VeNCrypt X509 (insecure), connect + decode ──────────────

/// Connect to the VeNCrypt fixture accepting its self-signed leaf
/// (`tlsVerify=insecure`) and decode the pattern end to end. Proves the vendored
/// `vnc-rs` fork's VeNCrypt X509 negotiation + TLS handshake + VNC-password
/// second stage works against a real server — not just the loopback unit tests.
#[tokio::test]
async fn vnc_06_vencrypt_insecure_connect_and_decode() {
    require_docker!(port_vnc_vencrypt());

    let mut vnc = Vnc::new();
    vnc.connect(vencrypt_settings(port_vnc_vencrypt(), "insecure", None))
        .await
        .expect("VNC-06: VeNCrypt X509 connect (insecure) should succeed against the fixture");

    assert!(vnc.is_connected(), "VNC-06: session should be connected");
    assert_pattern_decodes(&vnc, "VNC-06").await;

    vnc.disconnect().await.expect("disconnect should succeed");
}

// ── VNC-07: VeNCrypt X509 (custom CA), connect + decode ─────────────

/// Connect to the VeNCrypt fixture verifying its leaf against the committed CA
/// (`tlsVerify=ca`, `tlsCaPath` -> the fixture's `ca.crt`) and decode the
/// pattern. Proves the `TlsVerify::CaPem` path: the client builds a trust anchor
/// from the fixture CA and the leaf validates (IP SAN `127.0.0.1`) end to end.
#[tokio::test]
async fn vnc_07_vencrypt_custom_ca_connect_and_decode() {
    require_docker!(port_vnc_vencrypt());

    let ca_path = vencrypt_ca_path();
    let ca_path = ca_path.to_str().expect("CA path is valid UTF-8");

    let mut vnc = Vnc::new();
    vnc.connect(vencrypt_settings(port_vnc_vencrypt(), "ca", Some(ca_path)))
        .await
        .expect("VNC-07: VeNCrypt X509 connect (custom CA) should succeed against the fixture");

    assert!(vnc.is_connected(), "VNC-07: session should be connected");
    assert_pattern_decodes(&vnc, "VNC-07").await;

    vnc.disconnect().await.expect("disconnect should succeed");
}
