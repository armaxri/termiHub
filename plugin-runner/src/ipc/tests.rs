//! Codec and message tests: round trips for every kind, the untrusted-peer
//! rejections, and property tests that arbitrary bytes never panic the decoder
//! and arbitrary messages survive a round trip through a byte stream split at
//! arbitrary points.

use std::io::{Cursor, Read};

use proptest::prelude::*;

use super::*;

fn sample_messages() -> Vec<Message> {
    vec![
        Message::Hello(Hello {
            runner_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            pid: 42,
        }),
        Message::Configure(Configure {
            library_path: "/p/backend/libx.so".into(),
            expected_digest: Some("sha256:00".into()),
            manifest_api_version: Some("1.1".into()),
            accept_unverified_toolchain: false,
            plugin_id: "x".into(),
            host_version: "1.2.3".into(),
        }),
        Message::SandboxReport(SandboxReport::default()),
        Message::Loaded(Loaded {
            id: "x".into(),
            name: "X".into(),
            version: "1.0.0".into(),
            abi_version: 0x0001_0001,
            toolchain: Some(WireToolchain {
                rustc: "1.98.0 (abc)".into(),
                panic_strategy: 1,
            }),
        }),
        Message::LoadFailed(LoadFailed {
            incompatible: true,
            message: "nope".into(),
        }),
        Message::CreateSession(CreateSession {
            session_id: 7,
            config_json: "{}".into(),
            settings_json: "{\"a\":1}".into(),
            data_dir: String::new(),
        }),
        Message::SessionCreated(SessionRef { session_id: 7 }),
        Message::SessionFailed(SessionFailed {
            session_id: 7,
            error: WireError {
                status: 3,
                message: "bad".into(),
            },
        }),
        Message::Input {
            session_id: 7,
            data: b"hello".to_vec(),
        },
        Message::Output {
            session_id: u32::MAX,
            data: Vec::new(),
        },
        Message::Resize(Resize {
            session_id: 7,
            cols: 80,
            rows: 24,
        }),
        Message::Close(SessionRef { session_id: 7 }),
        Message::Closed(SessionRef { session_id: 7 }),
        Message::Cancel(Cancel { session_id: None }),
        Message::Cancel(Cancel {
            session_id: Some(7),
        }),
        Message::SessionError(SessionError {
            session_id: 7,
            operation: "write_input".into(),
            error: WireError {
                status: 2,
                message: "dead".into(),
            },
        }),
        Message::Alive(Alive {
            session_id: 7,
            alive: false,
        }),
        Message::Log(Log {
            session_id: Some(7),
            level: 3,
            message: "hi".into(),
            truncated: false,
        }),
        Message::Ping(Heartbeat { nonce: 9 }),
        Message::Pong(Heartbeat { nonce: 9 }),
        Message::Shutdown,
    ]
}

fn read_all(bytes: &[u8]) -> Vec<Message> {
    let mut reader = FrameReader::new(Cursor::new(bytes));
    let mut out = Vec::new();
    while let Some(frame) = reader.read_frame().expect("valid stream") {
        out.push(Message::decode(frame).expect("valid frame"));
    }
    out
}

#[test]
fn every_kind_round_trips() {
    let messages = sample_messages();
    let covered: std::collections::HashSet<FrameKind> =
        messages.iter().map(Message::kind).collect();
    for kind in FrameKind::ALL {
        assert!(covered.contains(kind), "{kind:?} has no round-trip sample");
    }
    let mut stream = Vec::new();
    for m in &messages {
        stream.extend(m.encode().expect("encodes"));
    }
    assert_eq!(read_all(&stream), messages);
}

#[test]
fn kind_bytes_are_unique_and_decode_back() {
    let mut seen = std::collections::HashSet::new();
    for kind in FrameKind::ALL {
        assert!(seen.insert(*kind as u8), "duplicate byte for {kind:?}");
        assert_eq!(FrameKind::from_u8(*kind as u8), Some(*kind));
    }
}

#[test]
fn clean_eof_at_a_boundary_is_none() {
    let mut reader = FrameReader::new(Cursor::new(Vec::<u8>::new()));
    assert!(reader.read_frame().expect("clean eof").is_none());
}

