//! Shared helpers for the plugin IPC fuzz targets (#4190, plugin OS-sandbox
//! phase 8).
//!
//! * [`decode_stream`] — feed raw bytes to a [`FrameReader`] and decode every
//!   frame as one side of the channel would (`host_decode`, `runner_decode`).
//! * [`round_trip`] — build well-formed messages from the input, encode them,
//!   read them back through arbitrarily short reads and require the same
//!   messages (`frame_roundtrip`).
//! * [`arb_message`] — the structured generator behind `round_trip` and the
//!   `gen-seeds` corpus writer.

use std::io::{self, Read};

use arbitrary::{Arbitrary, Result, Unstructured};
use termihub_plugin_runner::ipc::{
    Alive, BridgeOp, BridgeReply, BridgeRequest, BridgeResult, Cancel, Configure, ConnRef,
    CreateSession, FrameKind, FrameReader, Heartbeat, Hello, LoadFailed, Loaded, Log, Message,
    ProtocolError, Resize, ResourceLimits, SandboxReport, Sender, SessionError, SessionFailed,
    SessionRef, StreamAck, StreamChunk, StreamTransport, SyscallDenial, WireError, WireToolchain,
};

/// Read and decode every frame in `data` as the side `me` (the receiver).
///
/// The stream stops at the first error, as both peers do (a violation kills
/// the channel). Every frame that decodes must survive a re-encode and decode
/// unchanged; anything else is a bug the fuzzer reports as a crash.
pub fn decode_stream(data: &[u8], me: Sender) {
    let mut frames = FrameReader::new(data);
    loop {
        match frames.read_frame() {
            Ok(Some(frame)) => match Message::decode_from_peer(frame, me) {
                Ok(message) => assert_reencodes(&message, me),
                Err(_) => return,
            },
            Ok(None) | Err(_) => return,
        }
    }
}

/// A decoded message re-encodes and decodes to itself.
fn assert_reencodes(message: &Message, me: Sender) {
    let encoded = match message.encode() {
        Ok(encoded) => encoded,
        // A control payload sent in MessagePack's compact array form re-encodes
        // with field names and may then exceed the 1 MiB frame cap. That is a
        // refusal, not a corruption.
        Err(ProtocolError::FrameTooLarge(_)) => return,
        Err(err) => panic!(
            "a decoded {:?} frame does not re-encode: {err}",
            message.kind()
        ),
    };
    let mut frames = FrameReader::new(encoded.as_slice());
    let frame = frames
        .read_frame()
        .expect("a re-encoded frame reads back")
        .expect("a re-encoded frame is not empty");
    let again = Message::decode_from_peer(frame, me).expect("a re-encoded frame decodes");
    assert_eq!(
        &again, message,
        "decode -> encode -> decode changed the message"
    );
    assert!(
        matches!(frames.read_frame(), Ok(None)),
        "a re-encoded message is exactly one frame"
    );
}

/// Encode well-formed messages built from `data`, read them back through a
/// reader that returns arbitrarily short reads, and require the same messages
/// in the same order.
pub fn round_trip(data: &[u8]) {
    let mut u = Unstructured::new(data);
    let Ok(messages) = arb_messages(&mut u) else {
        return;
    };
    let mut wire = Vec::new();
    let mut sent = Vec::new();
    for message in messages {
        match message.encode() {
            Ok(frame) => {
                wire.extend_from_slice(&frame);
                sent.push(message);
            }
            Err(ProtocolError::FrameTooLarge(_)) => {}
            Err(err) => panic!("a well-formed {:?} does not encode: {err}", message.kind()),
        }
    }
    let chunks = chunk_plan(&mut u);
    let mut frames = FrameReader::new(ChunkedReader::new(&wire, chunks));
    for expected in &sent {
        let frame = frames
            .read_frame()
            .expect("a well-formed stream reads")
            .expect("a frame per sent message");
        let me = receiver_of(expected.kind());
        let got = Message::decode_from_peer(frame, me).expect("a well-formed frame decodes");
        assert_eq!(&got, expected);
    }
    assert!(
        matches!(frames.read_frame(), Ok(None)),
        "nothing after the last frame"
    );
}

/// The side that receives a kind: the one that does not send it.
#[must_use]
pub fn receiver_of(kind: FrameKind) -> Sender {
    match kind.sender() {
        Sender::Host => Sender::Runner,
        Sender::Runner => Sender::Host,
    }
}

fn arb_messages(u: &mut Unstructured<'_>) -> Result<Vec<Message>> {
    let count = u.int_in_range(0..=8u8)?;
    (0..count).map(|_| arb_message(u)).collect()
}

