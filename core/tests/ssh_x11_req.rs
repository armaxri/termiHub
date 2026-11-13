#![cfg(all(feature = "ssh", unix))]
//! X11 forwarding over `x11-req` with a **real X client** against the
//! `ssh-x11` Docker fixture (#5584, follow-up to #5570).
//!
//! `ssh_x11_req_native.rs` plays the X client itself. Here the fixture's
//! `xdpyinfo` runs inside the forwarded session and talks, end to end, through
//! sshd's display, the `x11` channel and termiHub's cookie swap, to a private
//! `Xvfb` on this host:
//!
//! ```text
//! xdpyinfo (container) -> sshd :10 -> x11 channel -> X11ReqForwarder
//!   -> recording tap (127.0.0.1) -> Xvfb unix socket (this host)
//! ```
//!
//! The `Xvfb` is started by the test with `-auth` on a scratch file holding
//! only the **real** cookie, so `xdpyinfo` (which only knows sshd's fake one)
//! succeeds only if the forwarder swapped it. The tap records the setup bytes
//! that arrive locally. The user's own X server and `~/.Xauthority` are never
//! touched: the test picks a free display (`-displayfd`) and its own auth file.
//!
//! This is its own test binary because the X server provisioner is set once
//! per process, and `ssh_x11.rs` registers a failing one.
//!
//! Needs `Xvfb` on the host. Without it the test skips, unless
//! `TERMIHUB_REQUIRE_DOCKER=1` (the integration-fixtures lane), where a
//! missing `Xvfb` is a hard failure. Run locally with:
//!
//! ```sh
//! (cd tests/docker && docker compose up -d ssh-x11)
//! cargo test -p termihub-core --all-features --test ssh_x11_req
//! ```

