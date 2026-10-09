#![cfg(feature = "rdp-sidecar")]
//! RDP Integration Tests (RDP-01 through RDP-16, #3609 / TIN-005).
//!
//! Exercises termiHub's `rdp` graphical backend — the IronRDP sidecar
//! (`termihub-rdp-helper`) spawned and bridged by [`SidecarRdp`] — against a
//! real RDP server. The connect -> TLS -> logon -> decode path runs inside the
//! sidecar and only exists against an actual server; per-PR CI never brings up
//! Docker, so these `require_docker!`-gated tests are its automated coverage
//! (the Docker-fixture integration lane runs them nightly).
//!
//! Fixture: `rdp-server` (xrdp 0.10 + xorgxrdp, `tests/docker/rdp-server`) on
//! port 2601 (per-checkout offset applied; `TERMIHUB_TEST_RDP_PORT` overrides),
//! TLS security, user `testuser` / `testpass`. The session paints its whole
//! root window pure red and runs a `ping:` -> `pong:` clipboard echo loop.
//!
//! Requires: `cd tests/docker && docker compose --profile rdp up -d` and a
//! built sidecar (`./scripts/build-rdp-sidecar.sh`). The helper is taken from
//! `$TERMIHUB_RDP_HELPER`, else `rdp-sidecar/target/{debug,release}/`. Skips
//! gracefully when either is missing — unless `TERMIHUB_REQUIRE_DOCKER=1`, where
//! a missing fixture or helper is a hard failure.
//!
//! Every test holds [`SERIAL`]: they share one xrdp session (the same user
//! reconnects to it, and RDP-03 resizes it), and the orphan checks count *this
//! process's* sidecar children, which a concurrently running test would add to.

mod common;

use std::path::PathBuf;
use std::time::Duration;

use common::{port_rdp, port_rdp_nla, require_docker};
use termihub_core::backends::rdp_sidecar::{SidecarRdp, HELPER_PATH_ENV};
use termihub_core::connection::{
    ClipboardImage, ConnectionType, FrameReceiver, FrameUpdate, GraphicalBackend, InputEvent,
    MonitorLayout,
};
use termihub_core::errors::SessionError;

/// The fixture's test user (see `tests/docker/rdp-server/Dockerfile`).
const RDP_USER: &str = "testuser";
const RDP_PASSWORD: &str = "testpass";
/// The dynamic-mode initial desktop size the sidecar requests
/// (`rdp_sidecar::config::DEFAULT_WIDTH` x `DEFAULT_HEIGHT`).
const DYNAMIC_WIDTH: u32 = 1280;
const DYNAMIC_HEIGHT: u32 = 800;
/// Binary name of the sidecar (the orphan check matches process args on it).
const HELPER_NAME: &str = "termihub-rdp-helper";

/// Serializes every test in this binary (see the module docs).
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Point the backend at a built sidecar, or skip / hard-fail like
/// `require_docker!` when none exists. Setting [`HELPER_PATH_ENV`] also skips
/// the release-only integrity digest check, exactly as a dev build does.
fn require_helper() -> bool {
    if let Some(path) = std::env::var_os(HELPER_PATH_ENV) {
        let path = PathBuf::from(path);
        return common::require_fixture(
            path.is_file(),
            common::docker_required(),
            "RDP sidecar ($TERMIHUB_RDP_HELPER)",
            port_rdp(),
            "point TERMIHUB_RDP_HELPER at a built termihub-rdp-helper",
        );
    }
    let exe = if cfg!(windows) {
        format!("{HELPER_NAME}.exe")
    } else {
        HELPER_NAME.to_string()
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core crate should be in workspace root")
        .join("rdp-sidecar")
        .join("target");
    let found = ["debug", "release"]
        .iter()
        .map(|profile| root.join(profile).join(&exe))
        .find(|p| p.is_file());
    if let Some(path) = &found {
        // Tests in this binary are serialized and all want the same value, so
        // the process-wide write is race-free in practice (edition 2021: safe).
        std::env::set_var(HELPER_PATH_ENV, path);
    }
    common::require_fixture(
        found.is_some(),
        common::docker_required(),
        "RDP sidecar binary",
        port_rdp(),
        "build it with ./scripts/build-rdp-sidecar.sh",
    )
}

/// Skip (or hard-fail) unless both the fixture and the sidecar are available.
macro_rules! require_rdp {
    () => {
        require_docker!(port_rdp());
        if !require_helper() {
            return;
        }
    };
}

/// Settings for the fixture. The fixture serves xrdp's self-signed certificate,
/// so certificate errors are ignored (RDP-06 covers the prompt path).
fn rdp_settings(port: u16, password: &str) -> serde_json::Value {
    serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": RDP_USER,
        "password": password,
        "securityMode": "auto",
        "ignoreCertErrors": true,
    })
}

// ── Framebuffer reconstruction ──────────────────────────────────────

/// A reconstructed RGBA framebuffer, assembled from decoded dirty rects.
#[derive(Default)]
struct Framebuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
    /// Fold one `FrameUpdate` in; a size change starts a fresh (unpainted)
    /// buffer, since the remote repaints everything after a resize.
    fn apply(&mut self, frame: &FrameUpdate) {
        if frame.width > 0
            && frame.height > 0
            && (frame.width, frame.height) != (self.width, self.height)
        {
            self.width = frame.width;
            self.height = frame.height;
            self.pixels = vec![0u8; (frame.width as usize) * (frame.height as usize) * 4];
        }
        for rect in &frame.rects {
            if rect.data.len() != (rect.width as usize) * (rect.height as usize) * 4 {
                continue;
            }
            for row in 0..rect.height {
                let dy = rect.y + row;
                if dy >= self.height || rect.x >= self.width {
                    break;
                }
                let copy_w = rect.width.min(self.width - rect.x) as usize * 4;
                let dst = (dy as usize * self.width as usize + rect.x as usize) * 4;
                let src = row as usize * rect.width as usize * 4;
                self.pixels[dst..dst + copy_w].copy_from_slice(&rect.data[src..src + copy_w]);
            }
        }
    }

    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = (y as usize * self.width as usize + x as usize) * 4;
        [
            self.pixels[i],
            self.pixels[i + 1],
            self.pixels[i + 2],
            self.pixels[i + 3],
        ]
    }

    /// Sample points spread over the whole desktop (a 5x5 grid inset from the
    /// edges), so "red everywhere" means the full session desktop decoded — not
    /// one stray rect.
    fn samples(&self) -> Vec<(u32, u32)> {
        let mut points = Vec::new();
        for i in 1..=5 {
            for j in 1..=5 {
                points.push((self.width * i / 6, self.height * j / 6));
            }
        }
        points
    }

    /// Whether every sample point decoded to the solid `color` desktop. xrdp's
    /// login screen and an unpainted buffer are neither colour, so this proves
    /// the logged-in session itself was rendered.
    fn is_solid(&self, color: Solid) -> bool {
        self.width > 0
            && self.samples().iter().all(|&(x, y)| {
                let [r, g, b, _] = self.pixel(x, y);
                match color {
                    Solid::Red => r > 200 && g < 60 && b < 60,
                    Solid::Blue => b > 200 && r < 60 && g < 60,
                }
            })
    }
}

/// The solid desktop colour each fixture server paints.
#[derive(Debug, Clone, Copy)]
enum Solid {
    /// xrdp session root (`tests/docker/rdp-server/startwm.sh`).
    Red,
    /// FreeRDP shadow server's Xvfb root (`tests/docker/rdp-server/entrypoint.sh`).
    Blue,
}

