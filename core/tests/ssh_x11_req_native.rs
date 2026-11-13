#![cfg(all(feature = "ssh", unix))]
//! X11 forwarding over `x11-req` against the **native** loopback sshd
//! fixture (#5570), which turns on `X11Forwarding` where `xauth` is installed
//! and points sshd's `xauth` at a scratch `XAUTHORITY`.
//!
//! The local X server is a fake (a loopback socket that records the setup
//! bytes), handed to the connect path through the X server provisioner, so
//! neither the user's X server nor their `~/.Xauthority` is touched. The test
//! plays the remote X client itself: sshd and the test share this host, so it
//! connects to sshd's forwarded display port with the cookie sshd's `xauth`
//! recorded, exactly as a client on the host would.
//!
//! Run locally with:
//!
//! ```sh
//! eval "$(scripts/internal/native-sshd-fixture.sh up --scratch-home)"
//! cargo test -p termihub-core --features ssh --test ssh_x11_req_native
//! scripts/internal/native-sshd-fixture.sh down
//! ```

mod common;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use common::require_native_sshd;
use termihub_core::backends::ssh::connector::{RusshSshConnector, SshConnector};
use termihub_core::backends::ssh::x11::{
    set_x_server_provisioner, LocalXConnection, LocalXServerInfo, ResolvedXServer, XServerLease,
    XServerProvisioner,
};
use termihub_core::backends::ssh::x11_req::{X11ReqForwarder, MIT_MAGIC_COOKIE_1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The fake local X server's (real) cookie.
const REAL_HEX: &str = "00112233445566778899aabbccddeeff";

/// Hands the connect path the fake local X server.
struct FakeProvisioner(ResolvedXServer);

#[async_trait::async_trait]
impl XServerProvisioner for FakeProvisioner {
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

/// An X11 connection setup (LSB first) with `MIT-MAGIC-COOKIE-1` + `cookie`.
fn setup(cookie: &[u8]) -> Vec<u8> {
    let name = MIT_MAGIC_COOKIE_1.as_bytes();
    let mut out = vec![b'l', 0, 11, 0, 0, 0];
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cookie.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(name);
    out.resize(12 + name.len().div_ceil(4) * 4, 0);
    out.extend_from_slice(cookie);
    out.resize(out.len().div_ceil(4) * 4, 0);
    out
}

/// Whether `xauth` is installed here, which is when the fixture turns on
/// `X11Forwarding` (sshd and the test share this host).
fn host_has_xauth() -> bool {
    std::path::Path::new("/opt/X11/bin/xauth").exists()
        || std::process::Command::new("sh")
            .args(["-c", "command -v xauth"])
            .output()
            .is_ok_and(|o| o.status.success())
}

/// Read the shell until `needle` shows or 20 s pass; everything read so far.
async fn read_until(
    reader: Box<dyn std::io::Read + Send>,
    needle: &'static str,
) -> (Box<dyn std::io::Read + Send>, String) {
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
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

#[tokio::test(flavor = "multi_thread")]
async fn x11_req_lets_sshd_set_display_and_swaps_the_cookie() {
    let sshd = require_native_sshd!();
    if sshd.scratch_home.is_none() {
        eprintln!("SKIPPED: X11 forwarding needs the fixture's scratch home (--scratch-home)");
        return;
    }

    // The fake local X server: records each connection's first bytes.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_port = listener.local_addr().unwrap().port();
    let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let seen_tx = seen_tx.clone();
            tokio::spawn(async move {
                let mut got = vec![0u8; 256];
                let n = sock.read(&mut got).await.unwrap_or(0);
                got.truncate(n);
                let _ = seen_tx.send(got);
            });
        }
    });
    set_x_server_provisioner(Arc::new(FakeProvisioner(ResolvedXServer {
        info: LocalXServerInfo {
            display_number: 0,
            connection: LocalXConnection::Tcp("127.0.0.1".into(), local_port),
        },
        cookie: Some(REAL_HEX.to_string()),
    })));

    let mut config = sshd.key_config();
    config.enable_x11_forwarding = true;
    let alive = Arc::new(AtomicBool::new(true));
    let handle = RusshSshConnector
        .open_shell(&config, alive.clone(), None)
        .await
        .expect("shell session connects");
    let forwarded = handle.extensions.iter().any(|e| e.is::<X11ReqForwarder>());
    if !forwarded && !host_has_xauth() {
        // The fixture leaves X11Forwarding off without xauth, so sshd refuses
        // x11-req; the typed fallback is covered elsewhere.
        eprintln!("SKIPPED: no xauth on this host, so the fixture sshd refuses x11-req");
        alive.store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = (handle.close)();
        return;
    }
    assert!(
        forwarded,
        "the fixture sshd accepts x11-req, so x11-req forwarding must run"
    );

    // DISPLAY comes from sshd, the cookie from sshd's xauth run. The end
    // marker is split so the echo of the typed line cannot match it.
    (handle.write)(
        b"X=$(command -v xauth || echo /opt/X11/bin/xauth); \
          echo \"TH_DISPLAY=[$DISPLAY]\"; \"$X\" list \"$DISPLAY\"; echo \"TH_\"\"END\"\n",
    )
    .expect("write to shell");
    let (_reader, output) = read_until(handle.reader, "TH_END").await;
    let before_command = output.split("X=$(command").next().unwrap_or_default();
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
    let display = output
        .split("TH_DISPLAY=[")
        .skip(1)
        // Skip the echo of the typed line itself.
        .find(|rest| !rest.starts_with('$'))
        .and_then(|rest| rest.split(']').next())
        .unwrap_or_default()
        .to_string();
    assert!(
        display.starts_with("localhost:"),
        "sshd must set DISPLAY: {output:?}"
    );
    let display_num: u16 = display["localhost:".len()..]
        .split('.')
        .next()
        .and_then(|n| n.parse().ok())
        .expect("display number");
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
    let fake = hex::decode(&fake_hex).expect("hex cookie");

    // A client on the host connects to sshd's display with the fake cookie;
    // the local X server receives the real one.
    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", 6000 + display_num))
        .await
        .expect("connect to the forwarded display");
    client.write_all(&setup(&fake)).await.unwrap();
    let got = tokio::time::timeout(Duration::from_secs(10), seen.recv())
        .await
        .expect("the X11 connection reached the local X server")
        .unwrap();
    let real = hex::decode(REAL_HEX).unwrap();
    assert_eq!(
        got,
        setup(&real),
        "the local X server must get the real cookie"
    );

    // Any other cookie is refused before the local X server.
    let mut wrong = tokio::net::TcpStream::connect(("127.0.0.1", 6000 + display_num))
        .await
        .expect("connect to the forwarded display");
    wrong.write_all(&setup(&real)).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(800), seen.recv())
            .await
            .is_err(),
        "a connection with the wrong cookie must not reach the local X server"
    );

    alive.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ = (handle.close)();
}
