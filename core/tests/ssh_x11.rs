//! Integration tests for SSH X11 forwarding against the `ssh-x11` Docker
//! fixture (`tests/docker/ssh-x11`, published on 127.0.0.1:2208).
//!
//! Regression coverage for issue #1304: the forwarded X11 connection must
//! actually reach termiHub's forwarder and be proxied to the local X server.
//! The forwarder must allocate a **conventional, small** remote display number
//! (like OpenSSH's `X11DisplayOffset`) rather than deriving a huge display from
//! an arbitrary ephemeral port (`:26961`), which stricter X clients reject so no
//! forwarded channel is ever opened.
#![cfg(feature = "ssh")]

mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::{port_ssh_x11, require_docker, ssh_exec, ssh_password_config};
use termihub_core::backends::ssh::x11::{
    LocalXConnection, LocalXServerInfo, ResolvedXServer, X11Forwarder,
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
