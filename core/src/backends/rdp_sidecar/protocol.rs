//! The IPC protocol spoken between the desktop and the RDP sidecar
//! (`termihub-rdp-helper`).
//!
//! The sidecar is a **separately-built** binary that links IronRDP (see #1747):
//! IronRDP's CredSSP crypto (`picky`/`sspi`) and `russh` pin mutually
//! incompatible RustCrypto pre-releases, and Cargo allows one version per crate
//! per lockfile, so the RDP decoder cannot live in the same build unit as the
//! SSH backend. The sidecar is a workspace-**excluded** crate with its own
//! `Cargo.lock`; the desktop spawns it per session and bridges it into the
//! shared #1680 remote-desktop layer over this protocol.
//!
//! ## Why the types are (almost) free
//!
//! Every payload the shared [`GraphicalBackend`](crate::connection::GraphicalBackend)
//! trait uses — [`FrameUpdate`](crate::connection::FrameUpdate),
//! [`CursorUpdate`](crate::connection::CursorUpdate),
//! [`InputEvent`](crate::connection::InputEvent),
//! [`GraphicalState`](crate::connection::GraphicalState) — is already
//! `Serialize`/`Deserialize`, as is [`RdpConfig`](super::config::RdpConfig). The
//! two message enums below just wrap them, so both ends share one definition and
//! the wire format cannot drift.
//!
//! ## Wire format
//!
//! Length-prefixed frames: a little-endian `u32` byte length followed by that
//! many bytes of **MessagePack** ([`rmp_serde`]).
//!
//! MessagePack, not `bincode`: [`InputEvent`](crate::connection::InputEvent) is
//! an internally-tagged enum (`#[serde(tag = "kind")]`), which `bincode` cannot
//! deserialize — a non-self-describing format has no `deserialize_any`.
//! MessagePack is compact binary (frame `Vec<u8>` stays packed, unlike JSON's
//! number-array blow-up) *and* self-describing, so it round-trips the tagged
//! enum. (Deviation from the #1747 sketch, which proposed `bincode`; flagged in
//! the PR.)
//!
//! Transport is the child's **stdio** (host→sidecar over its stdin, sidecar→host
//! over its stdout); stderr carries the sidecar's logs. Credentials travel
//! **inside** [`HostMessage::Connect`] over stdin — never via argv or the
//! environment, where other local processes could read them.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::connection::{
    CursorUpdate, FrameUpdate, GraphicalState, InputEvent, RemoteClipboardFile,
};

use super::config::RdpConfig;

/// Hard cap on a single framed message, guarding against a corrupt or hostile
/// length prefix. A 4K-ish full-frame RGBA update is ~34 MiB; 128 MiB leaves
/// generous headroom while still refusing an absurd allocation.
pub const MAX_MESSAGE_BYTES: u32 = 128 * 1024 * 1024;

