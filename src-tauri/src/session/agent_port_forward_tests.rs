//! Tests for the agent port forward (#3241): route parsing, the dial rewrite,
//! and the forward lifecycle against an in-process fake agent.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

// ── route + rewrite ────────────────────────────────────────────────

#[test]
fn no_agent_id_means_a_direct_connection() {
    assert_eq!(agent_route("vnc", &json!({ "host": "h" })).unwrap(), None);
    assert_eq!(
        agent_route("vnc", &json!({ "host": "h", "agentId": "" })).unwrap(),
        None
    );
}

#[test]
fn vnc_route_follows_the_display_then_port_rule() {
    let route = |s| agent_route("vnc", &s).unwrap().unwrap().target_port;
    assert_eq!(route(json!({ "agentId": "a", "host": "h" })), 5900);
    assert_eq!(
        route(json!({ "agentId": "a", "host": "h", "port": 5905 })),
        5905
    );
    assert_eq!(
        route(json!({ "agentId": "a", "host": "h", "port": 5905, "display": 2 })),
        5902
    );
    let r = agent_route("vnc", &json!({ "agentId": "a1", "host": " vnc.lan " }))
        .unwrap()
        .unwrap();
    assert_eq!(r.agent_id, "a1");
    assert_eq!(r.target_host, "vnc.lan");
}

#[test]
fn rdp_route_defaults_to_3389() {
    let r = agent_route("rdp", &json!({ "agentId": "a", "host": "win" }))
        .unwrap()
        .unwrap();
    assert_eq!(r.target_port, 3389);
    let r = agent_route(
        "rdp",
        &json!({ "agentId": "a", "host": "win", "port": "3390" }),
    )
    .unwrap()
    .unwrap();
    assert_eq!(r.target_port, 3390);
}

#[test]
fn unroutable_settings_are_rejected_with_a_reason() {
    let err = agent_route("vnc", &json!({ "agentId": "a" })).unwrap_err();
    assert!(err.contains("host"), "{err}");
    let err = agent_route(
        "vnc",
        &json!({ "agentId": "a", "host": "h", "useSshTunnel": true }),
    )
    .unwrap_err();
    assert!(err.contains("SSH tunnel"), "{err}");
    let err = agent_route(
        "mock-remote-desktop",
        &json!({ "agentId": "a", "host": "h" }),
    )
    .unwrap_err();
    assert!(err.contains("cannot be routed"), "{err}");
}

#[test]
fn rewrite_dials_loopback_and_keeps_the_vnc_tls_name() {
    let dial = rewrite_for_forward(
        "vnc",
        &json!({ "agentId": "a", "host": "vnc.lan", "port": 5901, "display": 1, "password": "p" }),
        40123,
    );
    assert_eq!(dial["host"], "127.0.0.1");
    assert_eq!(dial["port"], 40123);
    assert_eq!(dial["tlsServerName"], "vnc.lan");
    assert_eq!(dial["password"], "p");
    assert!(dial.get("agentId").is_none());
    assert!(dial.get("display").is_none());

    let rdp = rewrite_for_forward("rdp", &json!({ "agentId": "a", "host": "win" }), 40124);
    assert_eq!(rdp["host"], "127.0.0.1");
    assert!(rdp.get("tlsServerName").is_none());
}

#[test]
fn failure_messages_name_the_tunnel_and_the_cause() {
    let down = forward_failure_message(
        "vnc.lan",
        5900,
        &TerminalError::RemoteError("Agent a1 not connected".into()),
    );
    assert!(
        down.starts_with("Agent tunnel to vnc.lan:5900 failed"),
        "{down}"
    );
    assert!(down.contains("agent is not connected"), "{down}");

    let old = forward_failure_message(
        "h",
        1,
        &TerminalError::AgentUnsupported("method not found".into()),
    );
    assert!(old.contains("update the agent"), "{old}");

    let unreachable = forward_failure_message(
        "h",
        5900,
        &TerminalError::RemoteError("cannot reach h:5900 from the agent host: refused".into()),
    );
    assert!(unreachable.contains("from the agent host"), "{unreachable}");
}

// ── lifecycle against a fake agent ─────────────────────────────────