mod common;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::{port_ssh_x11, require_docker, ssh_password_config};
use termihub_core::backends::ssh::connector::{RusshSshConnector, SshConnector};
use termihub_core::backends::ssh::x11::{
    set_x_server_provisioner, LocalXConnection, LocalXServerInfo, ResolvedXServer, XServerLease,
    XServerProvisioner,
};
use termihub_core::backends::ssh::x11_req::{X11ReqForwarder, MIT_MAGIC_COOKIE_1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The local `Xvfb`'s (real) cookie. Only this one is in its auth file.
const REAL_HEX: &str = "00112233445566778899aabbccddeeff";

/// Hands the connect path the recording tap in front of the local `Xvfb`.
struct TapProvisioner(ResolvedXServer);

#[async_trait::async_trait]
impl XServerProvisioner for TapProvisioner {
    async fn ensure(
        &self,
        _cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<XServerLease, String> {
        Ok(XServerLease {
            resolved: Some(self.0.clone()),
            guard: None,
        })
    }
}

/// A private `Xvfb`, killed (and its scratch dir removed) on drop.
struct Xvfb {
    child: Child,
    socket: PathBuf,
    scratch: PathBuf,
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

/// Whether `Xvfb` is installed here.
fn host_has_xvfb() -> bool {
    Command::new("sh")
        .args(["-c", "command -v Xvfb"])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// One `.Xauthority` entry (big-endian length-prefixed fields): family Wild,
/// any address/display, `MIT-MAGIC-COOKIE-1` + `cookie`. The X server loads
/// every entry of its `-auth` file regardless of address.
fn xauth_entry(cookie: &[u8]) -> Vec<u8> {
    let mut out = 0xffffu16.to_be_bytes().to_vec();
    for field in [&b""[..], b"", MIT_MAGIC_COOKIE_1.as_bytes(), cookie] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// Start `Xvfb` on a free display with only the real cookie authorised.
fn start_xvfb() -> Xvfb {
    let scratch = std::env::temp_dir().join(format!("termihub-x11req-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("scratch dir");
    let auth = scratch.join("Xauthority");
    std::fs::write(&auth, xauth_entry(&hex::decode(REAL_HEX).unwrap())).expect("auth file");

    // `-displayfd 1`: Xvfb picks a free display and prints its number on
    // stdout once it is ready, so no display in use is ever touched.
    let mut child = Command::new("Xvfb")
        .args(["-displayfd", "1", "-nolisten", "tcp", "-auth"])
        .arg(&auth)
        .args(["-screen", "0", "640x480x24"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn Xvfb");
    let stdout = child.stdout.take().expect("Xvfb stdout");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let mut xvfb = Xvfb {
        child,
        socket: PathBuf::new(),
        scratch,
    };
    let line = rx
        .recv_timeout(Duration::from_secs(20))
        .expect("Xvfb reported its display in time");
    let display: u32 = line
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("Xvfb display number, got {line:?}"));
    xvfb.socket = PathBuf::from(format!("/tmp/.X11-unix/X{display}"));
    xvfb
}

/// A loopback TCP tap in front of `socket`: records each connection's X11
/// setup (as it arrives from the forwarder), then relays it both ways.
async fn start_tap(socket: PathBuf) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen_tx, seen) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let seen_tx = seen_tx.clone();
            let socket = socket.clone();
            tokio::spawn(async move {
                let mut setup = vec![0u8; 12];
                if sock.read_exact(&mut setup).await.is_err() {
                    return;
                }
                let le = setup[0] == b'l';
                let len = |i: usize| {
                    let b = [setup[i], setup[i + 1]];
                    usize::from(if le {
                        u16::from_le_bytes(b)
                    } else {
                        u16::from_be_bytes(b)
                    })
                };
                let rest = len(6).div_ceil(4) * 4 + len(8).div_ceil(4) * 4;
                let mut tail = vec![0u8; rest];
                if sock.read_exact(&mut tail).await.is_err() {
                    return;
                }
                setup.extend_from_slice(&tail);
                let _ = seen_tx.send(setup.clone());
                let Ok(mut x) = tokio::net::UnixStream::connect(&socket).await else {
                    return;
                };
                if x.write_all(&setup).await.is_ok() {
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut x).await;
                }
            });
        }
    });
    (port, seen)
}

/// The `name` and `data` of an X11 connection setup.
fn setup_auth(setup: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let le = setup[0] == b'l';
    let len = |i: usize| {
        let b = [setup[i], setup[i + 1]];
        usize::from(if le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let (n, d) = (len(6), len(8));
    let data_at = 12 + n.div_ceil(4) * 4;
    (
        setup[12..12 + n].to_vec(),
        setup[data_at..data_at + d].to_vec(),
    )
}

/// Read the shell until `needle` shows or 60 s pass; everything read so far.
async fn read_until(
    reader: Box<dyn std::io::Read + Send>,
    needle: &'static str,
) -> (Box<dyn std::io::Read + Send>, String) {
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if String::from_utf8_lossy(&out).contains(needle) {
                        break;
                    }
                }
            }
        }
        (reader, String::from_utf8_lossy(&out).into_owned())
    })
    .await
    .expect("reader task")
}

/// The value printed as `<tag>[value]`, skipping the echo of the typed line
/// (where the value is still the unexpanded `$...`).
fn tagged(output: &str, tag: &str) -> Option<String> {
    output
        .split(tag)
        .skip(1)
        .find(|rest| !rest.starts_with('$'))
        .and_then(|rest| rest.split(']').next())
        .map(str::to_string)
}

