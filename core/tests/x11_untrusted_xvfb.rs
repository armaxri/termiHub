#![cfg(all(feature = "ssh", unix))]
//! Untrusted X11 cookies against a **real**, private X server (#5585).
//!
//! Starts its own `Xvfb` on a free display with a scratch authority file
//! (never the user's X server or `~/.Xauthority`) and asks termiHub for an
//! untrusted cookie with the real `xauth`:
//!
//! - where the server has the SECURITY extension (Xvfb on Linux), the cookie
//!   is generated, differs from the real one, and the X server accepts a
//!   client that presents it;
//! - where it has not (Xvfb from XQuartz on macOS), the decision is
//!   [`UntrustedUnavailable::NoSecurityExtension`]: X11 stays off.
//!
//! Skips (with a note) when `Xvfb` or `xauth` is not installed.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use termihub_core::backends::ssh::x11::{LocalXConnection, LocalXServerInfo, ResolvedXServer};
use termihub_core::backends::ssh::x11_req::MIT_MAGIC_COOKIE_1;
use termihub_core::backends::ssh::x11_untrusted::{
    choose_cookie, wild_authority_entry, UntrustedUnavailable, X11CookieDecision,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REAL_HEX: &str = "8899aabbccddeeff0011223344556677";

/// `name` from XQuartz's bin directory or `PATH`.
fn find_program(name: &str) -> Option<PathBuf> {
    let xquartz = Path::new("/opt/X11/bin").join(name);
    if xquartz.exists() {
        return Some(xquartz);
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|p| p.exists())
    })
}

/// A private Xvfb, killed on drop.
struct Xvfb {
    child: Child,
    display: u32,
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Xvfb {
    fn socket(&self) -> String {
        format!("/tmp/.X11-unix/X{}", self.display)
    }
}

/// Start Xvfb on a free display that only accepts `auth`'s cookie.
fn start_xvfb(xvfb: &Path, auth: &Path, scratch: &Path) -> Option<Xvfb> {
    for display in 150..200u32 {
        if Path::new(&format!("/tmp/.X{display}-lock")).exists()
            || Path::new(&format!("/tmp/.X11-unix/X{display}")).exists()
        {
            continue;
        }
        let child = Command::new(xvfb)
            .arg(format!(":{display}"))
            .args(["-auth"])
            .arg(auth)
            .args(["-nolisten", "tcp", "-screen", "0", "64x64x24"])
            .env("HOME", scratch)
            .env("XAUTHORITY", auth)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut server = Xvfb { child, display };
        for _ in 0..100 {
            if Path::new(&server.socket()).exists() {
                return Some(server);
            }
            if matches!(server.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(server);
    }
    None
}

/// An X11 connection setup (LSB first) presenting `cookie`.
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

/// Whether the X server at `socket` accepts a client presenting `cookie`
/// (the first reply byte is 1 for success, 0 for failure).
async fn server_accepts(socket: &str, cookie: &[u8]) -> bool {
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .expect("connect to the private Xvfb");
    stream.write_all(&setup(cookie)).await.unwrap();
    let mut status = [0u8; 1];
    tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut status))
        .await
        .expect("the X server answers the setup")
        .expect("read the setup reply");
    status[0] == 1
}

/// Whether the server lists the SECURITY extension (`None`: cannot tell).
fn has_security_extension(display: u32, auth: &Path) -> Option<bool> {
    let xdpyinfo = find_program("xdpyinfo")?;
    let out = Command::new(xdpyinfo)
        .args(["-display", &format!(":{display}"), "-queryExtensions"])
        .env("XAUTHORITY", auth)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).contains("SECURITY"))
}

#[tokio::test(flavor = "multi_thread")]
async fn untrusted_cookie_from_a_real_x_server() {
    let (Some(xvfb), Some(_xauth)) = (find_program("Xvfb"), find_program("xauth")) else {
        eprintln!("SKIPPED: needs Xvfb and xauth");
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let auth = scratch.path().join("server.auth");
    let real = hex::decode(REAL_HEX).unwrap();
    std::fs::write(&auth, wild_authority_entry(&real)).unwrap();
    let Some(server) = start_xvfb(&xvfb, &auth, scratch.path()) else {
        eprintln!("SKIPPED: could not start a private Xvfb");
        return;
    };
    // The private server enforces its cookie: proves the checks below mean
    // something.
    assert!(server_accepts(&server.socket(), &real).await);
    assert!(!server_accepts(&server.socket(), &[0x5a; 16]).await);

    let resolved = ResolvedXServer {
        info: LocalXServerInfo {
            display_number: server.display,
            connection: LocalXConnection::UnixSocket(server.socket()),
        },
        cookie: Some(REAL_HEX.to_string()),
    };
    let decision = choose_cookie(true, &resolved, Some(Duration::from_secs(60))).await;
    let security = has_security_extension(server.display, &auth);
    match decision {
        X11CookieDecision::Untrusted { .. } => {
            assert_ne!(security, Some(false), "generated without SECURITY?");
            let (applied, deadline) = decision.apply(resolved).expect("forwarded");
            assert!(deadline.is_some());
            let untrusted = hex::decode(applied.cookie.expect("a cookie")).unwrap();
            assert_ne!(untrusted, real, "the untrusted cookie is a new one");
            assert!(
                server_accepts(&server.socket(), &untrusted).await,
                "the X server accepts the generated untrusted cookie"
            );
        }
        X11CookieDecision::Refuse(UntrustedUnavailable::NoSecurityExtension) => {
            assert_ne!(security, Some(true), "SECURITY is listed but was not used");
            eprintln!("this Xvfb has no SECURITY extension: untrusted forwarding fails closed");
        }
        other => panic!("SECURITY listed: {security:?}, but got {other:?}"),
    }
    // Nothing was written next to the server's authority file.
    let entries: Vec<_> = std::fs::read_dir(scratch.path()).unwrap().collect();
    assert_eq!(entries.len(), 1, "only server.auth in the scratch dir");
}