/// What the fake agent saw.
#[derive(Default)]
struct Log {
    opened: Vec<(String, String, u16)>,
    closed: Vec<String>,
}

/// An in-process stand-in for the agent: `open` really connects to the
/// target (like `agent.forward.connect`) and pumps it into the sink; `send`
/// writes to it; `close` drops it. `down` makes every open fail as a
/// disconnected agent would.
#[derive(Default)]
struct FakeAgent {
    down: std::sync::atomic::AtomicBool,
    log: Mutex<Log>,
    writers: Mutex<HashMap<String, UnboundedSender<Vec<u8>>>>,
    readers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Sinks toward the desktop, so a test can simulate the agent transport
    /// dropping every stream (the relay's `clear`).
    sinks: Mutex<HashMap<String, UnboundedSender<Vec<u8>>>>,
}

impl FakeAgent {
    fn drop_all_streams(&self) {
        self.sinks.lock().unwrap().clear();
        for (_, r) in self.readers.lock().unwrap().drain() {
            r.abort();
        }
        self.writers.lock().unwrap().clear();
    }
}

impl ForwardTransport for FakeAgent {
    fn open(
        &self,
        stream_id: &str,
        host: &str,
        port: u16,
        sink: UnboundedSender<Vec<u8>>,
    ) -> Result<(), String> {
        if self.down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(forward_failure_message(
                host,
                port,
                &TerminalError::RemoteError("Agent a1 not connected".into()),
            ));
        }
        let std_conn = std::net::TcpStream::connect((host, port)).map_err(|e| e.to_string())?;
        std_conn.set_nonblocking(true).unwrap();
        self.log
            .lock()
            .unwrap()
            .opened
            .push((stream_id.to_string(), host.to_string(), port));
        let rt = tokio::runtime::Handle::current();
        let conn = {
            let _g = rt.enter();
            TcpStream::from_std(std_conn).unwrap()
        };
        let (mut rd, mut wr) = conn.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        rt.spawn(async move {
            while let Some(b) = rx.recv().await {
                if wr.write_all(&b).await.is_err() {
                    break;
                }
            }
        });
        let to_desktop = sink.clone();
        let reader = rt.spawn(async move {
            let mut buf = vec![0u8; 1024];
            while let Ok(n) = rd.read(&mut buf).await {
                if n == 0 || to_desktop.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        self.writers
            .lock()
            .unwrap()
            .insert(stream_id.to_string(), tx);
        self.readers
            .lock()
            .unwrap()
            .insert(stream_id.to_string(), reader.abort_handle());
        self.sinks
            .lock()
            .unwrap()
            .insert(stream_id.to_string(), sink);
        Ok(())
    }

    fn send(&self, stream_id: &str, data: Vec<u8>) -> Result<(), String> {
        self.writers
            .lock()
            .unwrap()
            .get(stream_id)
            .ok_or("gone")?
            .send(data)
            .map_err(|_| "gone".to_string())
    }

    fn close(&self, stream_id: &str) {
        self.log.lock().unwrap().closed.push(stream_id.to_string());
        self.writers.lock().unwrap().remove(stream_id);
        self.sinks.lock().unwrap().remove(stream_id);
        if let Some(r) = self.readers.lock().unwrap().remove(stream_id) {
            r.abort();
        }
    }
}

/// An echo server standing in for the VNC/RDP target.
async fn echo_target() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = c.read(&mut buf).await {
                    if n == 0 || c.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

async fn roundtrip(port: u16, payload: &[u8]) -> TcpStream {
    let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    c.write_all(payload).await.unwrap();
    let mut got = vec![0u8; payload.len()];
    tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut got))
        .await
        .expect("echo in time")
        .unwrap();
    assert_eq!(got, payload);
    c
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..250 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not reached in time");
}

async fn expect_eof(c: &mut TcpStream) {
    let mut rest = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(5), c.read_to_end(&mut rest))
        .await
        .expect("EOF in time")
        .unwrap_or(0);
    assert_eq!(n, 0);
}