#[tokio::test(flavor = "multi_thread")]
async fn x11_req_runs_a_real_x_client_end_to_end() {
    require_docker!(port_ssh_x11());
    if !host_has_xvfb() {
        assert!(
            !common::docker_required(),
            "Xvfb is not installed but {} is set: install xvfb on this runner",
            common::REQUIRE_DOCKER_ENV
        );
        eprintln!("SKIPPED: no Xvfb on this host for the real-X-client x11-req grade");
        return;
    }

    let xvfb = start_xvfb();
    let (tap_port, mut seen) = start_tap(xvfb.socket.clone()).await;
    set_x_server_provisioner(Arc::new(TapProvisioner(ResolvedXServer {
        info: LocalXServerInfo {
            display_number: 0,
            connection: LocalXConnection::Tcp("127.0.0.1".into(), tap_port),
        },
        cookie: Some(REAL_HEX.to_string()),
    })));

    let mut config = ssh_password_config(port_ssh_x11());
    config.enable_x11_forwarding = true;
    // Wide enough that the typed line's echo never wraps mid-token.
    config.cols = 400;
    let alive = Arc::new(AtomicBool::new(true));
    let handle = RusshSshConnector
        .open_shell(&config, alive.clone(), None)
        .await
        .expect("shell session connects");
    assert!(
        handle.extensions.iter().any(|e| e.is::<X11ReqForwarder>()),
        "the ssh-x11 fixture runs X11Forwarding yes, so x11-req forwarding must run"
    );

    // DISPLAY and the cookie come from sshd; xdpyinfo is the real X client.
    // The end marker is split so the echo of the typed line cannot match it.
    (handle.write)(
        b"echo \"TH_DISPLAY=[$DISPLAY]\"; xauth list \"$DISPLAY\"; O=$(mktemp); \
          timeout 30 xdpyinfo >\"$O\" 2>&1; echo \"TH_XDPY=[$?]\"; \
          grep -m1 -e '^name of display:' -e '^vendor string:' -e 'unable' \"$O\"; \
          rm -f \"$O\"; echo \"TH_\"\"END\"\n",
    )
    .expect("write to shell");
    let (_reader, output) = read_until(handle.reader, "TH_END").await;

    // Nothing was typed before our own line: sshd did the setup.
    let before_command = output.split("echo \"TH_DISPLAY").next().unwrap_or_default();
    for typed in [
        "export DISPLAY",
        "xauth add",
        "DISPLAY=localhost",
        "set -gx DISPLAY",
    ] {
        assert!(
            !before_command.contains(typed),
            "setup {typed:?} was typed into the shell: {output:?}"
        );
    }

    let display = tagged(&output, "TH_DISPLAY=[").unwrap_or_default();
    assert!(
        display.starts_with("localhost:"),
        "sshd must set DISPLAY: {output:?}"
    );

    // The real X client connected end to end (Xvfb accepts only the real
    // cookie, so this also proves the swap).
    assert_eq!(
        tagged(&output, "TH_XDPY=[").as_deref(),
        Some("0"),
        "xdpyinfo must connect through x11-req to the local Xvfb: {output:?}"
    );

    // Only the fake cookie is on the remote side.
    let fake_hex = output
        .lines()
        .find_map(|l| {
            let mut parts = l.split_whitespace();
            (parts.nth(1) == Some(MIT_MAGIC_COOKIE_1))
                .then(|| parts.next().map(str::to_string))
                .flatten()
        })
        .expect("sshd's xauth recorded a cookie for DISPLAY");
    assert_ne!(
        fake_hex.to_lowercase(),
        REAL_HEX,
        "the real cookie must never reach the remote host"
    );
    assert!(
        !output.to_lowercase().contains(REAL_HEX),
        "the real cookie must not appear anywhere on the remote side: {output:?}"
    );
    let fake = hex::decode(&fake_hex).expect("hex cookie");

    // The local side received the real cookie, never the fake one.
    let got = tokio::time::timeout(Duration::from_secs(5), seen.recv())
        .await
        .expect("the X11 connection reached the local tap")
        .expect("tap channel open");
    let (name, data) = setup_auth(&got);
    assert_eq!(name, MIT_MAGIC_COOKIE_1.as_bytes(), "auth protocol");
    assert_eq!(
        data,
        hex::decode(REAL_HEX).unwrap(),
        "the local X server must get the real cookie"
    );
    assert_ne!(
        data, fake,
        "the fake cookie must not reach the local X server"
    );

    alive.store(false, Ordering::SeqCst);
    let _ = (handle.close)();
    drop(xvfb);
}
