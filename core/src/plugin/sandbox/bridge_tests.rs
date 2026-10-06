//! The host bridge service against hand-written runner frames (#4183): the
//! guards answer exactly as in process, denials are recorded, and hostile
//! frames are protocol violations.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{PluginStatus, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{
    BridgeOp, BridgeRequest, BridgeResult, ConnRef, FrameReader, Message, Sender, StreamAck,
    StreamChunk, StreamTransport,
};

use super::*;
use crate::plugin::capabilities::ConnectionPolicy;
use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::PluginPermission;

/// A `Write` that appends to a shared buffer, standing in for the channel.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A runner's host-side state with an attached bridge writing into `Capture`.
struct Harness {
    shared: Arc<Shared>,
    out: Capture,
    read_pos: usize,
}

impl Harness {
    fn new() -> Self {
        let shared = Shared::new(
            "probe".to_owned(),
            None,
            Arc::new(PluginLogLimiter::default()),
        );
        let out = Capture::default();
        let writer = Arc::new(ChannelWriter::new(Box::new(out.clone())));
        shared
            .bridge
            .attach(writer, CURRENT_PLUGIN_ABI_VERSION, Arc::downgrade(&shared));
        Self {
            shared,
            out,
            read_pos: 0,
        }
    }

    /// Allocate a session id and grant it `permissions`.
    fn session(&self, permissions: PermissionSet) -> u32 {
        let id = self.shared.next_session.fetch_add(1, Ordering::SeqCst);
        self.shared.bridge.open_session(
            id,
            BridgeGrant::new(permissions, ConnectionPolicy::default()),
        );
        id
    }

    fn request(&self, request_id: u64, session_id: u32, op: BridgeOp) -> Result<(), String> {
        self.shared.dispatch(Message::BridgeRequest(BridgeRequest {
            request_id,
            session_id,
            op,
        }))
    }

    /// The next frame the host wrote (waits for worker threads).
    fn next_frame(&mut self) -> Message {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let bytes = self.out.0.lock().unwrap()[self.read_pos..].to_vec();
            let mut reader = FrameReader::new(bytes.as_slice());
            if let Ok(Some(frame)) = reader.read_frame() {
                let consumed = bytes.len() - reader.get_ref().len();
                self.read_pos += consumed;
                return Message::decode_from_peer(frame, Sender::Runner).expect("a host frame");
            }
            assert!(Instant::now() < deadline, "no frame from the host");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn reply_to(&mut self, request_id: u64) -> BridgeResult {
        match self.next_frame() {
            Message::BridgeReply(reply) => {
                assert_eq!(reply.request_id, request_id);
                reply.result
            }
            other => panic!("expected a BridgeReply, got {other:?}"),
        }
    }
}

fn status(result: &BridgeResult) -> PluginStatus {
    match result {
        BridgeResult::Status { status } if *status == PluginStatus::PermissionDenied as i32 => {
            PluginStatus::PermissionDenied
        }
        BridgeResult::Status { status } if *status == PluginStatus::NotAlive as i32 => {
            PluginStatus::NotAlive
        }
        BridgeResult::Status { status } if *status == PluginStatus::ResourceLimit as i32 => {
            PluginStatus::ResourceLimit
        }
        BridgeResult::Status { status } if *status == PluginStatus::Io as i32 => PluginStatus::Io,
        other => panic!("expected a status, got {other:?}"),
    }
}

fn fs_perms(root: &std::path::Path) -> PermissionSet {
    PermissionSet::from_parts(
        [PluginPermission::Filesystem],
        &[root.to_str().unwrap().to_owned()],
    )
}

fn path_str(p: &std::path::Path) -> String {
    p.to_str().unwrap().to_owned()
}

#[test]
fn filesystem_requests_are_answered_inside_the_scope_only() {
    let mut h = Harness::new();
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().join("scoped");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("data.txt"), b"in scope").unwrap();
    std::fs::write(tmp.path().join("secret.txt"), b"secret").unwrap();
    let id = h.session(fs_perms(&root));

    let inside = path_str(&root.join("data.txt"));
    h.request(
        1,
        id,
        BridgeOp::ReadFile {
            path: inside.clone(),
            offset: 0,
        },
    )
    .unwrap();
    assert_eq!(
        h.reply_to(1),
        BridgeResult::Data {
            data: b"in scope".to_vec(),
            eof: true
        }
    );