/// Connecting opens a stream to the configured target through the agent,
/// and bytes flow both ways.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connect_opens_a_stream_to_the_target() {
    let target = echo_target().await;
    let agent = Arc::new(FakeAgent::default());
    let fwd = AgentPortForward::start(agent.clone(), "127.0.0.1".into(), target)
        .await
        .unwrap();

    let _c = roundtrip(fwd.local_port(), b"RFB 003.008\n").await;
    let log = agent.log.lock().unwrap();
    assert_eq!(log.opened.len(), 1);
    assert_eq!(log.opened[0].1, "127.0.0.1");
    assert_eq!(log.opened[0].2, target);
    assert!(fwd.last_error().is_none());
}

/// Dropping the forward (the session disconnecting) closes its streams at the
/// agent and stops the listener.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_forward_closes_streams_and_the_listener() {
    let target = echo_target().await;
    let agent = Arc::new(FakeAgent::default());
    let fwd = AgentPortForward::start(agent.clone(), "127.0.0.1".into(), target)
        .await
        .unwrap();
    let port = fwd.local_port();
    let mut c = roundtrip(port, b"hello").await;

    drop(fwd);
    wait_until(|| agent.log.lock().unwrap().closed.len() == 1).await;
    expect_eof(&mut c).await;
    wait_until(|| std::net::TcpStream::connect(("127.0.0.1", port)).is_err()).await;
}

/// A reconnect (a fresh dial after the agent dropped every stream) opens a new
/// stream through the same forward.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_after_the_agent_drops_reopens_a_fresh_stream() {
    let target = echo_target().await;
    let agent = Arc::new(FakeAgent::default());
    let fwd = AgentPortForward::start(agent.clone(), "127.0.0.1".into(), target)
        .await
        .unwrap();
    let mut first = roundtrip(fwd.local_port(), b"one").await;

    // The agent transport breaks: the relay ends every stream.
    agent.drop_all_streams();
    expect_eof(&mut first).await;

    let _second = roundtrip(fwd.local_port(), b"two").await;
    let log = agent.log.lock().unwrap();
    assert_eq!(log.opened.len(), 2);
    assert_ne!(
        log.opened[0].0, log.opened[1].0,
        "each dial is its own stream"
    );
}

/// With the agent down, a dial is refused (the backend sees EOF) and the
/// forward records why; the next successful open clears it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_down_fails_the_dial_with_a_clear_reason() {
    let target = echo_target().await;
    let agent = Arc::new(FakeAgent::default());
    agent.down.store(true, std::sync::atomic::Ordering::SeqCst);
    let fwd = AgentPortForward::start(agent.clone(), "127.0.0.1".into(), target)
        .await
        .unwrap();

    let mut c = TcpStream::connect(("127.0.0.1", fwd.local_port()))
        .await
        .unwrap();
    expect_eof(&mut c).await;
    let err = fwd.last_error().expect("a recorded failure");
    assert!(err.contains("agent is not connected"), "{err}");
    assert!(agent.log.lock().unwrap().opened.is_empty());

    agent.down.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ok = roundtrip(fwd.local_port(), b"back").await;
    assert!(fwd.last_error().is_none());
}

// ── through the graphical session manager (VNC backend) ────────────

#[cfg(feature = "vnc")]
mod graphical {
    use super::*;
    use crate::session::graphical_manager::{
        GraphicalEventSink, GraphicalSessionManager, RemoteDesktopCertPromptEvent,
        RemoteDesktopClipboardEvent, RemoteDesktopCursorEvent, RemoteDesktopFrameEvent,
        RemoteDesktopStateEvent,
    };
    use crate::session::rdp_trust_store::RdpTrustStore;
    use termihub_core::connection::GraphicalState;

    #[derive(Clone, Default)]
    struct StateSink(Arc<Mutex<Vec<(GraphicalState, Option<String>)>>>);

    impl GraphicalEventSink for StateSink {
        fn emit_frame(&self, _: &RemoteDesktopFrameEvent) {}
        fn emit_cursor(&self, _: &RemoteDesktopCursorEvent) {}
        fn emit_clipboard(&self, _: &RemoteDesktopClipboardEvent) {}
        fn emit_state(&self, e: &RemoteDesktopStateEvent) {
            self.0.lock().unwrap().push((e.state, e.message.clone()));
        }
        fn emit_cert_prompt(&self, _: &RemoteDesktopCertPromptEvent) {}
    }

