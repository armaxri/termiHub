#![cfg(feature = "rdp-sidecar")]
//! RDP Integration Tests (RDP-01 through RDP-07, #3609 / TIN-005).
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
use termihub_core::connection::{ConnectionType, FrameReceiver, FrameUpdate, GraphicalBackend};
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
/// typed reason, so the contract here is: no desktop, the session ends, and
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
/// before any RDP session exists. Windows answers with a logon NTSTATUS that
/// the sidecar reports as the typed `AuthFailed` (#3390); the fixture's FreeRDP
/// shadow server instead returns a facility-Win32 NTSTATUS, which is still
/// classified as a connect failure — tracked in #3612. Until then this asserts
/// the stable part: no desktop, a failure raised by the server's CredSSP error
/// status (the right reason — not a transport or TLS error), and a clean exit.
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
    let rejected_in_credssp = match &fatal {
        Some(SessionError::AuthFailed) => true,
        Some(SessionError::ConnectionFailed(message)) => {
            message.contains("CredSSP server returned an error status")
        }
        _ => false,
    };
    assert!(
        rejected_in_credssp,
        "RDP-04b: expected a CredSSP credential rejection, got {fatal:?}"
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
