//! The initial graphical connect is bounded by a connect timeout and is
//! cancellable by its `connect_id` (PARITY2-002, #4298).
//!
//! Driven against a real VNC backend dialling a local TCP listener that
//! accepts the connection but never sends the RFB greeting — the shape of a
//! wedged or wrong-protocol peer that used to leave the tab "Connecting…"
//! forever.

use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use super::*;

/// Records lifecycle states; frames/cursors are irrelevant here.
#[derive(Clone, Default)]
struct StateSink {
    states: Arc<StdMutex<Vec<GraphicalState>>>,
}

impl GraphicalEventSink for StateSink {
    fn emit_frame(&self, _: &RemoteDesktopFrameEvent) {}
    fn emit_cursor(&self, _: &RemoteDesktopCursorEvent) {}
    fn emit_clipboard(&self, _: &RemoteDesktopClipboardEvent) {}
    fn emit_state(&self, event: &RemoteDesktopStateEvent) {
        self.states.lock().unwrap().push(event.state);
    }
    fn emit_cert_prompt(&self, _: &RemoteDesktopCertPromptEvent) {}
}

impl StateSink {
    fn states(&self) -> Vec<GraphicalState> {
        self.states.lock().unwrap().clone()
    }
}

fn manager() -> GraphicalSessionManager {
    let registry = Arc::new(crate::session::registry::build_desktop_registry());
    GraphicalSessionManager::new(registry, Arc::new(RdpTrustStore::in_memory()))
}

/// A listener that accepts connections and never writes a byte. Each accepted
/// socket is handed to the test so it can observe the client closing it.
async fn silent_peer() -> (u16, mpsc::UnboundedReceiver<TcpStream>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            if tx.send(sock).is_err() {
                break;
            }
        }
    });
    (port, rx)
}

/// Wait until the client side of `sock` is closed (read returns EOF or an
/// error), bounded so a leaked socket fails the test instead of hanging it.
async fn assert_client_closed(mut sock: TcpStream) {
    let mut buf = [0u8; 64];
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match sock.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                // The RFB client never writes before the server greeting, but
                // tolerate stray bytes: only EOF proves the socket was closed.
                Ok(_) => continue,
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the client socket must be closed after the connect ends"
    );
}

#[cfg(feature = "vnc")]
#[tokio::test]
async fn vnc_connect_times_out_when_the_peer_never_speaks_rfb() {
    let (port, mut accepted) = silent_peer().await;
    let mgr = manager();
    let sink = StateSink::default();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "connectTimeoutSecs": 1,
    });

    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        mgr.connect_routed("vnc", settings, None, Some("tab-t:1"), sink.clone()),
    )
    .await
    .expect("the connect must not hang past its timeout");
    let elapsed = started.elapsed();

    match result {
        Err(TerminalError::ConnectionFailed(msg)) => {
            assert!(msg.contains("timed out"), "unexpected message: {msg}");
            assert!(msg.contains("1s"), "message names the timeout: {msg}");
        }
        other => panic!("expected a connect timeout, got {other:?}"),
    }
    assert!(
        elapsed >= Duration::from_millis(900) && elapsed < Duration::from_secs(5),
        "timed out after {elapsed:?}, expected about 1 s"
    );
    assert_eq!(
        sink.states(),
        vec![
            GraphicalState::Connecting,
            GraphicalState::Authenticating,
            GraphicalState::ConnectFailed,
        ]
    );
    assert_eq!(mgr.session_count().await, 0);
    // The connect's cancellation entry is gone once it ended.
    assert!(!mgr.cancel_connecting("tab-t:1"));

    let sock = accepted.recv().await.expect("the backend dialled the peer");
    assert_client_closed(sock).await;
}

#[cfg(feature = "vnc")]
#[tokio::test]
async fn cancelling_a_connecting_vnc_session_aborts_it_promptly() {
    let (port, mut accepted) = silent_peer().await;
    let mgr = manager();
    let sink = StateSink::default();
    // No explicit timeout: the default (30 s) must not be what ends it.
    let settings = serde_json::json!({ "host": "127.0.0.1", "port": port });

    let connecting = {
        let mgr = mgr.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            mgr.connect_routed("vnc", settings, None, Some("tab-c:1"), sink)
                .await
        })
    };

    // Wait until the backend is mid-handshake (TCP up, waiting for RFB).
    let sock = tokio::time::timeout(Duration::from_secs(5), accepted.recv())
        .await
        .expect("the backend dials the peer")
        .expect("socket");

    let started = Instant::now();
    assert!(
        mgr.cancel_connecting("tab-c:1"),
        "a connecting session is cancellable by its connect id"
    );
    let result = tokio::time::timeout(Duration::from_secs(2), connecting)
        .await
        .expect("cancel aborts the connect promptly")
        .expect("join");
    assert!(started.elapsed() < Duration::from_secs(2));

    match result {
        Err(TerminalError::ConnectionFailed(msg)) => {
            assert!(msg.contains("cancelled"), "unexpected message: {msg}");
        }
        other => panic!("expected a cancelled connect, got {other:?}"),
    }
    assert_eq!(
        sink.states().last(),
        Some(&GraphicalState::ConnectFailed),
        "the cancelled attempt rests on a failed state, never Active"
    );
    assert_eq!(mgr.session_count().await, 0);
    assert!(!mgr.cancel_connecting("tab-c:1"), "the entry is cleared");

    assert_client_closed(sock).await;
}

#[tokio::test]
async fn cancelling_an_unknown_connect_id_is_a_no_op() {
    let mgr = manager();
    assert!(!mgr.cancel_connecting("nope"));
}

#[test]
fn connect_timeout_honours_the_unified_setting_and_defaults_otherwise() {
    use serde_json::json;
    let default = DEFAULT_GRAPHICAL_CONNECT_TIMEOUT;
    assert_eq!(default, Duration::from_secs(30));
    assert_eq!(graphical_connect_timeout(&json!({})), default);
    assert_eq!(
        graphical_connect_timeout(&json!({ "connectTimeoutSecs": 12 })),
        Duration::from_secs(12)
    );
    // Invalid values fall back to the default rather than disabling the bound.
    for bad in [json!(0), json!(-5), json!("10"), json!(null), json!(1.5)] {
        assert_eq!(
            graphical_connect_timeout(&json!({ "connectTimeoutSecs": bad })),
            default,
            "{bad}"
        );
    }
    // An absurd value is capped so the connect stays bounded.
    assert_eq!(
        graphical_connect_timeout(&json!({ "connectTimeoutSecs": 1_000_000 })),
        MAX_GRAPHICAL_CONNECT_TIMEOUT
    );
}