    fn manager() -> GraphicalSessionManager {
        let registry = Arc::new(crate::session::registry::build_desktop_registry());
        GraphicalSessionManager::new(registry, Arc::new(RdpTrustStore::in_memory()))
    }

    /// A minimal RFB 3.8 server with no authentication: version, security
    /// type None, SecurityResult OK, ServerInit — then it swallows whatever the
    /// client sends. Enough for the VNC backend to reach `Active`.
    async fn fake_vnc_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut v = [0u8; 12];
                    c.write_all(b"RFB 003.008\n").await?;
                    c.read_exact(&mut v).await?;
                    c.write_all(&[1, 1]).await?; // one security type: None
                    let mut pick = [0u8; 1];
                    c.read_exact(&mut pick).await?;
                    c.write_all(&0u32.to_be_bytes()).await?; // SecurityResult OK
                    let mut shared = [0u8; 1];
                    c.read_exact(&mut shared).await?;
                    let mut init = Vec::new();
                    init.extend_from_slice(&64u16.to_be_bytes());
                    init.extend_from_slice(&48u16.to_be_bytes());
                    // bpp 32, depth 24, little-endian, true colour, maxes, shifts.
                    init.extend_from_slice(&[32, 24, 0, 1]);
                    init.extend_from_slice(&255u16.to_be_bytes());
                    init.extend_from_slice(&255u16.to_be_bytes());
                    init.extend_from_slice(&255u16.to_be_bytes());
                    init.extend_from_slice(&[16, 8, 0, 0, 0, 0]);
                    init.extend_from_slice(&4u32.to_be_bytes());
                    init.extend_from_slice(b"fake");
                    c.write_all(&init).await?;
                    let mut sink = [0u8; 1024];
                    while c.read(&mut sink).await? > 0 {}
                    Ok::<_, std::io::Error>(())
                });
            }
        });
        port
    }

    fn route(port: u16) -> AgentRoute {
        AgentRoute {
            agent_id: "a1".into(),
            target_host: "127.0.0.1".into(),
            target_port: port,
        }
    }

    /// Connect opens the tunnel and the desktop VNC backend reaches `Active`
    /// through it; disconnect closes the agent stream with the session.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vnc_session_rides_the_agent_tunnel_and_disconnect_closes_it() {
        let vnc_port = fake_vnc_server().await;
        let agent = Arc::new(FakeAgent::default());
        let mgr = manager();
        let sink = StateSink::default();
        let settings = json!({ "agentId": "a1", "host": "127.0.0.1", "port": vnc_port });

        let sid = tokio::time::timeout(
            Duration::from_secs(20),
            mgr.connect_forwarded(
                "vnc",
                settings,
                route(vnc_port),
                agent.clone(),
                sink.clone(),
            ),
        )
        .await
        .expect("connect in time")
        .expect("connect through the tunnel");
        assert!(sink
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(s, _)| *s == GraphicalState::Active));
        assert_eq!(agent.log.lock().unwrap().opened.len(), 1);
        assert_eq!(agent.log.lock().unwrap().opened[0].2, vnc_port);

        mgr.disconnect(&sid, sink.clone()).await.unwrap();
        wait_until(|| !agent.log.lock().unwrap().closed.is_empty()).await;
    }

    /// With the agent down the connect fails and says so, not a bare EOF.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn agent_down_fails_the_connect_with_the_tunnel_reason() {
        let agent = Arc::new(FakeAgent::default());
        agent.down.store(true, std::sync::atomic::Ordering::SeqCst);
        let mgr = manager();
        let sink = StateSink::default();
        let settings = json!({ "agentId": "a1", "host": "127.0.0.1", "port": 5999 });

        let err = tokio::time::timeout(
            Duration::from_secs(20),
            mgr.connect_forwarded("vnc", settings, route(5999), agent, sink.clone()),
        )
        .await
        .expect("fails in time")
        .unwrap_err()
        .to_string();
        assert!(err.contains("agent is not connected"), "{err}");
        let states = sink.0.lock().unwrap().clone();
        let (_, msg) = states.last().unwrap();
        assert!(
            msg.as_deref().unwrap_or("").contains("Agent tunnel"),
            "{states:?}"
        );
        assert_eq!(mgr.session_count().await, 0);
    }
}