#[test]
fn eof_inside_a_frame_is_truncated() {
    let frame = Message::Ping(Heartbeat { nonce: 1 }).encode().unwrap();
    for cut in 1..frame.len() {
        let mut reader = FrameReader::new(Cursor::new(&frame[..cut]));
        assert!(
            matches!(reader.read_frame(), Err(ProtocolError::Truncated)),
            "cut at {cut}"
        );
    }
}

#[test]
fn oversized_and_empty_frames_are_refused_before_allocation() {
    let too_big = u32::try_from(MAX_FRAME_LEN + 1).unwrap().to_be_bytes();
    let mut reader = FrameReader::new(Cursor::new(too_big.to_vec()));
    assert!(matches!(
        reader.read_frame(),
        Err(ProtocolError::FrameTooLarge(n)) if n == MAX_FRAME_LEN + 1
    ));
    let mut reader = FrameReader::new(Cursor::new(vec![0, 0, 0, 0]));
    assert!(matches!(
        reader.read_frame(),
        Err(ProtocolError::EmptyFrame)
    ));
}

#[test]
fn the_largest_payload_fits_and_one_more_byte_does_not() {
    let max = vec![0xAB; MAX_PAYLOAD_LEN - SESSION_ID_LEN];
    let frame = encode_data_frame(FrameKind::Output, 1, &max).expect("max fits");
    assert_eq!(frame.len(), LENGTH_PREFIX_LEN + MAX_FRAME_LEN);
    match read_all(&frame).as_slice() {
        [Message::Output {
            session_id: 1,
            data,
        }] => assert_eq!(data.len(), max.len()),
        other => panic!("unexpected {other:?}"),
    }
    let over = vec![0u8; MAX_PAYLOAD_LEN - SESSION_ID_LEN + 1];
    assert!(matches!(
        encode_data_frame(FrameKind::Output, 1, &over),
        Err(ProtocolError::FrameTooLarge(_))
    ));
}

#[test]
fn unknown_kind_and_malformed_payloads_are_violations() {
    assert!(matches!(
        Message::decode(RawFrame {
            kind: 0xEE,
            payload: vec![]
        }),
        Err(ProtocolError::UnknownKind(0xEE))
    ));
    // A data frame shorter than its session id.
    assert!(matches!(
        Message::decode(RawFrame {
            kind: FrameKind::Output as u8,
            payload: vec![0, 0, 1]
        }),
        Err(ProtocolError::Malformed { .. })
    ));
    // Garbage where MessagePack is expected.
    assert!(matches!(
        Message::decode(RawFrame {
            kind: FrameKind::Hello as u8,
            payload: vec![0xC1]
        }),
        Err(ProtocolError::Malformed { .. })
    ));
    // Trailing bytes after a valid control payload.
    let mut frame = Message::Ping(Heartbeat { nonce: 3 }).encode().unwrap();
    let payload = frame.split_off(LENGTH_PREFIX_LEN + 1);
    let mut padded = payload.clone();
    padded.push(0);
    assert!(matches!(
        Message::decode(RawFrame {
            kind: FrameKind::Ping as u8,
            payload: padded
        }),
        Err(ProtocolError::Malformed { .. })
    ));
    // Shutdown carries no payload.
    assert!(matches!(
        Message::decode(RawFrame {
            kind: FrameKind::Shutdown as u8,
            payload: vec![1]
        }),
        Err(ProtocolError::Malformed { .. })
    ));
}

#[test]
fn each_side_refuses_frames_only_it_may_send() {
    let output = RawFrame {
        kind: FrameKind::Output as u8,
        payload: vec![0, 0, 0, 1],
    };
    assert!(Message::decode_from_peer(output.clone(), Sender::Host).is_ok());
    assert!(matches!(
        Message::decode_from_peer(output, Sender::Runner),
        Err(ProtocolError::WrongDirection(FrameKind::Output))
    ));
    let shutdown = RawFrame {
        kind: FrameKind::Shutdown as u8,
        payload: vec![],
    };
    assert!(matches!(
        Message::decode_from_peer(shutdown, Sender::Host),
        Err(ProtocolError::WrongDirection(FrameKind::Shutdown))
    ));
}