/// A message from the desktop **to** the sidecar (written to the sidecar's stdin).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum HostMessage {
    /// Open the session. Carries the full connection config **including
    /// credentials** — this is why the transport is stdin, not argv/env.
    /// Always the first message; the sidecar ignores later `Connect`s.
    Connect(Box<RdpConfig>),
    /// A protocol-agnostic input event to forward to the remote.
    Input(InputEvent),
    /// Request a new session resolution in pixels. The sidecar renegotiates the
    /// remote resolution over the Display Control channel (#1755).
    Resize {
        /// Requested width in pixels.
        width: u16,
        /// Requested height in pixels.
        height: u16,
    },
    /// Push local clipboard text to the remote over the sidecar's CLIPRDR
    /// channel (#1756).
    SetClipboard(String),
    /// Fetch the bytes of one remote-copied clipboard file on demand — the paste
    /// gesture of the remote→host **delayed-rendering** path (#1793). `index` is
    /// the [`RemoteClipboardFile::index`] the sidecar surfaced via
    /// [`SidecarMessage::RemoteClipboardFiles`]; `request_id` correlates the
    /// streamed [`SidecarMessage::ClipboardFileChunk`] responses (or a
    /// [`SidecarMessage::ClipboardFileError`]) back to this request. The sidecar
    /// re-drives a chunked CLIPRDR `FileContentsRequest`, so the bytes are never
    /// buffered whole.
    FetchClipboardFile {
        /// Correlates the streamed chunk responses to this request.
        request_id: u64,
        /// Advertised index of the file to fetch (a surfaced `RemoteClipboardFile`).
        index: u32,
    },
    /// The host's verdict on a [`SidecarMessage::CertPrompt`] (#1767): whether to
    /// proceed with the untrusted server certificate. `remember` is consumed on
    /// the host side (it owns the persisted trust store); the sidecar only acts
    /// on `accept` — proceeding with the connection or aborting it.
    CertDecision {
        /// Proceed with the connection when `true`; abort it when `false`.
        accept: bool,
        /// Whether the host persisted the fingerprint for this host. Informational
        /// to the sidecar, which does not persist anything itself.
        remember: bool,
    },
    /// Ask the sidecar to tear the session down and exit.
    Disconnect,
}

/// A message from the sidecar **to** the desktop (written to the sidecar's stdout).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SidecarMessage {
    /// A lifecycle transition (connecting → authenticating → active → …). The
    /// desktop mirrors it onto the shared session state where relevant.
    State(GraphicalState),
    /// A decoded framebuffer update to blit onto the shared canvas.
    Frame(FrameUpdate),
    /// A cursor position / shape update.
    Cursor(CursorUpdate),
    /// Remote clipboard text, decoded from the sidecar's CLIPRDR channel (#1756).
    Clipboard(String),
    /// The remote copied files to its clipboard; this surfaces the sanitized file
    /// **list** (names, sizes, indices) to the host so it can offer them for a
    /// local paste without fetching any bytes yet — the remote→host
    /// **delayed-rendering** path (#1793). The host pulls a file's bytes only on a
    /// real paste via [`HostMessage::FetchClipboardFile`]. Only emitted when
    /// clipboard file transfer is opted in and the host advertised delayed-render
    /// support; otherwise the sidecar keeps eagerly downloading into the shared
    /// folder (#1765).
    RemoteClipboardFiles(Vec<RemoteClipboardFile>),
    /// One streamed chunk of a remote-clipboard file the host requested via
    /// [`HostMessage::FetchClipboardFile`] (#1793). Chunks arrive in order at
    /// increasing `position`; `last` marks the final chunk (a zero-length `data`
    /// with `last` set denotes an empty file). Each chunk is at most the CLIPRDR
    /// streaming chunk size (8 MiB), so neither end buffers the whole file.
    ClipboardFileChunk {
        /// The [`HostMessage::FetchClipboardFile::request_id`] this chunk answers.
        request_id: u64,
        /// Byte offset of this chunk within the file.
        position: u64,
        /// The chunk's bytes (empty only for an empty final chunk).
        data: Vec<u8>,
        /// Whether this is the final chunk of the file.
        last: bool,
    },
    /// A remote-clipboard file fetch failed (unknown/withdrawn index, a directory
    /// index, or a CLIPRDR read error) — terminates the
    /// [`HostMessage::FetchClipboardFile`] identified by `request_id` (#1793).
    ClipboardFileError {
        /// The [`HostMessage::FetchClipboardFile::request_id`] that failed.
        request_id: u64,
        /// Human-readable reason, for logs.
        message: String,
    },
    /// The server presented an untrusted certificate and the sidecar needs an
    /// interactive trust decision (#1767). The sidecar blocks the connect until
    /// the host replies with [`HostMessage::CertDecision`] (or a timeout aborts
    /// it). `subject`/`issuer` are best-effort context for the prompt; the
    /// `fingerprint` (SHA-256 of the server public key) is the identity the host
    /// keys its trust store on.
    CertPrompt {
        /// SHA-256 fingerprint of the server public key (`sha256:AB:CD:…`).
        fingerprint: String,
        /// Certificate subject, when available.
        subject: Option<String>,
        /// Certificate issuer, when available.
        issuer: Option<String>,
    },
    /// A fatal error; the sidecar exits after sending it.
    Error(String),
}

