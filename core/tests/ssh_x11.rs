//! Integration tests for SSH X11 forwarding against the `ssh-x11` Docker
//! fixture (`tests/docker/ssh-x11`, published on 127.0.0.1:2208).
//!
//! Regression coverage for issue #1304: the forwarded X11 connection must
//! actually reach termiHub's forwarder and be proxied to the local X server.
//! The forwarder must allocate a **conventional, small** remote display number
//! (like OpenSSH's `X11DisplayOffset`) rather than deriving a huge display from
//! an arbitrary ephemeral port (`:26961`), which stricter X clients reject so no
//! forwarded channel is ever opened.
//!
//! Also covers graceful degradation (MT-SSH-18): with X11 forwarding enabled but
//! no X server available, the SSH connect still succeeds and the shell runs.
#![cfg(feature = "ssh")]

mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::{port_ssh_x11, require_docker, ssh_exec, ssh_password_config};
use termihub_core::backends::ssh::connector::{RusshSshConnector, SshConnector};
use termihub_core::backends::ssh::x11::{
    set_x_server_provisioner, LocalXConnection, LocalXServerInfo, ResolvedXServer, X11Forwarder,
    XServerLease, XServerProvisioner,
};

/// End-to-end: run a real X client on the remote and assert the forwarded X11
/// connection reaches the forwarder and is proxied to the local X server, using
/// a small conventional remote display number.
#[tokio::test]
async fn x11_forwarding_delivers_channel_to_local_server() {
    require_docker!(port_ssh_x11());

    // Fake local "X server": a loopback TCP listener the forwarder proxies to.
    // A connection here proves the forwarded X11 channel reached the forwarder
    // AND was routed through to the local X server.
    let conns = Arc::new(AtomicU32::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake local X server");
    let local_port = listener.local_addr().unwrap().port();
    {
        let conns = conns.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                conns.fetch_add(1, Ordering::SeqCst);
                // Hold the socket briefly so the proxy's copy loop stays alive.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    drop(sock);
                });
            }
        });
    }

    let config = ssh_password_config(port_ssh_x11());
    let cancel = tokio_util::sync::CancellationToken::new();
    let (mut session, registry, _hold) =
        termihub_core::backends::ssh::jump_host::connect_target(&config, Some(&cancel))
            .await
            .expect("connect ssh-x11");

    // Point the forwarder at our fake local X server (cookieless).
    let resolved = ResolvedXServer {
        info: LocalXServerInfo {
            display_number: 0,
            connection: LocalXConnection::Tcp("127.0.0.1".to_string(), local_port),
        },
        cookie: None,
    };

    let alive = Arc::new(AtomicBool::new(true));
    let (_forwarder, remote_display, _cookie) =
        X11Forwarder::start(&config, &mut session, registry, alive, Some(resolved))
            .await
            .expect("start X11 forwarder");

    // The remote display number must be small and conventional (OpenSSH uses
    // X11DisplayOffset=10, so :10, :11, ...). The pre-fix code derived it from an
    // ephemeral port (`bound_port - 6000`), producing values in the tens of
    // thousands (e.g. :26961) that stricter X clients refuse to connect to.
    assert!(
        remote_display < 1000,
        "remote display :{remote_display} must be a small conventional number, \
         not an ephemeral-port-derived value"
    );

    // Run a real X client on the remote with the allocated display. It connects
    // to localhost:<remote_display> → sshd's forwarded listener → forwarded-tcpip
    // channel → our forwarder → the fake local X server.
    let cmd =
        format!("DISPLAY=localhost:{remote_display} timeout 5 xdpyinfo >/dev/null 2>&1; echo DONE");
    let _ = ssh_exec(&session, &cmd).await;

    // Give the proxy a moment to accept the inbound connection.
    for _ in 0..20 {
        if conns.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    assert!(
        conns.load(Ordering::SeqCst) > 0,
        "the forwarded X11 connection never reached the local X server \
         (no channel proxied) — issue #1304"
    );
}

/// A provisioner that always fails, standing in for the desktop app's
/// VcXsrv/XQuartz provisioning when no X server can be brought up.
struct FailingProvisioner;

#[async_trait::async_trait]
impl XServerProvisioner for FailingProvisioner {
    async fn ensure(
        &self,
        _cancel: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<XServerLease, String> {
        Err("test: no X server could be provisioned".to_string())
    }
}

/// Read from the shell until `needle` appears or the deadline passes, returning
/// everything read so far.
async fn read_until(
    mut reader: Box<dyn std::io::Read + Send>,
    needle: &'static str,
) -> (Box<dyn std::io::Read + Send>, String) {
    tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if String::from_utf8_lossy(&out).contains(needle) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        (reader, String::from_utf8_lossy(&out).into_owned())
    })
    .await
    .expect("reader task")
}

/// MT-SSH-18: X11 forwarding degrades gracefully without an X server.
///
/// With `enable_x11_forwarding=true`, a provisioner that fails and no
/// detectable local X server, the connect must still succeed and the shell must
/// be usable — the connector logs the failure and continues without display
/// forwarding (`connector.rs` fallback) instead of aborting the whole connect.
/// No `DISPLAY` is injected into the remote shell in that case.
#[tokio::test(flavor = "multi_thread")]
async fn x11_forwarding_degrades_gracefully_without_x_server() {
    require_docker!(port_ssh_x11());

    // Make local X server detection fail deterministically: an unparsable
    // DISPLAY short-circuits detection to "none" (it is honoured before the
    // socket/TCP fallbacks), independent of whether this host runs an X server.
    // The other test in this binary passes an explicit resolved server and never
    // consults DISPLAY or the provisioner.
    std::env::set_var("DISPLAY", "not-a-display");
    set_x_server_provisioner(Arc::new(FailingProvisioner));

    let mut config = ssh_password_config(port_ssh_x11());
    config.enable_x11_forwarding = true;

    let alive = Arc::new(AtomicBool::new(true));
    let handle = RusshSshConnector
        .open_shell(&config, alive.clone(), None)
        .await
        .expect("connect must succeed even though X11 forwarding cannot start");

    // No forwarder was started, so nothing X11-related is held for the session.
    assert!(
        !handle.extensions.iter().any(|e| e.is::<X11Forwarder>()),
        "no X11 forwarder should be running without an X server"
    );

    // The shell runs, and no DISPLAY was injected. The end marker is split in
    // the command so the terminal echo of the input line cannot match it.
    (handle.write)(b"echo \"TH_X11_DEGRADED=[${DISPLAY}]\" \"TH_\"\"END\"\n")
        .expect("write to shell");
    let (_reader, output) = read_until(handle.reader, "TH_END").await;
    assert!(
        output.contains("TH_X11_DEGRADED=[] TH_END"),
        "shell must run with an empty DISPLAY after X11 degradation, got: {output:?}"
    );

    alive.store(false, Ordering::SeqCst);
    let _ = (handle.close)();
}