#[test]
fn wire_errors_map_back_to_plugin_errors() {
    use termihub_plugin_api::PluginError;
    let cases = [
        PluginError::ChannelClosed,
        PluginError::NotAlive,
        PluginError::InvalidConfig("x".into()),
        PluginError::Io("y".into()),
        PluginError::Panicked,
        PluginError::PermissionDenied,
        PluginError::ResourceLimit,
        PluginError::Other("z".into()),
    ];
    for err in cases {
        let back = WireError::from_error(&err).into_error();
        assert_eq!(
            std::mem::discriminant(&back),
            std::mem::discriminant(&err),
            "{err:?} -> {back:?}"
        );
    }
    let unknown = WireError {
        status: 999,
        message: "m".into(),
    };
    assert!(matches!(unknown.into_error(), PluginError::Other(m) if m == "m"));
}

/// A reader that hands out at most `chunk` bytes per `read`, to exercise
/// frames split across reads.
struct Chunked<'a> {
    data: &'a [u8],
    chunk: usize,
}

impl Read for Chunked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.chunk.min(buf.len()).min(self.data.len());
        buf[..n].copy_from_slice(&self.data[..n]);
        self.data = &self.data[n..];
        Ok(n)
    }
}

fn arb_message() -> impl Strategy<Value = Message> {
    prop_oneof![
        (
            any::<u32>(),
            proptest::collection::vec(any::<u8>(), 0..2048)
        )
            .prop_map(|(session_id, data)| Message::Input { session_id, data }),
        (
            any::<u32>(),
            proptest::collection::vec(any::<u8>(), 0..2048)
        )
            .prop_map(|(session_id, data)| Message::Output { session_id, data }),
        (any::<u32>(), ".{0,64}", ".{0,64}", ".{0,32}").prop_map(|(session_id, c, s, d)| {
            Message::CreateSession(CreateSession {
                session_id,
                config_json: c,
                settings_json: s,
                data_dir: d,
            })
        }),
        (any::<u32>(), any::<u16>(), any::<u16>()).prop_map(|(session_id, cols, rows)| {
            Message::Resize(Resize {
                session_id,
                cols,
                rows,
            })
        }),
        (
            proptest::option::of(any::<u32>()),
            any::<u32>(),
            ".{0,200}",
            any::<bool>()
        )
            .prop_map(|(session_id, level, message, truncated)| Message::Log(Log {
                session_id,
                level,
                message,
                truncated,
            })),
        proptest::option::of(any::<u32>())
            .prop_map(|session_id| Message::Cancel(Cancel { session_id })),
        any::<u64>().prop_map(|nonce| Message::Ping(Heartbeat { nonce })),
        Just(Message::Shutdown),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Arbitrary messages survive encode → byte stream (read in arbitrary
    /// chunk sizes) → decode, in order.
    #[test]
    fn arbitrary_streams_round_trip(
        messages in proptest::collection::vec(arb_message(), 0..16),
        chunk in 1usize..64,
    ) {
        let mut stream = Vec::new();
        for m in &messages {
            stream.extend(m.encode().unwrap());
        }
        let mut reader = FrameReader::new(Chunked { data: &stream, chunk });
        let mut decoded = Vec::new();
        while let Some(frame) = reader.read_frame().unwrap() {
            decoded.push(Message::decode(frame).unwrap());
        }
        prop_assert_eq!(decoded, messages);
    }

    /// Arbitrary bytes never panic the reader or decoder: every outcome is a
    /// frame, a clean end, or a typed error.
    #[test]
    fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let mut reader = FrameReader::new(Cursor::new(bytes));
        while let Ok(Some(frame)) = reader.read_frame() {
            let _ = Message::decode(frame);
        }
    }

    /// Arbitrary payloads under every known kind never panic the decoder.
    #[test]
    fn arbitrary_payloads_never_panic(
        kind in proptest::sample::select(FrameKind::ALL),
        payload in proptest::collection::vec(any::<u8>(), 0..512),
    ) {
        let _ = Message::decode(RawFrame { kind: kind as u8, payload });
    }
}