/// Serialize `msg` and write it as one length-prefixed MessagePack frame.
///
/// Flushes so the peer sees the frame promptly — the interactive session would
/// stall otherwise.
pub async fn write_message<W, T>(writer: &mut W, msg: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = rmp_serde::to_vec_named(msg).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("encode failed: {e}"),
        )
    })?;
    let len = u32::try_from(body.len()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message exceeds u32 length",
        )
    })?;
    if len > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message exceeds MAX_MESSAGE_BYTES",
        ));
    }
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

/// Read one length-prefixed MessagePack frame and deserialize it into `T`.
///
/// Returns an [`UnexpectedEof`](std::io::ErrorKind::UnexpectedEof) error when the
/// peer closes the pipe — the caller treats that as "session ended". A length
/// prefix over [`MAX_MESSAGE_BYTES`] is rejected before any allocation.
pub async fn read_message<R, T>(reader: &mut R) -> std::io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("framed message length {len} exceeds MAX_MESSAGE_BYTES"),
        ));
    }
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body).await?;
    rmp_serde::from_slice(&body).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("decode failed: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{CursorShape, DirtyRect};

    /// Round-trip any message pair through the framed reader/writer over an
    /// in-memory duplex pipe — the loopback that stands in for the real stdio
    /// boundary in unit tests.
    async fn round_trip_host(msg: HostMessage) -> HostMessage {
        let (mut a, mut b) = tokio::io::duplex(1024 * 1024);
        write_message(&mut a, &msg).await.unwrap();
        drop(a);
        read_message::<_, HostMessage>(&mut b).await.unwrap()
    }

    async fn round_trip_sidecar(msg: SidecarMessage) -> SidecarMessage {
        let (mut a, mut b) = tokio::io::duplex(1024 * 1024);
        write_message(&mut a, &msg).await.unwrap();
        drop(a);
        read_message::<_, SidecarMessage>(&mut b).await.unwrap()
    }

    #[tokio::test]
    async fn connect_round_trips_with_credentials() {
        let cfg = RdpConfig {
            host: "host.example".to_string(),
            username: "admin".to_string(),
            password: "hunter2".to_string(),
            domain: "CORP".to_string(),
            security_mode: "nla".to_string(),
            ..Default::default()
        };
        let out = round_trip_host(HostMessage::Connect(Box::new(cfg))).await;
        match out {
            HostMessage::Connect(cfg) => {
                assert_eq!(cfg.host, "host.example");
                assert_eq!(cfg.password, "hunter2");
                assert_eq!(cfg.domain, "CORP");
            }
            other => panic!("expected Connect, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn input_event_internally_tagged_enum_round_trips() {
        // This is the case that rules out bincode: InputEvent is
        // `#[serde(tag = "kind")]`, so the codec must be self-describing.
        for ev in [
            InputEvent::Key {
                code: "Enter".to_string(),
                pressed: true,
            },
            InputEvent::Pointer {
                x: 10,
                y: 20,
                buttons: 0b101,
            },
            InputEvent::Wheel {
                x: 1,
                y: 2,
                delta_x: 0.0,
                delta_y: -3.5,
            },
        ] {
            let out = round_trip_host(HostMessage::Input(ev.clone())).await;
            assert_eq!(out, HostMessage::Input(ev));
        }
    }

    #[tokio::test]
    async fn frame_update_round_trips_pixels_intact() {
        let frame = FrameUpdate {
            width: 2,
            height: 1,
            rects: vec![DirtyRect {
                x: 0,
                y: 0,
                width: 2,
                height: 1,
                data: vec![1, 2, 3, 4, 5, 6, 7, 8],
            }],
        };
        let out = round_trip_sidecar(SidecarMessage::Frame(frame.clone())).await;
        assert_eq!(out, SidecarMessage::Frame(frame));
    }

    #[tokio::test]
    async fn cursor_and_state_round_trip() {
        let cursor = SidecarMessage::Cursor(CursorUpdate {
            x: 5,
            y: 6,
            visible: true,
            shape: Some(CursorShape {
                width: 1,
                height: 1,
                hotspot_x: 0,
                hotspot_y: 0,
                data: vec![9, 8, 7, 6],
            }),
        });
        assert_eq!(round_trip_sidecar(cursor.clone()).await, cursor);

        let state = SidecarMessage::State(GraphicalState::Active);
        assert_eq!(round_trip_sidecar(state.clone()).await, state);
    }

    #[tokio::test]
    async fn multiple_frames_stream_over_one_pipe() {
        // The framing must delimit back-to-back messages on a single stream.
        let (mut w, mut r) = tokio::io::duplex(1024 * 1024);
        let msgs = vec![
            SidecarMessage::State(GraphicalState::Connecting),
            SidecarMessage::State(GraphicalState::Active),
            SidecarMessage::Error("boom".to_string()),
        ];
        for m in &msgs {
            write_message(&mut w, m).await.unwrap();
        }
        drop(w);
        for expected in &msgs {
            let got = read_message::<_, SidecarMessage>(&mut r).await.unwrap();
            assert_eq!(&got, expected);
        }
        // Pipe drained → EOF.
        let eof = read_message::<_, SidecarMessage>(&mut r).await;
        assert_eq!(eof.unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn cert_prompt_and_decision_round_trip() {
        // The interactive cert-trust handshake (#1767) must survive the framed
        // codec in both directions.
        let prompt = SidecarMessage::CertPrompt {
            fingerprint: "sha256:AB:CD:EF".to_string(),
            subject: Some("CN=host.example".to_string()),
            issuer: None,
        };
        assert_eq!(round_trip_sidecar(prompt.clone()).await, prompt);

        for decision in [
            HostMessage::CertDecision {
                accept: true,
                remember: true,
            },
            HostMessage::CertDecision {
                accept: false,
                remember: false,
            },
        ] {
            assert_eq!(round_trip_host(decision.clone()).await, decision);
        }
    }

    #[tokio::test]
    async fn remote_clipboard_files_round_trip() {
        // The surfaced remote-copied file list (#1793) must survive the framed
        // codec, including a nested relative path and an unknown-size entry.
        let msg = SidecarMessage::RemoteClipboardFiles(vec![
            RemoteClipboardFile {
                name: "report.pdf".to_string(),
                relative_path: None,
                size: Some(1234),
                is_dir: false,
                index: 0,
            },
            RemoteClipboardFile {
                name: "nested.txt".to_string(),
                relative_path: Some("dir/sub".to_string()),
                size: None,
                is_dir: false,
                index: 2,
            },
        ]);
        assert_eq!(round_trip_sidecar(msg.clone()).await, msg);
    }

    #[tokio::test]
    async fn fetch_clipboard_file_and_chunk_round_trip() {
        let fetch = HostMessage::FetchClipboardFile {
            request_id: 7,
            index: 3,
        };
        assert_eq!(round_trip_host(fetch.clone()).await, fetch);

        let chunk = SidecarMessage::ClipboardFileChunk {
            request_id: 7,
            position: 8,
            data: vec![9, 8, 7, 6, 5],
            last: true,
        };
        assert_eq!(round_trip_sidecar(chunk.clone()).await, chunk);

        let err = SidecarMessage::ClipboardFileError {
            request_id: 7,
            message: "unknown index".to_string(),
        };
        assert_eq!(round_trip_sidecar(err.clone()).await, err);
    }

    #[tokio::test]
    async fn oversized_length_prefix_is_rejected_without_allocating() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&(MAX_MESSAGE_BYTES + 1).to_le_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_message::<_, SidecarMessage>(&mut cursor)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