/// Up to 32 read sizes (each `1..=64` bytes, `0` meaning "interrupted"); the
/// reader cycles through them.
fn chunk_plan(u: &mut Unstructured<'_>) -> Vec<usize> {
    let mut plan = Vec::new();
    while plan.len() < 32 {
        match u.int_in_range(0..=64u8) {
            Ok(n) => plan.push(usize::from(n)),
            Err(_) => break,
        }
    }
    plan
}

/// A reader that hands out the stream in the sizes of a plan, and reports
/// `Interrupted` for a planned `0`, so the frame reader's partial-read and
/// retry paths run.
struct ChunkedReader<'a> {
    data: &'a [u8],
    plan: Vec<usize>,
    step: usize,
    interrupted: bool,
}

impl<'a> ChunkedReader<'a> {
    fn new(data: &'a [u8], plan: Vec<usize>) -> Self {
        Self {
            data,
            plan,
            step: 0,
            interrupted: false,
        }
    }
}

impl Read for ChunkedReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.data.is_empty() || buf.is_empty() {
            return Ok(0);
        }
        let planned = match self.plan.get(self.step % self.plan.len().max(1)) {
            None => buf.len(),
            Some(&n) => {
                self.step += 1;
                // Never two interruptions in a row, so even a plan of only
                // zeros makes progress (one byte per retry).
                if n == 0 && !self.interrupted {
                    self.interrupted = true;
                    return Err(io::ErrorKind::Interrupted.into());
                }
                n.max(1)
            }
        };
        self.interrupted = false;
        let n = planned.min(buf.len()).min(self.data.len());
        buf[..n].copy_from_slice(&self.data[..n]);
        self.data = &self.data[n..];
        Ok(n)
    }
}

/// One well-formed message of any kind.
pub fn arb_message(u: &mut Unstructured<'_>) -> Result<Message> {
    let kinds = FrameKind::ALL;
    let kind = kinds[u.choose_index(kinds.len())?];
    message_of_kind(u, kind)
}

/// One well-formed message of `kind`, its fields drawn from `u`.
pub fn message_of_kind(u: &mut Unstructured<'_>, kind: FrameKind) -> Result<Message> {
    Ok(match kind {
        FrameKind::Hello => Message::Hello(Hello {
            runner_version: u.arbitrary()?,
            protocol_version: u.arbitrary()?,
            pid: u.arbitrary()?,
        }),
        FrameKind::Configure => Message::Configure(Configure {
            library_path: u.arbitrary()?,
            expected_digest: u.arbitrary()?,
            manifest_api_version: u.arbitrary()?,
            accept_unverified_toolchain: u.arbitrary()?,
            plugin_id: u.arbitrary()?,
            host_version: u.arbitrary()?,
            limits: ResourceLimits {
                address_space_bytes: u.arbitrary()?,
                max_open_files: u.arbitrary()?,
                forbid_child_processes: u.arbitrary()?,
            },
        }),
        FrameKind::SandboxReport => Message::SandboxReport(SandboxReport {
            enforced: u.arbitrary()?,
            missing: u.arbitrary()?,
        }),
        FrameKind::Loaded => Message::Loaded(Loaded {
            id: u.arbitrary()?,
            name: u.arbitrary()?,
            version: u.arbitrary()?,
            abi_version: u.arbitrary()?,
            toolchain: if u.arbitrary()? {
                Some(WireToolchain {
                    rustc: u.arbitrary()?,
                    panic_strategy: u.arbitrary()?,
                })
            } else {
                None
            },
        }),
        FrameKind::LoadFailed => Message::LoadFailed(LoadFailed {
            incompatible: u.arbitrary()?,
            message: u.arbitrary()?,
        }),
        FrameKind::CreateSession => Message::CreateSession(CreateSession {
            session_id: u.arbitrary()?,
            config_json: u.arbitrary()?,
            settings_json: u.arbitrary()?,
            data_dir: u.arbitrary()?,
            connect_deadline_ms: u.arbitrary()?,
        }),
        FrameKind::SessionCreated => Message::SessionCreated(session_ref(u)?),
        FrameKind::SessionFailed => Message::SessionFailed(SessionFailed {
            session_id: u.arbitrary()?,
            error: wire_error(u)?,
        }),
        FrameKind::Input => Message::Input {
            session_id: u.arbitrary()?,
            data: u.arbitrary()?,
        },
        FrameKind::Output => Message::Output {
            session_id: u.arbitrary()?,
            data: u.arbitrary()?,
        },
        FrameKind::Resize => Message::Resize(Resize {
            session_id: u.arbitrary()?,
            cols: u.arbitrary()?,
            rows: u.arbitrary()?,
        }),
        FrameKind::Close => Message::Close(session_ref(u)?),
        FrameKind::Closed => Message::Closed(session_ref(u)?),
        FrameKind::Cancel => Message::Cancel(Cancel {
            session_id: u.arbitrary()?,
        }),
        FrameKind::SessionError => Message::SessionError(SessionError {
            session_id: u.arbitrary()?,
            operation: u.arbitrary()?,
            error: wire_error(u)?,
        }),
        FrameKind::Alive => Message::Alive(Alive {
            session_id: u.arbitrary()?,
            alive: u.arbitrary()?,
        }),
        FrameKind::Log => Message::Log(Log {
            session_id: u.arbitrary()?,
            level: u.arbitrary()?,
            message: u.arbitrary()?,
            truncated: u.arbitrary()?,
            denied: if u.arbitrary()? {
                Some(SyscallDenial {
                    syscall: u.arbitrary()?,
                    count: u.arbitrary()?,
                })
            } else {
                None
            },
        }),
        FrameKind::Ping => Message::Ping(Heartbeat {
            nonce: u.arbitrary()?,
        }),
        FrameKind::Pong => Message::Pong(Heartbeat {
            nonce: u.arbitrary()?,
        }),
        FrameKind::Shutdown => Message::Shutdown,
        FrameKind::BridgeRequest => Message::BridgeRequest(BridgeRequest {
            request_id: u.arbitrary()?,
            session_id: u.arbitrary()?,
            op: bridge_op(u)?,
        }),
        FrameKind::BridgeReply => Message::BridgeReply(BridgeReply {
            request_id: u.arbitrary()?,
            result: bridge_result(u)?,
        }),
        FrameKind::BridgeRelease => Message::BridgeRelease(conn_ref(u)?),
        FrameKind::StreamData => Message::StreamData(stream_chunk(u)?),
        FrameKind::StreamClosed => Message::StreamClosed(conn_ref(u)?),
        FrameKind::StreamAck => Message::StreamAck(stream_ack(u)?),
        FrameKind::StreamWrite => Message::StreamWrite(stream_chunk(u)?),
        FrameKind::StreamWriteAck => Message::StreamWriteAck(stream_ack(u)?),
    })
}

