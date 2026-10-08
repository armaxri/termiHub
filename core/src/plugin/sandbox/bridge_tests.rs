//! The host bridge service against hand-written runner frames (#4183): the
//! guards answer per the session's grant, denials are recorded, and hostile
//! frames are protocol violations.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{PluginStatus, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{
    BridgeOp, BridgeReply, BridgeRequest, BridgeResult, ConnRef, FrameReader, Message, Sender,
    StreamAck, StreamChunk, StreamTransport, LIST_DIR_ENTRY_OVERHEAD,
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
        Self::with_writer(ChannelWriter::new)
    }

    /// A harness whose writer `make` builds over the capture.
    fn with_writer(make: impl FnOnce(Box<dyn Write + Send>) -> ChannelWriter) -> Self {
        let shared = Shared::new(
            "probe".to_owned(),
            None,
            Arc::new(PluginLogLimiter::default()),
        );
        let out = Capture::default();
        let writer = Arc::new(make(Box::new(out.clone())));
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
            cursor: 0,
        },
    )
    .unwrap();
    match h.reply_to(6) {
        BridgeResult::Entries {
            mut names,
            next_cursor: 0,
        } => {
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

/// A directory of `count` files with `width`-byte names.
fn wide_dir(count: usize, width: usize) -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().unwrap();
    for i in 0..count {
        std::fs::write(tmp.path().join(format!("{i:0width$}")), b"").unwrap();
    }
    tmp
}

fn list(path: &str, cursor: u64) -> BridgeOp {
    BridgeOp::ListDir {
        path: path.to_owned(),
        cursor,
    }
}

/// One `list_dir` page: its names and the continuation cursor.
fn page(h: &mut Harness, request_id: u64) -> (Vec<String>, u64) {
    match h.reply_to(request_id) {
        BridgeResult::Entries { names, next_cursor } => (names, next_cursor),
        other => panic!("expected entries, got {other:?}"),
    }
}

#[test]
fn large_listings_are_paged_from_a_snapshot() {
    let mut h = Harness::new();
    // 3000 names of 200 bytes: over one chunk, so at least two pages.
    let tmp = wide_dir(3000, 200);
    let id = h.session(fs_perms(tmp.path()));
    let path = path_str(tmp.path());

    h.request(1, id, list(&path, 0)).unwrap();
    let (mut names, mut cursor) = page(&mut h, 1);
    assert_ne!(cursor, 0, "a listing over one frame is paged");
    let charged: usize = names
        .iter()
        .map(|n| n.len() + LIST_DIR_ENTRY_OVERHEAD)
        .sum();
    assert!(charged <= MAX_BRIDGE_CHUNK);
    // A file created between pages is not in this listing (snapshot).
    std::fs::write(tmp.path().join("late"), b"").unwrap();
    let first_cursor = cursor;
    let mut request_id = 2;
    while cursor != 0 {
        h.request(request_id, id, list(&path, cursor)).unwrap();
        let (more, next) = page(&mut h, request_id);
        assert!(!more.is_empty());
        names.extend(more);
        cursor = next;
        request_id += 1;
    }
    names.sort();
    let expected: Vec<String> = (0..3000).map(|i| format!("{i:0200}")).collect();
    assert_eq!(names, expected);
    assert!(lock(&h.shared.bridge.listings).is_empty());

    // A cursor is single-use: replaying a consumed one is an I/O error, not a
    // violation.
    h.request(request_id, id, list(&path, first_cursor))
        .unwrap();
    assert_eq!(status(&h.reply_to(request_id)), PluginStatus::Io);
}

#[test]
fn hostile_list_dir_continuations_are_violations() {
    let mut h = Harness::new();
    let tmp = wide_dir(3000, 200);
    let id = h.session(fs_perms(tmp.path()));
    let other = h.session(fs_perms(tmp.path()));
    let path = path_str(tmp.path());
    // A cursor the host never issued.
    for cursor in [1, 7, u64::MAX] {
        assert!(h.request(1, id, list(&path, cursor)).is_err());
    }
    h.request(2, id, list(&path, 0)).unwrap();
    let (_, cursor) = page(&mut h, 2);
    assert_ne!(cursor, 0);
    // A live cursor replayed for another session, or for another path.
    assert!(h.request(3, other, list(&path, cursor)).is_err());
    let elsewhere = path_str(&tmp.path().join("sub"));
    assert!(h.request(4, id, list(&elsewhere, cursor)).is_err());
    // The snapshot is untouched: its owner continues it.
    h.request(5, id, list(&path, cursor)).unwrap();
    page(&mut h, 5);
}

#[test]
fn abandoned_listings_are_bounded_and_dropped_with_their_session() {
    let mut h = Harness::new();
    let tmp = wide_dir(3000, 200);
    let id = h.session(fs_perms(tmp.path()));
    let path = path_str(tmp.path());
    // Start more listings than the host keeps; the least recently paged one
    // is dropped.
    let mut cursors = Vec::new();
    for request_id in 1..=(MAX_OPEN_LISTINGS as u64 + 1) {
        h.request(request_id, id, list(&path, 0)).unwrap();
        cursors.push(page(&mut h, request_id).1);
    }
    assert_eq!(lock(&h.shared.bridge.listings).len(), MAX_OPEN_LISTINGS);
    h.request(100, id, list(&path, cursors[0])).unwrap();
    assert_eq!(status(&h.reply_to(100)), PluginStatus::Io);
    // Retiring the session drops the rest.
    h.shared.bridge.close_session(id);
    assert!(lock(&h.shared.bridge.listings).is_empty());
}

#[test]
fn a_small_listing_is_one_page_and_keeps_no_state() {
    let mut h = Harness::new();
    let tmp = wide_dir(10, 4);
    let id = h.session(fs_perms(tmp.path()));
    h.request(1, id, list(&path_str(tmp.path()), 0)).unwrap();
    let (names, cursor) = page(&mut h, 1);
    assert_eq!((names.len(), cursor), (10, 0));
    assert!(lock(&h.shared.bridge.listings).is_empty());
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
            #[cfg(windows)]
            passed: None,
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
    let writer = Arc::new(ChannelWriter::for_channel(host_end).unwrap());
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
    assert_eq!(shared.bridge.handles_passed(), 1);
}

/// Unix: a passed socket is counted before its reply is sent. The runner may
/// use the socket, and the host see its output, the moment the reply lands, so
/// a count bumped only after the send raced a caller that checked it then
/// (#4262: the escape probe's "handed, not proxied" check saw 0). Here another
/// sender holds the channel, so the reply waits: the count must already be 1.
#[cfg(unix)]
#[test]
fn a_passed_socket_is_counted_before_its_reply_is_sent() {
    use std::os::unix::net::UnixStream;

    let shared = Shared::new(
        "probe".to_owned(),
        None,
        Arc::new(PluginLogLimiter::default()),
    );
    let (host_end, mut runner_end) = UnixStream::pair().unwrap();
    // Fill the channel, then have a plain frame block in its write while
    // holding the channel lock.
    let mut filler = host_end.try_clone().unwrap();
    filler.set_nonblocking(true).unwrap();
    while filler.write(&[0u8; 4096]).is_ok() {}
    filler.set_nonblocking(false).unwrap();
    let writer = Arc::new(ChannelWriter::for_channel(host_end).unwrap());
    let holder = {
        let writer = Arc::clone(&writer);
        std::thread::spawn(move || writer.write_frame(&[0u8; 4096]).unwrap())
    };
    std::thread::sleep(Duration::from_millis(100));
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
    shared
        .dispatch(Message::BridgeRequest(BridgeRequest {
            request_id: 7,
            session_id: id,
            op: BridgeOp::OpenConnection {
                host: "127.0.0.1".into(),
                port: echo_server(),
            },
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while shared.bridge.open_connections() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let counted = shared.bridge.handles_passed();
    // Drain the channel so the blocked frames go out either way.
    std::thread::spawn(move || {
        let mut sink = [0u8; 65536];
        while matches!(runner_end.read(&mut sink), Ok(n) if n > 0) {}
    });
    holder.join().unwrap();
    assert_eq!(
        shared.bridge.open_connections(),
        1,
        "the connection was handed out"
    );
    assert_eq!(
        counted, 1,
        "the pass was counted only after its reply was sent"
    );
}

/// Windows (#4219): a harness that duplicates sockets into "the runner" —
/// this very process, standing in for it.
#[cfg(windows)]
fn duplicating_harness() -> Harness {
    use std::os::windows::io::BorrowedHandle;
    // SAFETY: the current-process pseudo handle is always valid.
    let this = unsafe {
        BorrowedHandle::borrow_raw(windows_sys::Win32::System::Threading::GetCurrentProcess())
    }
    .try_clone_to_owned()
    .unwrap();
    Harness::with_writer(|out| ChannelWriter::new(out).passing_into(this))
}

/// Windows: open a connection to `port` and adopt the handle the host
/// duplicated for it, as the runner does.
#[cfg(windows)]
fn open_duplicated(
    h: &mut Harness,
    session_id: u32,
    port: u16,
) -> (u64, termihub_plugin_runner::ipc::handle::SocketStream) {
    use termihub_plugin_runner::ipc::handle::{adopt, SocketStream};
    h.request(
        1,
        session_id,
        BridgeOp::OpenConnection {
            host: "127.0.0.1".into(),
            port,
        },
    )
    .unwrap();
    match h.reply_to(1) {
        BridgeResult::Connection {
            conn_id,
            transport: StreamTransport::HandleDuplicated { handle },
        } => {
            // SAFETY: the host duplicated this handle into this process for
            // this reply.
            let socket = unsafe { adopt(handle) }.expect("a socket handle");
            (conn_id, SocketStream::new(socket))
        }
        other => panic!("expected a duplicated socket, got {other:?}"),
    }
}

/// Windows: an approved connection's socket is duplicated into the runner and
/// works there as a plain file handle; stream frames for it are a violation,
/// and its release shuts the connection down.
#[cfg(windows)]
#[test]
fn an_approved_connection_duplicates_the_socket_into_the_runner() {
    let mut h = duplicating_harness();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    let (conn_id, mut sock) = open_duplicated(&mut h, id, echo_server());
    sock.write_all(b"hello").unwrap();
    let mut got = [0u8; 5];
    sock.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"hello");
    assert_eq!(h.shared.bridge.open_connections(), 1);
    assert_eq!(h.shared.bridge.handles_passed(), 1);
    // The runner must not relay bytes for a connection it was handed.
    assert!(h
        .shared
        .dispatch(Message::StreamWrite(StreamChunk {
            conn_id,
            data: vec![1],
        }))
        .is_err());
    // Release frees the slot and ends the connection under the runner's copy.
    h.shared
        .dispatch(Message::BridgeRelease(ConnRef { conn_id }))
        .unwrap();
    assert_eq!(h.shared.bridge.open_connections(), 0);
    assert!(matches!(sock.read(&mut got), Ok(0) | Err(_)));
}

/// Windows: closing the session ends a passed connection the plugin still
/// holds — a blocked read in the runner returns.
#[cfg(windows)]
#[test]
fn closing_the_session_ends_a_duplicated_socket() {
    let mut h = duplicating_harness();
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    let (_conn_id, sock) = open_duplicated(&mut h, id, echo_server());
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 8];
        (&sock).read(&mut buf)
    });
    std::thread::sleep(Duration::from_millis(50));
    h.shared.bridge.close_session(id);
    assert!(matches!(reader.join().unwrap(), Ok(0) | Err(_)));
    assert_eq!(h.shared.bridge.open_connections(), 0);
}

