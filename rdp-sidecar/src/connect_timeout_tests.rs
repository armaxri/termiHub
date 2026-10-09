//! The sidecar bounds its TCP connect and RDP negotiation by the connect
//! timeout (#4320, #4401), and classifies the outcome so the desktop's Test
//! connection reports a typed verdict. Driven against local sockets — no RDP
//! server needed.

use std::time::{Duration, Instant};

use termihub_core::backends::rdp_sidecar::config::RdpConfig;
use termihub_core::backends::rdp_sidecar::protocol::SidecarFailureKind;
use tokio::net::TcpListener;

use super::connect_session;
use crate::failure;

fn config_for(port: u16, timeout_secs: u64) -> RdpConfig {
    RdpConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "user".to_string(),
        password: "secret".to_string(),
        connect_timeout_secs: Some(timeout_secs),
        ..RdpConfig::default()
    }
}

async fn connect_error(cfg: &RdpConfig) -> anyhow::Error {
    let mut ipc_in = tokio::io::empty();
    let mut ipc_out = tokio::io::sink();
    match connect_session(cfg, &mut ipc_in, &mut ipc_out).await {
        Ok(_) => panic!("connecting to a non-RDP peer must fail"),
        Err(e) => e,
    }
}

/// A peer that accepts TCP but never speaks RDP used to hang the X.224
/// negotiation forever; it now times out with the typed timeout kind.
#[tokio::test]
async fn a_listener_that_never_speaks_rdp_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // Accept and hold the socket open without ever answering.
    let holder = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(socket);
    });

    let started = Instant::now();
    let error = tokio::time::timeout(Duration::from_secs(15), connect_error(&config_for(port, 1)))
        .await
        .expect("the connect must be bounded by its 1 s timeout");
    holder.abort();

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(failure::classify(&error), SidecarFailureKind::Timeout);
    let message = format!("{error:#}");
    assert!(message.contains("timed out after 1s"), "{message}");
    assert!(message.contains(&format!("127.0.0.1:{port}")), "{message}");
}

/// A closed port fails fast as an ordinary (unreachable) connect failure, not
/// a timeout.
#[tokio::test]
async fn a_closed_port_is_an_unreachable_connect_failure() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };

    let error = tokio::time::timeout(
        Duration::from_secs(15),
        connect_error(&config_for(port, 10)),
    )
    .await
    .expect("a refused connect must fail promptly");

    assert_eq!(failure::classify(&error), SidecarFailureKind::Connect);
    let message = format!("{error:#}");
    assert!(message.contains("TCP connect"), "{message}");
}

/// A clipboard failure that ends the session is reported to the host as a
/// typed `Failure` before the loop breaks (OBS2-003), so the desktop records
/// the reason instead of an unexplained disconnect.
#[tokio::test]
async fn a_clipboard_failure_is_reported_as_a_typed_failure() {
    use termihub_core::backends::rdp_sidecar::protocol::{read_message, SidecarMessage};

    let mut out = Vec::new();
    super::report_clipboard_failure(&mut out, &anyhow::anyhow!("format list rejected")).await;
    match read_message::<_, SidecarMessage>(&mut out.as_slice())
        .await
        .unwrap()
    {
        SidecarMessage::Failure { kind, message } => {
            assert_eq!(kind, SidecarFailureKind::Connect);
            assert!(message.contains("format list rejected"), "{message}");
        }
        other => panic!("expected a typed Failure, got {other:?}"),
    }
}