/// Accumulate frames until the decoded desktop is `width` x `height` and fully
/// painted `color`. Panics with the last observed state.
async fn wait_for_desktop(
    frames: &mut FrameReceiver,
    color: Solid,
    width: u32,
    height: u32,
    label: &str,
) {
    let mut fb = Framebuffer::default();
    let mut count = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        match tokio::time::timeout_at(deadline, frames.recv()).await {
            Ok(Some(frame)) => {
                count += 1;
                fb.apply(&frame);
                if (fb.width, fb.height) == (width, height) && fb.is_solid(color) {
                    return;
                }
            }
            Ok(None) => panic!(
                "{label}: frame stream ended after {count} frames at {}x{}",
                fb.width, fb.height
            ),
            Err(_) => {
                let center = if fb.width > 0 {
                    Some(fb.pixel(fb.width / 2, fb.height / 2))
                } else {
                    None
                };
                panic!(
                    "{label}: no fully {color:?} {width}x{height} desktop within 60s \
                     ({count} frames, last {}x{}, centre rgba {center:?})",
                    fb.width, fb.height
                );
            }
        }
    }
}

/// [`wait_for_desktop`] for the xrdp session at the dynamic-mode initial size.
async fn wait_for_xrdp_session(frames: &mut FrameReceiver, label: &str) {
    wait_for_desktop(frames, Solid::Red, DYNAMIC_WIDTH, DYNAMIC_HEIGHT, label).await;
}

// ── Sidecar process inspection (orphan check) ───────────────────────

/// PIDs of the running `termihub-rdp-helper` processes whose parent is THIS
/// test process — i.e. only sidecars these tests spawned, never another
/// checkout's or a real app's. Zombies (exited, not yet reaped) are excluded:
/// they are no longer running. Never kills anything.
#[cfg(unix)]
fn own_helper_pids() -> Vec<u32> {
    let me = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,stat=,args="])
        .output()
        .expect("ps should run");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let pid: u32 = cols.next()?.parse().ok()?;
            let ppid: u32 = cols.next()?.parse().ok()?;
            let stat = cols.next()?;
            let args = cols.collect::<Vec<_>>().join(" ");
            (ppid == me && !stat.starts_with('Z') && args.contains(HELPER_NAME)).then_some(pid)
        })
        .collect()
}

/// Windows has no `ps`; the orphan check runs on the Linux/macOS lanes.
#[cfg(not(unix))]
fn own_helper_pids() -> Vec<u32> {
    Vec::new()
}

/// The single sidecar this test's connect spawned (none may exist beforehand).
/// For a session that must stay up, so the helper is guaranteed to be running
/// when this is sampled — proving the orphan check below watches a real PID.
fn spawned_helper_pid(label: &str) -> Option<u32> {
    if cfg!(not(unix)) {
        return None;
    }
    let pids = own_helper_pids();
    assert_eq!(
        pids.len(),
        1,
        "{label}: exactly one running sidecar child expected, found {pids:?}"
    );
    Some(pids[0])
}

/// Like [`spawned_helper_pid`], for a session that is rejected: the helper may
/// already have exited by the time this samples, so none is also fine.
fn rejected_helper_pid(label: &str) -> Option<u32> {
    let pids = own_helper_pids();
    assert!(
        pids.len() <= 1,
        "{label}: at most one running sidecar child expected, found {pids:?}"
    );
    pids.first().copied()
}

/// Assert no sidecar child of this process is still running within a few
/// seconds (exited and reaped, or a zombie awaiting reaping). `pid` is the one
/// the test saw running, for the failure message.
async fn assert_helper_gone(pid: Option<u32>, label: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let pids = own_helper_pids();
        if pids.is_empty() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("{label}: sidecar {pid:?} still running after the session (children: {pids:?})");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Precondition for the orphan checks: no sidecar child left over from an
/// earlier test in this process.
fn assert_no_helpers(label: &str) {
    let pids = own_helper_pids();
    assert!(
        pids.is_empty(),
        "{label}: leftover sidecar children before connect: {pids:?}"
    );
}

// ── RDP-01: connect, logon and first frame through the real sidecar ─

#[tokio::test]
async fn rdp_01_connect_and_first_frame() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-01");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-01: connect should spawn the sidecar and hand it the config");
    assert!(rdp.is_connected(), "RDP-01: session should be connected");
    let pid = spawned_helper_pid("RDP-01");

    let graphical = rdp.graphical().expect("RDP-01: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    // The session desktop (not xrdp's login screen) decodes at the requested
    // dynamic-mode size: proves TLS, the credential logon and decode end to end.
    wait_for_xrdp_session(&mut frames, "RDP-01").await;
    assert!(
        rdp.fatal_error().is_none(),
        "RDP-01: a healthy session reports no fatal error"
    );

    rdp.disconnect().await.expect("disconnect should succeed");
    assert!(!rdp.is_connected(), "RDP-01: disconnect clears the session");
    assert_helper_gone(pid, "RDP-01").await;
}

// ── RDP-02: fixed resolution is honoured by the server ──────────────

#[tokio::test]
async fn rdp_02_fixed_resolution() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-02");

    let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
    settings["resolutionMode"] = serde_json::json!("fixed");
    settings["width"] = serde_json::json!(1024);
    settings["height"] = serde_json::json!(768);
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings).await.expect("RDP-02: fixed connect");
    let pid = spawned_helper_pid("RDP-02");
    let mut frames = rdp.graphical().expect("graphical").subscribe_frames();
    wait_for_desktop(&mut frames, Solid::Red, 1024, 768, "RDP-02").await;

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-02").await;
}

// ── RDP-03: dynamic resize over Display Control (#1755, #3465) ──────

/// Ask for `(w, h)` over Display Control until the desktop reflows to it and
/// shows the solid red session again. The channel may still be opening right
/// after the first frame (or right after a reactivation); a request sent
/// before it is ready is dropped by design, so the request is re-sent.
async fn resize_until(
    graphical: &dyn GraphicalBackend,
    frames: &mut FrameReceiver,
    fb: &mut Framebuffer,
    (w, h): (u32, u32),
    label: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        graphical
            .resize(w as u16, h as u16)
            .await
            .unwrap_or_else(|e| panic!("{label}: resize request should be accepted: {e}"));
        let window = tokio::time::Instant::now() + Duration::from_secs(3);
        while let Ok(next) = tokio::time::timeout_at(window, frames.recv()).await {
            let frame =
                next.unwrap_or_else(|| panic!("{label}: the session ended instead of resizing"));
            fb.apply(&frame);
            if (fb.width, fb.height) == (w, h) && fb.is_solid(Solid::Red) {
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{label}: desktop never became {w}x{h} (last {}x{})",
            fb.width,
            fb.height
        );
    }
}

/// xrdp resizes with a Deactivation-Reactivation Sequence whose Deactivate
/// All PDU is a bare 6-byte header (#3611). The sidecar must decode it, redo
/// the capability exchange, and carry on at the new size — twice, so the
/// session provably survives a reactivation and can reactivate again.
#[tokio::test]
async fn rdp_03_dynamic_resize() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-03");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-03: connect");
    let pid = spawned_helper_pid("RDP-03");
    let graphical = rdp.graphical().expect("graphical");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-03 initial").await;

    let mut fb = Framebuffer::default();
    resize_until(graphical, &mut frames, &mut fb, (1100, 700), "RDP-03 first").await;
    // Back to the initial size: a second Deactivate All on the rebuilt stage.
    resize_until(
        graphical,
        &mut frames,
        &mut fb,
        (DYNAMIC_WIDTH, DYNAMIC_HEIGHT),
        "RDP-03 second",
    )
    .await;
    assert!(
        rdp.is_connected(),
        "RDP-03: the session must still be up after two reactivations"
    );

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-03").await;
}

// ── RDP-04: a wrong password never reaches a desktop ────────────────

/// Drain `frames` until the stream closes (the sidecar ended the session),
/// asserting no frame ever shows the `color` desktop. Panics after 60 s.
async fn assert_session_ends_without_desktop(
    frames: &mut FrameReceiver,
    color: Solid,
    label: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut fb = Framebuffer::default();
    loop {
        match tokio::time::timeout_at(deadline, frames.recv()).await {
            Ok(Some(frame)) => {
                fb.apply(&frame);
                assert!(
                    !fb.is_solid(color),
                    "{label}: a wrong password must never reach the session desktop"
                );
            }
            Ok(None) => return,
            Err(_) => panic!("{label}: session did not end within 60s of a wrong password"),
        }
    }
}