fn session_ref(u: &mut Unstructured<'_>) -> Result<SessionRef> {
    Ok(SessionRef {
        session_id: u.arbitrary()?,
    })
}

fn conn_ref(u: &mut Unstructured<'_>) -> Result<ConnRef> {
    Ok(ConnRef {
        conn_id: u.arbitrary()?,
    })
}

fn wire_error(u: &mut Unstructured<'_>) -> Result<WireError> {
    Ok(WireError {
        status: u.arbitrary()?,
        message: u.arbitrary()?,
    })
}

fn stream_chunk(u: &mut Unstructured<'_>) -> Result<StreamChunk> {
    Ok(StreamChunk {
        conn_id: u.arbitrary()?,
        data: u.arbitrary()?,
    })
}

fn stream_ack(u: &mut Unstructured<'_>) -> Result<StreamAck> {
    Ok(StreamAck {
        conn_id: u.arbitrary()?,
        bytes: u.arbitrary()?,
        failed: u.arbitrary()?,
    })
}

fn bridge_op(u: &mut Unstructured<'_>) -> Result<BridgeOp> {
    Ok(match u.int_in_range(0..=4u8)? {
        0 => BridgeOp::OpenConnection {
            host: u.arbitrary()?,
            port: u.arbitrary()?,
        },
        1 => BridgeOp::ReadFile {
            path: u.arbitrary()?,
            offset: u.arbitrary()?,
        },
        2 => BridgeOp::WriteFile {
            path: u.arbitrary()?,
            data: u.arbitrary()?,
            mode: u.arbitrary()?,
        },
        3 => BridgeOp::Stat {
            path: u.arbitrary()?,
        },
        _ => BridgeOp::ListDir {
            path: u.arbitrary()?,
            cursor: u.arbitrary()?,
        },
    })
}

fn bridge_result(u: &mut Unstructured<'_>) -> Result<BridgeResult> {
    Ok(match u.int_in_range(0..=5u8)? {
        0 => BridgeResult::Status {
            status: u.arbitrary()?,
        },
        1 => BridgeResult::Connection {
            conn_id: u.arbitrary()?,
            transport: match u.int_in_range(0..=2u8)? {
                0 => StreamTransport::HandlePassed,
                1 => StreamTransport::HandleDuplicated {
                    handle: u.arbitrary()?,
                },
                _ => StreamTransport::Proxy,
            },
        },
        2 => BridgeResult::Data {
            data: u.arbitrary()?,
            eof: u.arbitrary()?,
        },
        3 => BridgeResult::Written,
        4 => BridgeResult::Metadata {
            exists: u.arbitrary()?,
            is_dir: u.arbitrary()?,
            len: u.arbitrary()?,
        },
        _ => BridgeResult::Entries {
            names: u.arbitrary()?,
            next_cursor: u.arbitrary()?,
        },
    })
}