/// Windows: the forced relay still proxies where duplication is possible.
#[cfg(windows)]
#[test]
fn a_forced_proxy_does_not_duplicate_the_socket() {
    let mut h = duplicating_harness();
    h.shared.bridge.set_force_proxy(true);
    let id = h.session(PermissionSet::from_parts([PluginPermission::Network], &[]));
    h.request(
        1,
        id,
        BridgeOp::OpenConnection {
            host: "127.0.0.1".into(),
            port: echo_server(),
        },
    )
    .unwrap();
    match h.reply_to(1) {
        BridgeResult::Connection { transport, .. } => {
            assert_eq!(transport, StreamTransport::Proxy);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.shared.bridge.handles_passed(), 0);
}

/// Concatenate encoded frames into one byte stream, as the runner would send
/// them before exiting.
fn stream_of(frames: &[Vec<u8>]) -> Vec<u8> {
    frames.concat()
}

fn stat_frame(request_id: u64, session_id: u32, path: &str) -> Vec<u8> {
    Message::BridgeRequest(BridgeRequest {
        request_id,
        session_id,
        op: BridgeOp::Stat { path: path.into() },
    })
    .encode()
    .unwrap()
}

#[test]
fn a_malformed_bridge_request_kills_the_runner_before_anything_else_is_served() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = path_str(tmp.path());

    // Control: two valid requests are both answered.
    let mut ok = Harness::new();
    let id = ok.session(fs_perms(tmp.path()));
    let input = stream_of(&[stat_frame(1, id, &dir), stat_frame(2, id, &dir)]);
    Arc::clone(&ok.shared).read_loop(input.as_slice());
    let first = ok.next_frame();
    let second = ok.next_frame();
    for frame in [first, second] {
        assert!(matches!(
            frame,
            Message::BridgeReply(BridgeReply {
                result: BridgeResult::Metadata { is_dir: true, .. },
                ..
            })
        ));
    }

    // A BridgeRequest whose payload does not decode, then a valid one: the
    // runner is killed at the first, so the second is never served.
    let bad = Harness::new();
    let id = bad.session(fs_perms(tmp.path()));
    let mut malformed = termihub_plugin_runner::ipc::encode_frame(
        termihub_plugin_runner::ipc::FrameKind::BridgeRequest as u8,
        &[&[0xC1, 0x00]],
    )
    .unwrap();
    malformed.extend(stat_frame(2, id, &dir));
    Arc::clone(&bad.shared).read_loop(malformed.as_slice());
    assert!(bad.shared.dead.load(Ordering::SeqCst));
    std::thread::sleep(Duration::from_millis(200));
    assert!(bad.out.0.lock().unwrap().is_empty(), "nothing was served");

    // Same for a well-formed request naming a session that never existed.
    let hostile = Harness::new();
    let id = hostile.session(fs_perms(tmp.path()));
    let input = stream_of(&[stat_frame(1, id + 7, &dir), stat_frame(2, id, &dir)]);
    Arc::clone(&hostile.shared).read_loop(input.as_slice());
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        hostile.out.0.lock().unwrap().is_empty(),
        "nothing was served"
    );
}