/// xrdp (TLS, no NLA) checks the Client Info credentials only after the RDP
/// connection is up, then closes it (`require_credentials`). It sends no
/// typed reason — a bare MCS Disconnect Provider Ultimatum, the same one it
/// sends for a logoff (#3612) — so the contract here is: no desktop, the session
/// ends as an ordinary server close, and
/// the sidecar exits on its own. Before #3609 the sidecar lingered after a
/// server-side close — its stdin reader kept the runtime alive — so the frame
/// stream never closed and the desktop never learned the session was gone.
#[tokio::test]
async fn rdp_04_wrong_password_on_tls_server_ends_session() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-04");

    let mut rdp = SidecarRdp::new();
    // `connect` only spawns the sidecar; the logon runs asynchronously in it.
    rdp.connect(rdp_settings(port_rdp(), "wrong-password"))
        .await
        .expect("RDP-04: spawning the sidecar succeeds regardless of credentials");
    let pid = rejected_helper_pid("RDP-04");
    let mut frames = rdp.graphical().expect("graphical").subscribe_frames();

    assert_session_ends_without_desktop(&mut frames, Solid::Red, "RDP-04").await;
    // xrdp closes without a typed reason, so this is an ordinary server
    // close (no recorded failure) — never a transport-level connect error.
    let fatal = rdp.fatal_error();
    assert!(
        fatal.is_none(),
        "RDP-04: expected a plain server close, got {fatal:?}"
    );
    // The sidecar exits by itself — before any host disconnect.
    assert_helper_gone(pid, "RDP-04").await;
    rdp.disconnect().await.expect("disconnect should succeed");
}

/// Over NLA (CredSSP) the server rejects the credentials during the handshake,
/// before any RDP session exists, and the sidecar reports the typed
/// `AuthFailed` (#3390) so the desktop does not auto-reconnect into it. The
/// fixture's FreeRDP shadow server answers the NTLM AUTHENTICATE message with a
/// facility-Win32 NTSTATUS (`0xC00700EA`) rather than Windows'
/// `STATUS_LOGON_FAILURE`; the sidecar classifies it by the phase it answers
/// (#3612).
#[tokio::test]
async fn rdp_04b_wrong_password_on_nla_server_is_rejected_in_credssp() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    require_docker!(port_rdp_nla());
    assert_no_helpers("RDP-04b");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp_nla(), "wrong-password"))
        .await
        .expect("RDP-04b: spawning the sidecar succeeds regardless of credentials");
    let pid = rejected_helper_pid("RDP-04b");
    let mut frames = rdp.graphical().expect("graphical").subscribe_frames();

    assert_session_ends_without_desktop(&mut frames, Solid::Blue, "RDP-04b").await;
    let fatal = rdp.fatal_error();
    assert!(
        matches!(fatal, Some(SessionError::AuthFailed)),
        "RDP-04b: expected AuthFailed for a CredSSP credential rejection, got {fatal:?}"
    );
    assert_helper_gone(pid, "RDP-04b").await;
    rdp.disconnect().await.expect("disconnect should succeed");
}

// ── RDP-08: NLA (CredSSP) logon with the right password ─────────────

/// The FreeRDP shadow server authenticates over NLA against its SAM file and
/// shares a fixed 1024x768 Xvfb desktop, which the server imposes regardless
/// of the size the client asks for.
#[tokio::test]
async fn rdp_08_nla_connect_and_first_frame() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    require_docker!(port_rdp_nla());
    assert_no_helpers("RDP-08");

    let mut settings = rdp_settings(port_rdp_nla(), RDP_PASSWORD);
    settings["securityMode"] = serde_json::json!("nla");
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings).await.expect("RDP-08: connect");
    let pid = spawned_helper_pid("RDP-08");
    let mut frames = rdp.graphical().expect("graphical").subscribe_frames();
    wait_for_desktop(&mut frames, Solid::Blue, 1024, 768, "RDP-08").await;
    assert!(rdp.fatal_error().is_none(), "RDP-08: healthy session");

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-08").await;
}

// ── RDP-05: clipboard text round trip over CLIPRDR ──────────────────

#[tokio::test]
async fn rdp_05_clipboard_round_trip() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-05");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-05: connect");
    let pid = spawned_helper_pid("RDP-05");
    let graphical = rdp.graphical().expect("graphical");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-05").await;
    // Keep draining frames so the sidecar never blocks on a full channel.
    let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

    // A unique nonce: the session's echo loop turns `ping:<x>` into `pong:<x>`
    // (tests/docker/rdp-server/startwm.sh), so receiving the pong proves the
    // text went client -> server AND a new server copy came back.
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    );
    let ping = format!("ping:{nonce}");
    let pong = format!("pong:{nonce}");

    // The CLIPRDR channel initialises asynchronously; re-offer until the echo
    // arrives.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut received = None;
    while tokio::time::Instant::now() < deadline {
        graphical
            .set_clipboard(ping.clone())
            .await
            .expect("RDP-05: set_clipboard");
        let window = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < window {
            received = graphical.get_clipboard().await;
            if received.as_deref() == Some(pong.as_str()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if received.as_deref() == Some(pong.as_str()) {
            break;
        }
    }
    assert_eq!(
        received.as_deref(),
        Some(pong.as_str()),
        "RDP-05: expected the server's echoed clipboard"
    );

    rdp.disconnect().await.expect("disconnect should succeed");
    drain.abort();
    assert_helper_gone(pid, "RDP-05").await;
}

// ── RDP-06: an untrusted certificate prompts, and accepting proceeds ─

#[tokio::test]
async fn rdp_06_cert_prompt_accept() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-06");

    let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
    settings["ignoreCertErrors"] = serde_json::json!(false);
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings).await.expect("RDP-06: connect");
    let pid = spawned_helper_pid("RDP-06");
    let graphical = rdp.graphical().expect("graphical");
    let mut prompts = graphical
        .subscribe_cert_prompts()
        .expect("RDP-06: the RDP backend exposes certificate prompts");
    let mut frames = graphical.subscribe_frames();

    let prompt = tokio::time::timeout(Duration::from_secs(30), prompts.recv())
        .await
        .expect("RDP-06: the self-signed certificate should raise a prompt")
        .expect("RDP-06: prompt channel open");
    assert!(
        !prompt.fingerprint.is_empty(),
        "RDP-06: the prompt carries the server certificate fingerprint"
    );
    graphical
        .send_cert_decision(true, false)
        .await
        .expect("RDP-06: send the accept decision");
    wait_for_xrdp_session(&mut frames, "RDP-06").await;

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-06").await;
}

// ── RDP-07: dropping a live backend (tab closed) leaves no orphan ───

#[tokio::test]
async fn rdp_07_drop_without_disconnect_leaves_no_orphan() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-07");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-07: connect");
    let pid = spawned_helper_pid("RDP-07");
    let mut frames = rdp.graphical().expect("graphical").subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-07").await;

    // No graceful Disconnect message: the backend is simply dropped, as when a
    // session is torn down abruptly. Its Drop must still kill the sidecar.
    drop(frames);
    drop(rdp);
    assert_helper_gone(pid, "RDP-07").await;
}

// ── RDP-09: multi-monitor layout (#3696) ────────────────────────────

/// Two 1024x768 monitors side by side, the left one primary.
fn two_monitor_layout() -> serde_json::Value {
    serde_json::json!([
        { "x": 0, "y": 0, "width": 1024, "height": 768, "primary": true },
        { "x": 1024, "y": 0, "width": 1024, "height": 768 }
    ])
}