    let outside = path_str(&tmp.path().join("secret.txt"));
    h.request(
        2,
        id,
        BridgeOp::ReadFile {
            path: outside.clone(),
            offset: 0,
        },
    )
    .unwrap();
    assert_eq!(status(&h.reply_to(2)), PluginStatus::PermissionDenied);

    let written = path_str(&root.join("new.txt"));
    h.request(
        3,
        id,
        BridgeOp::WriteFile {
            path: written.clone(),
            data: b"abc".to_vec(),
            mode: 0,
        },
    )
    .unwrap();
    assert_eq!(h.reply_to(3), BridgeResult::Written);
    assert_eq!(std::fs::read(root.join("new.txt")).unwrap(), b"abc");

    h.request(
        4,
        id,
        BridgeOp::WriteFile {
            path: path_str(&tmp.path().join("escape.txt")),
            data: b"x".to_vec(),
            mode: 0,
        },
    )
    .unwrap();
    assert_eq!(status(&h.reply_to(4)), PluginStatus::PermissionDenied);
    assert!(!tmp.path().join("escape.txt").exists());

    h.request(5, id, BridgeOp::Stat { path: inside }).unwrap();
    assert_eq!(
        h.reply_to(5),
        BridgeResult::Metadata {
            exists: true,
            is_dir: false,
            len: 8
        }
    );
    h.request(
        6,
        id,
        BridgeOp::ListDir {
            path: path_str(&root),
        },
    )
    .unwrap();
    match h.reply_to(6) {
        BridgeResult::Entries { mut names } => {
            names.sort();
            assert_eq!(names, ["data.txt", "new.txt"]);
        }
        other => panic!("expected entries, got {other:?}"),
    }

    // Both refusals are recorded as structured denial events.
    let denials = h.shared.bridge.denials();
    assert_eq!(denials.len(), 2);
    assert_eq!(denials[0].operation, "read_file");
    assert_eq!(denials[0].target, outside);
    assert_eq!(denials[0].reason, DenialReason::Permission);
    assert_eq!(denials[0].session_id, id);
    assert_eq!(denials[0].plugin_id, "probe");
    assert_eq!(denials[1].operation, "write_file");
}

#[test]
fn large_files_are_read_in_chunks() {
    let mut h = Harness::new();
    let tmp = tempfile::TempDir::new().unwrap();
    let blob: Vec<u8> = (0..MAX_BRIDGE_CHUNK + 10).map(|i| i as u8).collect();
    std::fs::write(tmp.path().join("big"), &blob).unwrap();
    let id = h.session(fs_perms(tmp.path()));
    let path = path_str(&tmp.path().join("big"));
    h.request(
        1,
        id,
        BridgeOp::ReadFile {
            path: path.clone(),
            offset: 0,
        },
    )
    .unwrap();
    match h.reply_to(1) {
        BridgeResult::Data { data, eof } => {
            assert_eq!(data.len(), MAX_BRIDGE_CHUNK);
            assert!(!eof);
        }
        other => panic!("{other:?}"),
    }
    h.request(
        2,
        id,
        BridgeOp::ReadFile {
            path,
            offset: MAX_BRIDGE_CHUNK as u64,
        },
    )
    .unwrap();
    assert_eq!(
        h.reply_to(2),
        BridgeResult::Data {
            data: blob[MAX_BRIDGE_CHUNK..].to_vec(),
            eof: true
        }
    );
}

#[test]
fn network_without_the_permission_is_denied_and_recorded() {
    let mut h = Harness::new();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Terminal], &[]));
    h.request(
        1,
        id,
        BridgeOp::OpenConnection {
            host: "127.0.0.1".into(),
            port: 9,
        },
    )
    .unwrap();
    assert_eq!(status(&h.reply_to(1)), PluginStatus::PermissionDenied);
    let denials = h.shared.bridge.denials();
    assert_eq!(denials.len(), 1);
    assert_eq!(denials[0].operation, "open_connection");
    assert_eq!(denials[0].target, "127.0.0.1:9");
}