/// Ask for `layout` over Display Control until the desktop reflows to
/// `(w, h)`. Like [`resize_until`], re-sends while the channel is opening.
async fn set_layout_until(
    graphical: &dyn GraphicalBackend,
    frames: &mut FrameReceiver,
    fb: &mut Framebuffer,
    layout: MonitorLayout,
    label: &str,
) {
    let (w, h) = layout.desktop_size();
    let (w, h) = (u32::from(w), u32::from(h));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        graphical
            .set_monitor_layout(layout.clone())
            .await
            .unwrap_or_else(|e| panic!("{label}: layout request should be accepted: {e}"));
        let window = tokio::time::Instant::now() + Duration::from_secs(3);
        while let Ok(next) = tokio::time::timeout_at(window, frames.recv()).await {
            let frame =
                next.unwrap_or_else(|| panic!("{label}: the session ended instead of re-laying"));
            fb.apply(&frame);
            if (fb.width, fb.height) == (w, h) && fb.is_solid(Solid::Red) {
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{label}: desktop never became {w}x{h} (last {}x{})",
            fb.width,
            fb.height
        );
    }
}

/// How many monitors the xrdp session's X server has (`xrandr --listmonitors`
/// on its display, :10 and up — :1 is the FreeRDP shadow server's Xvfb), read
/// inside this checkout's fixture container. Proves the server applied the
/// layout, not just a wide single monitor of the same size.
fn xrdp_session_monitors(label: &str) -> usize {
    let script = "for d in /tmp/.X11-unix/X1?; do \
        su testuser -c \"DISPLAY=:${d##*X} xrandr --listmonitors\"; done";
    let out = std::process::Command::new("docker")
        .args([
            "exec",
            &common::fixture_container("rdp"),
            "bash",
            "-c",
            script,
        ])
        .output()
        .unwrap_or_else(|e| panic!("{label}: docker exec failed: {e}"));
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find_map(|line| line.strip_prefix("Monitors: ")?.trim().parse().ok())
        .unwrap_or_else(|| panic!("{label}: no xrandr monitor list in {text:?}"))
}

/// The client monitor layout (TS_UD_CS_MONITOR) is accepted at connect: the
/// session desktop is the combined 2048x768 bounding box, and the backend
/// reports both monitors for the per-monitor viewports. A runtime layout change
/// over Display Control then re-lays the session to three monitors.
#[tokio::test]
async fn rdp_09_multi_monitor_layout() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-09");

    let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
    settings["monitors"] = serde_json::json!("all");
    settings["monitorLayout"] = two_monitor_layout();
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings).await.expect("RDP-09: connect");
    let pid = spawned_helper_pid("RDP-09");
    let graphical = rdp.graphical().expect("graphical");
    let mut frames = graphical.subscribe_frames();
    wait_for_desktop(&mut frames, Solid::Red, 2048, 768, "RDP-09 connect").await;

    let monitors = graphical.monitor_layout();
    assert_eq!(monitors.len(), 2, "RDP-09: both monitors are reported");
    assert_eq!((monitors[1].x, monitors[1].width), (1024, 1024));
    assert_eq!(xrdp_session_monitors("RDP-09 connect"), 2);

    let three = MonitorLayout::side_by_side(3, 800, 600).expect("three monitors");
    let mut fb = Framebuffer::default();
    set_layout_until(graphical, &mut frames, &mut fb, three, "RDP-09 runtime").await;
    assert_eq!(graphical.monitor_layout().len(), 3);
    assert_eq!(xrdp_session_monitors("RDP-09 runtime"), 3);

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-09").await;
}

// ── RDP-10 / RDP-11: audio output redirection (rdpsnd, #1764) ─────

/// The marker xrdp's chansrv logs (at INFO) for every audio format a client
/// advertises over the `rdpsnd` channel.
const CHANSRV_FORMAT_MARKER: &str = "sound_process_output_format";

/// The fixture container's clock, as the `YYYY-MM-DDTHH:MM:SS.mmm` prefix xrdp
/// stamps on each log line, so log lines can be scoped to one connection.
fn fixture_now(label: &str) -> String {
    let out = common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "date",
        "-u",
        "+%Y-%m-%dT%H:%M:%S.%3N",
    ])
    .unwrap_or_else(|e| panic!("{label}: {e}"));
    out.trim().to_string()
}

/// The line xrdp's chansrv logs (at INFO) whenever a client (re)attaches to
/// it — the positive control that chansrv is alive and logging.
const CHANSRV_ATTACH_MARKER: &str = "connection accepted from AF_UNIX";

/// How many chansrv log lines containing `marker` were written since `since`
/// (a [`fixture_now`] stamp), across the fixture session's chansrv logs.
fn chansrv_lines_since(marker: &str, since: &str, label: &str) -> usize {
    let out = common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "sh",
        "-c",
        "cat /home/testuser/.local/share/xrdp/xrdp-chansrv.*.log 2>/dev/null || true",
    ])
    .unwrap_or_else(|e| panic!("{label}: {e}"));
    out.lines()
        .filter(|line| line.contains(marker))
        .filter_map(|line| line.strip_prefix('[')?.get(..since.len()))
        .filter(|stamp| *stamp >= since)
        .count()
}

/// Poll [`chansrv_lines_since`] until at least one `marker` line appears or
/// `secs` pass; returns the final count.
async fn wait_for_chansrv_line(marker: &str, since: &str, secs: u64, label: &str) -> usize {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let n = chansrv_lines_since(marker, since, label);
        if n > 0 || tokio::time::Instant::now() >= deadline {
            return n;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// End the fixture's xrdp session (every `testuser` process) and wait until it
/// is gone, so the next test logs on to a fresh session. xrdp 0.10's chansrv
/// exits when a client without rdpsnd disconnects from a session an audio
/// client used before, which would silently break CLIPRDR (RDP-05) for every
/// later test sharing that session.
async fn end_xrdp_session(label: &str) {
    let script = "su testuser -s /bin/sh -c 'kill -TERM -1' 2>/dev/null; \
        for _ in $(seq 1 60); do \
            n=0; for p in /proc/[0-9]*; do \
                [ \"$(stat -c %u \"$p\" 2>/dev/null)\" = 1000 ] && n=$((n + 1)); \
            done; \
            [ \"$n\" = 0 ] && exit 0; sleep 0.25; \
        done; exit 1";
    common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "sh",
        "-c",
        script,
    ])
    .unwrap_or_else(|e| panic!("{label}: the xrdp session did not end: {e}"));
}

/// Opting in to audio output redirection registers the real rdpsnd handler,
/// which advertises its PCM formats, and lifts the NO_AUDIO_PLAYBACK flag. The
/// session must still log on and paint where the host has no usable audio
/// output device — the CI runner and the fixture are both headless — so a
/// missing device degrades to silence instead of failing the connection.
#[tokio::test]
async fn rdp_10_audio_redirection_on_headless_host_still_connects() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-10");
    let since = fixture_now("RDP-10");

    let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
    settings["audioRedirection"] = serde_json::json!(true);
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings)
        .await
        .expect("RDP-10: connect with audio redirection on");
    let pid = spawned_helper_pid("RDP-10");
    let graphical = rdp.graphical().expect("RDP-10: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-10").await;

    // The rdpsnd negotiation runs alongside the first frames; wait for chansrv
    // to log the client's formats, proving audio was really negotiated.
    let formats = wait_for_chansrv_line(CHANSRV_FORMAT_MARKER, &since, 15, "RDP-10").await;
    assert!(
        formats > 0,
        "RDP-10: the server never saw the client's audio formats"
    );
    assert!(
        rdp.fatal_error().is_none(),
        "RDP-10: an audio-enabled session reports no fatal error"
    );

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-10").await;
    end_xrdp_session("RDP-10").await;
}

/// Audio redirection is off by default: a connection that does not opt in
/// registers no rdpsnd channel, so the server is offered no audio formats.
#[tokio::test]
async fn rdp_11_audio_redirection_off_by_default() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-11");
    let since = fixture_now("RDP-11");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-11: connect with default settings");
    let pid = spawned_helper_pid("RDP-11");
    let graphical = rdp.graphical().expect("RDP-11: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-11").await;
    // Positive control: chansrv is alive and logging for this connection, so
    // "no formats" below is a real observation, not a dead log.
    assert!(
        wait_for_chansrv_line(CHANSRV_ATTACH_MARKER, &since, 15, "RDP-11").await > 0,
        "RDP-11: chansrv never logged this connection"
    );
    // Give a (wrongly) negotiated audio channel time to be logged.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        chansrv_lines_since(CHANSRV_FORMAT_MARKER, &since, "RDP-11"),
        0,
        "RDP-11: no audio formats may be advertised unless audio is opted in"
    );

    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, "RDP-11").await;
}

// ── RDP-12: pointer and keyboard input reach the server (#4004) ─────

/// Run `cmd` as the fixture user on the xrdp session's X display (:10 and up —
/// :1 is the FreeRDP shadow server's Xvfb) inside this checkout's container.
fn xrdp_session_exec(cmd: &str, label: &str) -> String {
    let script = format!(
        "for d in /tmp/.X11-unix/X1?; do su testuser -c \"DISPLAY=:${{d##*X}} {cmd}\"; done"
    );
    common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "bash",
        "-c",
        &script,
    ])
    .unwrap_or_else(|e| panic!("{label}: {e}"))
}

/// Where the session's X server has the pointer (`xdotool getmouselocation`).
fn xrdp_pointer(label: &str) -> Option<(u32, u32)> {
    let out = xrdp_session_exec("xdotool getmouselocation", label);
    let field = |name: &str| {
        out.split_whitespace()
            .find_map(|part| part.strip_prefix(name)?.parse::<u32>().ok())
    };
    Some((field("x:")?, field("y:")?))
}

/// How many `event` lines (`KeyPress`, `ButtonPress`, …) the session's input
/// probe has logged (`xev -root`, see `tests/docker/rdp-server/startwm.sh`).
fn xrdp_input_events(event: &str, detail: &str, label: &str) -> usize {
    let out = common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "sh",
        "-c",
        "cat /home/testuser/termihub-input.log 2>/dev/null || true",
    ])
    .unwrap_or_else(|e| panic!("{label}: {e}"));
    // xev prints the event name on one line and its details (the keysym) on the
    // following ones, so pair each event line with the next few lines.
    let lines: Vec<&str> = out.lines().collect();
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with(event))
        .filter(|(i, _)| {
            lines[*i..(*i + 4).min(lines.len())]
                .iter()
                .any(|l| l.contains(detail))
        })
        .count()
}

/// Poll `probe` until it returns true or 20 s pass, re-sending `input` every
/// couple of seconds — the session may still be settling right after logon.
async fn input_until(
    graphical: &dyn GraphicalBackend,
    input: &[InputEvent],
    mut probe: impl FnMut() -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        for event in input {
            graphical
                .send_input(event.clone())
                .await
                .expect("input should be accepted");
        }
        let window = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < window {
            if probe() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    false
}

/// Pointer moves, a left click and a key press sent through the sidecar arrive
/// at the xrdp session's X server: the pointer lands where it was sent, and the
/// input probe logs the button and the `a` key. This is the server-side ground
/// truth the UI suite (`tests/system/tests/test_rdp.py`) asserts the same way.
#[tokio::test]
async fn rdp_12_pointer_and_keyboard_input_reach_the_server() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-12");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-12: connect");
    let pid = spawned_helper_pid("RDP-12");
    let graphical = rdp.graphical().expect("RDP-12: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-12").await;
    let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

    let target = (123, 77);
    let moved = input_until(
        graphical,
        &[InputEvent::Pointer {
            x: target.0,
            y: target.1,
            buttons: 0,
        }],
        || xrdp_pointer("RDP-12 pointer") == Some(target),
    )
    .await;
    assert!(
        moved,
        "RDP-12: the session pointer never reached {target:?} (last {:?})",
        xrdp_pointer("RDP-12 pointer")
    );

    let buttons_before = xrdp_input_events("ButtonPress", "button 1,", "RDP-12 click");
    let clicked = input_until(
        graphical,
        &[
            InputEvent::Pointer {
                x: target.0,
                y: target.1,
                buttons: 1,
            },
            InputEvent::Pointer {
                x: target.0,
                y: target.1,
                buttons: 0,
            },
        ],
        || xrdp_input_events("ButtonPress", "button 1,", "RDP-12 click") > buttons_before,
    )
    .await;
    assert!(clicked, "RDP-12: the left click never reached the session");

    let keys_before = xrdp_input_events("KeyPress", "keysym 0x61, a)", "RDP-12 key");
    let typed = input_until(
        graphical,
        &[
            InputEvent::Key {
                code: "KeyA".into(),
                pressed: true,
            },
            InputEvent::Key {
                code: "KeyA".into(),
                pressed: false,
            },
        ],
        || xrdp_input_events("KeyPress", "keysym 0x61, a)", "RDP-12 key") > keys_before,
    )
    .await;
    assert!(typed, "RDP-12: the `a` key press never reached the session");

    rdp.disconnect().await.expect("disconnect should succeed");
    drain.abort();
    assert_helper_gone(pid, "RDP-12").await;
}

// ── RDP-13: clipboard images (CLIPRDR CF_DIB) both ways (PROD-021) ──

/// A 4x2 test image, one distinct colour per pixel, as RGBA rows top-down.
const DIB_PIXELS: [[u8; 3]; 8] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
];
const DIB_WIDTH: u32 = 4;
const DIB_HEIGHT: u32 = 2;

fn dib_rgba() -> Vec<u8> {
    DIB_PIXELS
        .iter()
        .flat_map(|[r, g, b]| [*r, *g, *b, 255])
        .collect()
}

/// The test image as a 24-bit bottom-up BMP file (what X clients exchange as
/// `image/bmp`, and what xrdp's chansrv maps to and from CF_DIB).
fn dib_bmp() -> Vec<u8> {
    let row = (DIB_WIDTH * 3).div_ceil(4) * 4;
    let data_len = row * DIB_HEIGHT;
    let mut bmp = Vec::new();
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(54 + data_len).to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&54u32.to_le_bytes());
    bmp.extend_from_slice(&40u32.to_le_bytes());
    bmp.extend_from_slice(&(DIB_WIDTH as i32).to_le_bytes());
    bmp.extend_from_slice(&(DIB_HEIGHT as i32).to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes());
    bmp.extend_from_slice(&24u16.to_le_bytes());
    bmp.extend_from_slice(&[0; 24]);
    for y in (0..DIB_HEIGHT).rev() {
        let start = bmp.len();
        for x in 0..DIB_WIDTH {
            let [r, g, b] = DIB_PIXELS[(y * DIB_WIDTH + x) as usize];
            bmp.extend_from_slice(&[b, g, r]);
        }
        bmp.resize(start + row as usize, 0);
    }
    bmp
}

/// Decode a 24/32-bit uncompressed BMP (or a headerless DIB) to top-down RGB
/// pixels, returning `(width, height, pixels)`.
fn decode_bmp(bytes: &[u8]) -> Option<(u32, u32, Vec<[u8; 3]>)> {
    let le32 = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let le16 = |at: usize| Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
    let (header, data_at) = if bytes.starts_with(b"BM") {
        (14, le32(10)? as usize)
    } else {
        (0, le32(0)? as usize)
    };
    let width = le32(header + 4)? as i32;
    let height = le32(header + 8)? as i32;
    let bpp = u32::from(le16(header + 14)?) / 8;
    if width <= 0 || height == 0 || !(3..=4).contains(&bpp) {
        return None;
    }
    let (w, h) = (width as u32, height.unsigned_abs());
    let row = (w * bpp).div_ceil(4) * 4;
    let mut pixels = Vec::new();
    for y in 0..h {
        let src_y = if height > 0 { h - 1 - y } else { y };
        for x in 0..w {
            let at = data_at + (src_y * row + x * bpp) as usize;
            let px = bytes.get(at..at + 3)?;
            pixels.push([px[2], px[1], px[0]]);
        }
    }
    Some((w, h, pixels))
}