/// A local TCP echo server; returns its port.
fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut sock in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                while let Ok(n) = sock.read(&mut buf) {
                    if n == 0 || sock.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

#[test]
fn a_proxied_connection_relays_bytes_and_releases_its_slot() {
    let mut h = Harness::new();
    let port = echo_server();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    h.request(
        1,
        id,
        BridgeOp::OpenConnection {
            host: "127.0.0.1".into(),
            port,
        },
    )
    .unwrap();
    // The test writer cannot pass descriptors: the host proxies.
    let conn_id = match h.reply_to(1) {
        BridgeResult::Connection { conn_id, transport } => {
            assert_eq!(transport, StreamTransport::Proxy);
            conn_id
        }
        other => panic!("{other:?}"),
    };
    assert_eq!(h.shared.bridge.open_connections(), 1);
    h.shared
        .dispatch(Message::StreamWrite(StreamChunk {
            conn_id,
            data: b"ping".to_vec(),
        }))
        .unwrap();
    let mut echoed = Vec::new();
    while echoed.len() < 4 {
        match h.next_frame() {
            Message::StreamWriteAck(ack) => assert!(!ack.failed),
            Message::StreamData(chunk) => echoed.extend(chunk.data),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(echoed, b"ping");
    h.shared
        .dispatch(Message::StreamAck(StreamAck {
            conn_id,
            bytes: 4,
            failed: false,
        }))
        .unwrap();
    h.shared
        .dispatch(Message::BridgeRelease(ConnRef { conn_id }))
        .unwrap();
    assert_eq!(h.shared.bridge.open_connections(), 0);
    // Late frames for the released connection are ignored.
    assert!(h
        .shared
        .dispatch(Message::StreamAck(StreamAck {
            conn_id,
            bytes: 1,
            failed: false,
        }))
        .is_ok());
}

#[test]
fn retiring_a_session_releases_its_connections_and_refuses_later_requests() {
    let mut h = Harness::new();
    let port = echo_server();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    let open = BridgeOp::OpenConnection {
        host: "127.0.0.1".into(),
        port,
    };
    h.request(1, id, open.clone()).unwrap();
    assert!(matches!(h.reply_to(1), BridgeResult::Connection { .. }));
    assert_eq!(h.shared.bridge.open_connections(), 1);
    h.shared.retire(id);
    assert_eq!(h.shared.bridge.open_connections(), 0);
    h.request(2, id, open).unwrap();
    assert_eq!(status(&h.reply_to(2)), PluginStatus::NotAlive);
}

#[test]
fn hostile_bridge_frames_are_violations() {
    let h = Harness::new();
    let tmp = tempfile::TempDir::new().unwrap();
    let id = h.session(fs_perms(tmp.path()));
    let stat = |path: String| BridgeOp::Stat { path };

    // A session that was never allocated.
    for bad in [0, id + 1, u32::MAX] {
        assert!(h.request(1, bad, stat("/".into())).is_err());
    }
    // An unknown write mode, an oversized chunk, a NUL or giant path, a giant
    // host name.
    let p = path_str(&tmp.path().join("f"));
    assert!(h
        .request(
            2,
            id,
            BridgeOp::WriteFile {
                path: p.clone(),
                data: vec![],
                mode: 7
            }
        )
        .is_err());
    assert!(h
        .request(
            3,
            id,
            BridgeOp::WriteFile {
                path: p,
                data: vec![0; MAX_BRIDGE_CHUNK + 1],
                mode: 0
            }
        )
        .is_err());
    assert!(h.request(4, id, stat("a\0b".into())).is_err());
    assert!(h
        .request(5, id, stat("x".repeat(MAX_PATH_LEN + 1)))
        .is_err());
    assert!(h
        .request(
            6,
            id,
            BridgeOp::OpenConnection {
                host: "h".repeat(MAX_HOST_LEN + 1),
                port: 1
            }
        )
        .is_err());
    // A duplicate in-flight request id.
    lock(&h.shared.bridge.in_flight).insert(42);
    assert!(h.request(42, id, stat("/".into())).is_err());
    // Stream frames for a connection that was never handed out.
    for conn_id in [0, 1, u64::MAX] {
        assert!(h
            .shared
            .dispatch(Message::BridgeRelease(ConnRef { conn_id }))
            .is_err());
        assert!(h
            .shared
            .dispatch(Message::StreamWrite(StreamChunk {
                conn_id,
                data: vec![1]
            }))
            .is_err());
        assert!(h
            .shared
            .dispatch(Message::StreamAck(StreamAck {
                conn_id,
                bytes: 1,
                failed: false
            }))
            .is_err());
    }
    // Host-only bridge kinds from the runner are refused by direction.
    let reply = Message::BridgeReply(termihub_plugin_runner::ipc::BridgeReply {
        request_id: 1,
        result: BridgeResult::Written,
    });
    let frame = termihub_plugin_runner::ipc::RawFrame {
        kind: reply.kind() as u8,
        payload: reply.encode().unwrap()[5..].to_vec(),
    };
    assert!(Message::decode_from_peer(frame, Sender::Host).is_err());
}

#[test]
fn too_many_requests_in_flight_are_refused_with_resource_limit() {
    let mut h = Harness::new();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Terminal], &[]));
    {
        let mut in_flight = lock(&h.shared.bridge.in_flight);
        for n in 0..MAX_IN_FLIGHT as u64 {
            in_flight.insert(1000 + n);
        }
    }
    h.request(1, id, BridgeOp::Stat { path: "/".into() })
        .unwrap();
    assert_eq!(status(&h.reply_to(1)), PluginStatus::ResourceLimit);
    assert_eq!(
        h.shared.bridge.denials()[0].reason,
        DenialReason::ResourceLimit
    );
}