/// Run `script` (bash) as root in this checkout's rdp fixture container.
fn fixture_bash(script: &str, label: &str) -> String {
    common::docker_cli(&[
        "exec",
        &common::fixture_container("rdp"),
        "bash",
        "-c",
        script,
    ])
    .unwrap_or_else(|e| panic!("{label}: {e}"))
}

/// A local image copied in the session arrives at the server as an X
/// `image/bmp` selection with the same pixels (client -> server), and an image
/// an X client copies on the server arrives at the client as the same RGBA
/// (server -> client) — both through xrdp's chansrv CF_DIB mapping.
#[tokio::test]
async fn rdp_13_clipboard_image_round_trips_both_ways() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-13");

    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-13: connect");
    let pid = spawned_helper_pid("RDP-13");
    let graphical = rdp.graphical().expect("RDP-13: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, "RDP-13").await;
    let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

    // Client -> server: offer the image, then paste it on the server side.
    let image = ClipboardImage::new(DIB_WIDTH, DIB_HEIGHT, dib_rgba()).expect("valid image");
    let read_server = "xclip -selection clipboard -t image/bmp -o 2>/dev/null | od -An -v -tx1";
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut pasted = None;
    while tokio::time::Instant::now() < deadline && pasted.is_none() {
        graphical
            .set_clipboard_image(image.clone())
            .await
            .expect("RDP-13: set_clipboard_image");
        tokio::time::sleep(Duration::from_secs(1)).await;
        let hex = xrdp_session_exec(read_server, "RDP-13 paste");
        let bytes: Vec<u8> = hex
            .split_whitespace()
            .filter_map(|b| u8::from_str_radix(b, 16).ok())
            .collect();
        pasted = decode_bmp(&bytes);
    }
    let (w, h, pixels) = pasted.expect("RDP-13: the server never received the image as image/bmp");
    assert_eq!((w, h), (DIB_WIDTH, DIB_HEIGHT), "RDP-13: pasted image size");
    assert_eq!(pixels, DIB_PIXELS.to_vec(), "RDP-13: pasted image pixels");

    // Server -> client: an X client copies an image/bmp selection.
    let encoded: String = dib_bmp().iter().map(|b| format!("\\x{b:02x}")).collect();
    fixture_bash(
        &format!("printf '{encoded}' > /tmp/termihub-dib.bmp && chmod 644 /tmp/termihub-dib.bmp"),
        "RDP-13 stage",
    );
    let copy = "xclip -selection clipboard -t image/bmp -i /tmp/termihub-dib.bmp";
    xrdp_session_exec(&format!("{copy} >/dev/null 2>&1 &"), "RDP-13 copy");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut received = None;
    while tokio::time::Instant::now() < deadline {
        received = graphical
            .get_clipboard_image()
            .await
            .filter(|img| img.rgba == dib_rgba());
        if received.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let received =
        received.unwrap_or_else(|| panic!("RDP-13: the client never received the server's image"));
    assert_eq!((received.width, received.height), (DIB_WIDTH, DIB_HEIGHT));

    rdp.disconnect().await.expect("disconnect should succeed");
    drain.abort();
    assert_helper_gone(pid, "RDP-13").await;
}

// ── RDP-14: remote-copied files, listed then fetched on paste (#1765/#1793) ─

/// Stage three files on the server — two sharing the name `report.txt` in
/// different folders, one with a non-ASCII name — tagged with `nonce`, and have
/// an X client copy them as a `text/uri-list` selection, which xrdp's chansrv
/// offers to the client as a CLIPRDR file list.
fn copy_files_on_server(nonce: &str, label: &str) {
    fixture_bash(
        &format!(
            "rm -rf /tmp/tf && mkdir -p /tmp/tf/a /tmp/tf/b /tmp/tf/c \
             && printf 'alpha {nonce}' > /tmp/tf/a/report.txt \
             && printf 'bravo {nonce}' > /tmp/tf/b/report.txt \
             && printf 'gruss {nonce}' > \"/tmp/tf/c/$(printf 'gr\\303\\274\\303\\237e.txt')\" \
             && printf '%s\\r\\n' file:///tmp/tf/a/report.txt file:///tmp/tf/b/report.txt \
                file:///tmp/tf/c/gr%C3%BC%C3%9Fe.txt > /tmp/tf/uris \
             && chmod -R a+rX /tmp/tf"
        ),
        label,
    );
    let copy = "xclip -selection clipboard -t text/uri-list -i /tmp/tf/uris";
    xrdp_session_exec(&format!("{copy} >/dev/null 2>&1 &"), label);
}

/// Poll the session's surfaced remote file list until it has `want` entries
/// (re-copying on the server every few seconds while CLIPRDR initialises), or
/// `secs` pass. Returns the last list seen.
async fn wait_for_remote_files(
    graphical: &dyn GraphicalBackend,
    nonce: &str,
    want: usize,
    secs: u64,
    label: &str,
) -> Vec<termihub_core::connection::RemoteClipboardFile> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut copied_at: Option<tokio::time::Instant> = None;
    let mut files = Vec::new();
    while tokio::time::Instant::now() < deadline {
        if copied_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
            copy_files_on_server(nonce, label);
            copied_at = Some(tokio::time::Instant::now());
        }
        files = graphical.remote_clipboard_files().await;
        if files.len() >= want {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    files
}

/// Opted in ("Receive Clipboard Files" with a shared folder), files an X client
/// copies on the server are surfaced as a sanitized list — same-named files and
/// a non-ASCII name intact — and each one's bytes are fetched over CLIPRDR only
/// when pasted (delayed rendering, the path every desktop OS uses). Off by
/// default: the same copy surfaces nothing.
#[tokio::test]
async fn rdp_14_remote_clipboard_files_are_listed_and_fetched_on_paste() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-14");
    let nonce = format!("{}", std::process::id());

    // Opted in first, on a fresh xrdp session: chansrv keeps one set of CLIPRDR
    // capability flags per session and ANDs every client's into it, so after
    // any client without file streams (every other test here) it stops
    // offering CB_STREAM_FILECLIP_ENABLED to later clients of that session.
    end_xrdp_session("RDP-14").await;
    // The last pass opts in again on the session the default pass has now
    // poisoned: the server declines file streams, so no list may be offered
    // (its bytes could never be fetched) and the session must survive.
    for (receive, declined) in [(true, false), (false, false), (true, true)] {
        let label = match (receive, declined) {
            (true, false) => "RDP-14 opted in",
            (false, _) => "RDP-14 default",
            (true, true) => "RDP-14 streams declined",
        };
        let shared = tempfile::tempdir().expect("temp shared folder");
        let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
        settings["driveRedirection"] = serde_json::json!(true);
        settings["sharedFolderPath"] = serde_json::json!(shared.path());
        settings["clipboardFileTransfer"] = serde_json::json!(receive);
        let mut rdp = SidecarRdp::new();
        rdp.connect(settings).await.expect("RDP-14: connect");
        let pid = spawned_helper_pid(label);
        let graphical = rdp.graphical().expect("RDP-14: graphical backend present");
        let mut frames = graphical.subscribe_frames();
        wait_for_xrdp_session(&mut frames, label).await;
        let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

        if !receive || declined {
            let files = wait_for_remote_files(graphical, &nonce, 1, 8, label).await;
            assert!(
                files.is_empty(),
                "{label}: no unfetchable file list may be surfaced: {files:?}"
            );
            assert!(rdp.fatal_error().is_none(), "{label}: the session survives");
            assert_eq!(
                own_helper_pids(),
                pid.into_iter().collect::<Vec<_>>(),
                "{label}: the sidecar is still running"
            );
        } else {
            let files = wait_for_remote_files(graphical, &nonce, 3, 45, label).await;
            let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
            names.sort_unstable();
            assert_eq!(
                names,
                ["grüße.txt", "report.txt", "report.txt"],
                "{label}: the surfaced list"
            );
            let mut contents = Vec::new();
            for file in &files {
                assert!(!file.is_dir, "{label}: {} is a file", file.name);
                let path = tokio::time::timeout(
                    Duration::from_secs(30),
                    graphical.fetch_remote_clipboard_file(file.index),
                )
                .await
                .unwrap_or_else(|_| panic!("{label}: fetching {} timed out", file.name))
                .unwrap_or_else(|e| panic!("{label}: fetch {}: {e}", file.name));
                contents.push(std::fs::read_to_string(&path).expect("fetched file readable"));
            }
            contents.sort();
            assert_eq!(
                contents,
                [
                    format!("alpha {nonce}"),
                    format!("bravo {nonce}"),
                    format!("gruss {nonce}")
                ],
                "{label}: each pasted file's bytes"
            );
        }

        rdp.disconnect().await.expect("disconnect should succeed");
        drain.abort();
        assert_helper_gone(pid, label).await;
    }
    // Hand later tests a fresh session: this one's chansrv has had its file
    // capabilities cut and its clipboard owned by a file list.
    end_xrdp_session("RDP-14").await;
}

// ── RDP-15: drive redirection through xrdp's FUSE mount (RDPDR, #1757/#4086) ─

/// Where xrdp's chansrv mounts the session's redirected drives and the files a
/// client offers on its clipboard (`FuseMountName` in sesman.ini, relative to
/// the user's home). Private to `testuser` (no `allow_other`), so every probe
/// below runs as that user.
const THINCLIENT_DRIVES: &str = "/home/testuser/thinclient_drives";

/// The marker chansrv logs (at INFO) when the client announces a drive.
const CHANSRV_DRIVE_MARKER: &str = "Detected remote drive";

/// Run `script` (sh) as the fixture user in this checkout's rdp container and
/// return its stdout, or the failure (non-zero exit) as an error.
fn fixture_user_sh(script: &str) -> Result<String, String> {
    common::docker_cli(&[
        "exec",
        "-u",
        RDP_USER,
        &common::fixture_container("rdp"),
        "sh",
        "-c",
        script,
    ])
}

/// Poll until `script` (run as the fixture user) succeeds or `secs` pass.
async fn wait_for_user_sh(script: &str, secs: u64) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let result = fixture_user_sh(script);
        if result.is_ok() || tokio::time::Instant::now() >= deadline {
            return result;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Opted in, the shared folder is announced as a drive that chansrv mounts
/// under `~/thinclient_drives/<name>`; a server-side list, read, write, rename,
/// mkdir and delete through that mount land in (and only in) the local shared
/// folder. A symlink in the folder pointing outside it is refused, so the
/// server never reads a file beyond the share. Off by default: the same session
/// setup announces no drive.
#[tokio::test]
async fn rdp_15_drive_redirection_serves_only_the_shared_folder() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-15");
    let label = "RDP-15";
    let nonce = format!("{}", std::process::id());
    let drive = format!("th{nonce}");

    // The share sits next to a secret it must never expose; the share holds a
    // symlink to that secret (and one to its parent directory).
    let outer = tempfile::tempdir().expect("temp dir");
    let share = outer.path().join("share");
    std::fs::create_dir(&share).expect("share dir");
    std::fs::write(share.join("seed.txt"), format!("seed {nonce}")).expect("seed file");
    std::fs::write(outer.path().join("secret.txt"), format!("secret {nonce}")).expect("secret");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outer.path().join("secret.txt"), share.join("leak.txt"))
            .expect("file symlink");
        std::os::unix::fs::symlink(outer.path(), share.join("up")).expect("dir symlink");
    }

    // A fresh session: chansrv announces drives to the FUSE mount per session.
    end_xrdp_session(label).await;
    let since = fixture_now(label);
    let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
    settings["driveRedirection"] = serde_json::json!(true);
    settings["sharedFolderPath"] = serde_json::json!(share);
    settings["driveName"] = serde_json::json!(drive);
    let mut rdp = SidecarRdp::new();
    rdp.connect(settings).await.expect("RDP-15: connect");
    let pid = spawned_helper_pid(label);
    let graphical = rdp.graphical().expect("RDP-15: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, label).await;
    let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

    // The announced drive is mounted as one directory, named after the drive.
    // xrdp reads only the announce's 8-byte, null-terminated PreferredDosName,
    // so the name is the drive name cut to its first 7 characters (all valid
    // ASCII here). Upstream IronRDP 0.7.0 sent the literal "ignored" there; the
    // vendored ironrdp-rdpdr fork sends the real name (#4125).
    let dos_name: String = drive.chars().take(7).collect();
    let mounted = wait_for_user_sh(
        &format!("ls '{THINCLIENT_DRIVES}' | grep -x '{dos_name}'"),
        30,
    )
    .await
    .unwrap_or_else(|e| {
        panic!(
            "{label}: the drive never appeared under {THINCLIENT_DRIVES} \
             (chansrv drive lines: {}): {e}",
            chansrv_lines_since(CHANSRV_DRIVE_MARKER, &since, label)
        )
    });
    assert_eq!(
        mounted.trim(),
        dos_name,
        "{label}: the drive is mounted under its configured name, not \"ignored\""
    );
    let mount = format!("{THINCLIENT_DRIVES}/{dos_name}");

    // List + read.
    let listing = fixture_user_sh(&format!("ls -A '{mount}'")).expect("list the drive");
    let mut names: Vec<&str> = listing.lines().collect();
    names.sort_unstable();
    assert_eq!(names, ["leak.txt", "seed.txt", "up"], "{label}: listing");
    assert_eq!(
        fixture_user_sh(&format!("cat '{mount}/seed.txt'")).expect("read seed"),
        format!("seed {nonce}"),
        "{label}: read"
    );

    // Write a new file, then rename it, then create a directory.
    fixture_user_sh(&format!("printf 'written {nonce}' > '{mount}/new.txt'")).expect("write");
    assert_eq!(
        std::fs::read_to_string(share.join("new.txt")).expect("written file on the host"),
        format!("written {nonce}"),
        "{label}: write lands in the shared folder"
    );
    fixture_user_sh(&format!("mv '{mount}/new.txt' '{mount}/renamed.txt'")).expect("rename");
    assert!(
        !share.join("new.txt").exists(),
        "{label}: rename removes the old name"
    );
    assert_eq!(
        std::fs::read_to_string(share.join("renamed.txt")).expect("renamed file on the host"),
        format!("written {nonce}"),
        "{label}: rename keeps the content"
    );
    fixture_user_sh(&format!("mkdir '{mount}/dir'")).expect("mkdir");
    assert!(
        share.join("dir").is_dir(),
        "{label}: mkdir lands in the shared folder"
    );

    // Delete.
    fixture_user_sh(&format!("rm '{mount}/seed.txt' && rmdir '{mount}/dir'")).expect("delete");
    assert!(
        !share.join("seed.txt").exists(),
        "{label}: delete removes the file"
    );
    assert!(
        !share.join("dir").exists(),
        "{label}: rmdir removes the directory"
    );

    // Sandbox: neither symlink may be followed out of the share.
    for escape in ["leak.txt", "up/secret.txt"] {
        let read = fixture_user_sh(&format!("cat '{mount}/{escape}' 2>/dev/null"));
        assert!(
            !read.as_deref().unwrap_or("").contains("secret"),
            "{label}: {escape} must not expose a file outside the share: {read:?}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(outer.path().join("secret.txt")).expect("secret intact"),
        format!("secret {nonce}"),
        "{label}: the file outside the share is untouched"
    );
    assert!(rdp.fatal_error().is_none(), "{label}: the session survives");

    rdp.disconnect().await.expect("disconnect should succeed");
    drain.abort();
    assert_helper_gone(pid, label).await;

    // Off by default: a fresh session with default settings announces no drive.
    let label = "RDP-15 default";
    end_xrdp_session(label).await;
    let since = fixture_now(label);
    let mut rdp = SidecarRdp::new();
    rdp.connect(rdp_settings(port_rdp(), RDP_PASSWORD))
        .await
        .expect("RDP-15: connect with default settings");
    let pid = spawned_helper_pid(label);
    let graphical = rdp.graphical().expect("RDP-15: graphical backend present");
    let mut frames = graphical.subscribe_frames();
    wait_for_xrdp_session(&mut frames, label).await;
    assert!(
        wait_for_chansrv_line(CHANSRV_ATTACH_MARKER, &since, 15, label).await > 0,
        "{label}: chansrv never logged this connection"
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        chansrv_lines_since(CHANSRV_DRIVE_MARKER, &since, label),
        0,
        "{label}: no drive may be announced unless drive redirection is opted in"
    );
    let drives = fixture_user_sh(&format!("ls '{THINCLIENT_DRIVES}' 2>/dev/null || true"))
        .expect("list thinclient_drives");
    assert!(
        drives.trim().is_empty(),
        "{label}: no drive is mounted by default: {drives:?}"
    );
    rdp.disconnect().await.expect("disconnect should succeed");
    assert_helper_gone(pid, label).await;
    end_xrdp_session(label).await;
}

// ── RDP-16: shared-folder files served to the server over CLIPRDR (#1778/#4086) ─

/// The directory under [`THINCLIENT_DRIVES`] where chansrv exposes the files a
/// client offers on its clipboard; reading one fetches its bytes from the
/// client over CLIPRDR file streams.
const CLIPBOARD_FILES: &str = "/home/testuser/thinclient_drives/.clipboard";

/// What chansrv logs (at WARN) for the offered `sub\nested.txt` entry: xrdp
/// 0.10 does not paste client directories, so tree entries are skipped.
const CHANSRV_SKIPPED_NESTED: &str = "skipping directory not supported [sub\\nested.txt]";

/// Paste on the server: ask the session's CLIPBOARD for `text/uri-list` (what a
/// file manager does), which makes chansrv fetch the client's file list and
/// expose it under [`CLIPBOARD_FILES`]. Returns the URIs, one per line.
fn paste_uri_list_on_server(label: &str) -> String {
    xrdp_session_exec(
        "timeout 5 xclip -o -selection clipboard -t text/uri-list 2>/dev/null || true",
        label,
    )
}

/// Opted in ("Receive Clipboard Files" with a shared folder, not view-only),
/// the folder's contents are offered on the client's clipboard at connect: a
/// paste on the server lists them under chansrv's `.clipboard` directory and
/// reading each one streams its bytes from the sidecar over CLIPRDR file
/// contents requests (a multi-range file arrives intact); a subfolder is
/// offered as a tree, which xrdp skips. View-only and default sessions offer
/// nothing.
#[tokio::test]
async fn rdp_16_shared_folder_files_are_served_to_the_server() {
    let _serial = SERIAL.lock().await;
    require_rdp!();
    assert_no_helpers("RDP-16");
    let nonce = format!("{}", std::process::id());
    let big: String = (0..12_000)
        .map(|i| format!("line {i:05} {nonce}\n"))
        .collect();

    for (transfer, view_only) in [(true, false), (true, true), (false, false)] {
        let label = match (transfer, view_only) {
            (true, false) => "RDP-16 opted in",
            (true, true) => "RDP-16 view-only",
            (false, _) => "RDP-16 default",
        };
        let share = tempfile::tempdir().expect("temp shared folder");
        std::fs::write(share.path().join("alpha.txt"), format!("alpha {nonce}")).expect("file");
        std::fs::write(share.path().join("big.txt"), &big).expect("big file");
        std::fs::create_dir(share.path().join("sub")).expect("sub dir");
        std::fs::write(
            share.path().join("sub").join("nested.txt"),
            format!("nested {nonce}"),
        )
        .expect("nested file");

        // chansrv ANDs every client's CLIPRDR capabilities into the session's,
        // so each pass needs a session no file-stream-less client has touched.
        end_xrdp_session(label).await;
        let since = fixture_now(label);
        let mut settings = rdp_settings(port_rdp(), RDP_PASSWORD);
        settings["driveRedirection"] = serde_json::json!(true);
        settings["sharedFolderPath"] = serde_json::json!(share.path());
        settings["clipboardFileTransfer"] = serde_json::json!(transfer);
        settings["viewOnly"] = serde_json::json!(view_only);
        let mut rdp = SidecarRdp::new();
        rdp.connect(settings).await.expect("RDP-16: connect");
        let pid = spawned_helper_pid(label);
        let graphical = rdp.graphical().expect("RDP-16: graphical backend present");
        let mut frames = graphical.subscribe_frames();
        wait_for_xrdp_session(&mut frames, label).await;
        let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });

        if transfer && !view_only {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
            let mut uris = String::new();
            while tokio::time::Instant::now() < deadline && !uris.contains("alpha.txt") {
                uris = paste_uri_list_on_server(label);
                if !uris.contains("alpha.txt") {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            assert!(
                uris.contains(&format!("file://{CLIPBOARD_FILES}/alpha.txt")),
                "{label}: the server's paste lists the shared folder: {uris:?}"
            );
            // chansrv fills `.clipboard` from the file list it fetched for that
            // paste; wait until the view lists both files before reading them.
            let listing = format!("ls -A '{CLIPBOARD_FILES}'");
            let lists_both = |listed: &Result<String, String>| {
                listed.as_deref().is_ok_and(|l| {
                    ["alpha.txt", "big.txt"]
                        .iter()
                        .all(|f| l.lines().any(|n| n == *f))
                })
            };
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            let mut listed = fixture_user_sh(&listing);
            while !lists_both(&listed) && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(250)).await;
                listed = fixture_user_sh(&listing);
            }
            assert!(
                lists_both(&listed),
                "{label}: {CLIPBOARD_FILES} never listed alpha.txt + big.txt within 15 s: \
                 {listed:?}\nuris: {uris:?}"
            );
            let read = |path: &str| {
                fixture_user_sh(&format!("cat '{CLIPBOARD_FILES}/{path}'")).unwrap_or_else(|e| {
                    let tree = fixture_user_sh(&format!("ls -laR '{CLIPBOARD_FILES}'"));
                    panic!("{label}: read {path}: {e}\nuris: {uris:?}\ntree: {tree:?}")
                })
            };
            assert_eq!(
                read("alpha.txt"),
                format!("alpha {nonce}"),
                "{label}: alpha"
            );
            assert!(read("big.txt") == big, "{label}: big.txt arrives intact");
            // The subfolder is offered as a tree (a directory entry plus a file
            // carrying its `\`-separated relative path, #1780); xrdp 0.10's
            // chansrv cannot paste directories and logs that it skips both.
            assert!(
                chansrv_lines_since(CHANSRV_SKIPPED_NESTED, &since, label) > 0,
                "{label}: the nested file was offered with its relative path"
            );
        } else {
            assert!(
                wait_for_chansrv_line(CHANSRV_ATTACH_MARKER, &since, 15, label).await > 0,
                "{label}: chansrv never logged this connection"
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
            let uris = paste_uri_list_on_server(label);
            assert!(
                uris.trim().is_empty(),
                "{label}: no local file may be offered: {uris:?}"
            );
            let listed = fixture_user_sh(&format!("ls -A '{CLIPBOARD_FILES}' 2>/dev/null || true"))
                .expect("list .clipboard");
            assert!(
                listed.trim().is_empty(),
                "{label}: nothing is exposed under .clipboard: {listed:?}"
            );
        }
        assert!(rdp.fatal_error().is_none(), "{label}: the session survives");

        rdp.disconnect().await.expect("disconnect should succeed");
        drain.abort();
        assert_helper_gone(pid, label).await;
    }
    end_xrdp_session("RDP-16").await;
}