#[test]
fn a_stream_frame_for_a_passed_socket_is_a_violation() {
    let h = Harness::new();
    let port = echo_server();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    let sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
    // Register a connection as if its socket had been passed.
    let slots = ConnectionSlots::new(&ConnectionPolicy::default());
    let conn_id = h.shared.bridge.next_conn.fetch_add(1, Ordering::SeqCst);
    lock(&h.shared.bridge.conns).insert(
        conn_id,
        HostConn {
            session_id: id,
            _slot: slots.try_reserve().unwrap(),
            proxy: None,
        },
    );
    drop(sock);
    assert!(h
        .shared
        .dispatch(Message::StreamWrite(StreamChunk {
            conn_id,
            data: vec![1]
        }))
        .is_err());
}

#[test]
fn denial_targets_are_sanitised_and_bounded() {
    assert_eq!(sanitize_target("a\nb\x1bc"), "abc");
    let long = "x".repeat(MAX_DENIAL_TARGET_CHARS + 5);
    let out = sanitize_target(&long);
    assert_eq!(out.chars().count(), MAX_DENIAL_TARGET_CHARS + 1);
    assert!(out.ends_with('…'));
}

#[test]
fn the_connect_deadline_covers_the_policy_timeout() {
    let grant = BridgeGrant::new(
        PermissionSet::from_parts([], &[]),
        ConnectionPolicy::new(1, Duration::from_secs(5)),
    );
    assert!(grant.connect_deadline() > Duration::from_secs(5));
}

/// Unix: an approved connection's socket itself crosses the channel.
#[cfg(unix)]
#[test]
fn an_approved_connection_passes_the_socket_over_the_channel() {
    use std::os::unix::net::UnixStream;
    use termihub_plugin_runner::ipc::fd::FdReader;

    let shared = Shared::new(
        "probe".to_owned(),
        None,
        Arc::new(PluginLogLimiter::default()),
    );
    let (host_end, runner_end) = UnixStream::pair().unwrap();
    let writer = Arc::new(ChannelWriter::unix(host_end).unwrap());
    shared
        .bridge
        .attach(writer, CURRENT_PLUGIN_ABI_VERSION, Arc::downgrade(&shared));
    let id = shared.next_session.fetch_add(1, Ordering::SeqCst);
    shared.bridge.open_session(
        id,
        BridgeGrant::new(
            PermissionSet::from_parts([PluginPermission::Network], &[]),
            ConnectionPolicy::default(),
        ),
    );
    let port = echo_server();
    shared
        .dispatch(Message::BridgeRequest(BridgeRequest {
            request_id: 7,
            session_id: id,
            op: BridgeOp::OpenConnection {
                host: "127.0.0.1".into(),
                port,
            },
        }))
        .unwrap();

    runner_end
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let reader = FdReader::new(runner_end);
    let fds = reader.fds();
    let mut frames = FrameReader::new(reader);
    let frame = frames.read_frame().unwrap().unwrap();
    match Message::decode_from_peer(frame, Sender::Runner).unwrap() {
        Message::BridgeReply(reply) => {
            assert_eq!(reply.request_id, 7);
            assert!(matches!(
                reply.result,
                BridgeResult::Connection {
                    transport: StreamTransport::HandlePassed,
                    ..
                }
            ));
        }
        other => panic!("{other:?}"),
    }
    let mut sock = TcpStream::from(fds.pop().expect("the passed socket"));
    sock.write_all(b"hello").unwrap();
    let mut got = [0u8; 5];
    sock.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"hello");
    // The slot stays reserved until the runner releases it.
    assert_eq!(shared.bridge.open_connections(), 1);
}
