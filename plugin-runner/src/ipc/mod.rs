//! The host ↔ `termihub-plugin-runner` IPC protocol (#4182).
//!
//! One duplex byte stream per runner (an inherited `socketpair` end on Unix),
//! carrying length-delimited frames (see [`codec`]): `[u32 BE length][u8
//! kind][payload]`, max 1 MiB.
//!
//! * The **hot path** — [`FrameKind::Input`] / [`FrameKind::Output`] — carries a
//!   `u32` BE session id followed by the raw terminal bytes, with no
//!   serialisation.
//! * Every **control** kind carries a MessagePack (`rmp-serde`) payload from
//!   [`messages`]; kinds without data ([`FrameKind::Shutdown`]) carry none.
//!
//! The host treats the runner as an **untrusted peer**: [`Message::decode`]
//! rejects an unknown kind, an oversized or truncated frame and a malformed
//! payload, and [`FrameKind::sender`] lets each side refuse kinds only the
//! other side may send.

pub mod codec;
pub mod messages;

use serde::de::DeserializeOwned;
use serde::Serialize;

pub use codec::{
    encode_frame, write_encoded, FrameReader, RawFrame, LENGTH_PREFIX_LEN, MAX_FRAME_LEN,
    MAX_PAYLOAD_LEN,
};
pub use messages::{
    Alive, Cancel, Configure, CreateSession, Heartbeat, Hello, LoadFailed, Loaded, Log, Resize,
    SandboxReport, SessionError, SessionFailed, SessionRef, WireError, WireToolchain,
};

/// The protocol version. The runner announces it in [`Hello`]; the host refuses
/// a runner speaking any other version (the two ship together, so a mismatch
/// means a broken or foreign install).
pub const PROTOCOL_VERSION: u32 = 1;

/// The command-line flag the host passes the runner's protocol version with:
/// `termihub-plugin-runner --protocol <n>`.
pub const PROTOCOL_ARG: &str = "--protocol";

/// The descriptor the runner's end of the channel is inherited as on Unix.
pub const IPC_FD: i32 = 3;

/// Bytes of the session id prefixing an `Input` / `Output` payload.
pub const SESSION_ID_LEN: usize = 4;

/// Which side may send a frame kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    /// Only the host sends it.
    Host,
    /// Only the runner sends it.
    Runner,
}

macro_rules! frame_kinds {
    ($( $(#[$doc:meta])* $name:ident = $value:literal, $sender:ident; )*) => {
        /// Every frame kind. The byte values are part of the protocol.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[repr(u8)]
        pub enum FrameKind {
            $( $(#[$doc])* $name = $value, )*
        }

        impl FrameKind {
            /// Every kind, for exhaustive tests.
            pub const ALL: &'static [FrameKind] = &[$(FrameKind::$name),*];

            /// Decode a kind byte; `None` for an unknown kind (a violation).
            #[must_use]
            pub const fn from_u8(value: u8) -> Option<Self> {
                match value {
                    $( $value => Some(FrameKind::$name), )*
                    _ => None,
                }
            }

            /// Which side may send this kind.
            #[must_use]
            pub const fn sender(self) -> Sender {
                match self {
                    $( FrameKind::$name => Sender::$sender, )*
                }
            }
        }
    };
}

frame_kinds! {
    /// Runner → host: [`Hello`], the first frame.
    Hello = 0x01, Runner;
    /// Host → runner: [`Configure`].
    Configure = 0x02, Host;
    /// Runner → host: [`SandboxReport`], before any plugin code runs.
    SandboxReport = 0x03, Runner;
    /// Runner → host: [`Loaded`].
    Loaded = 0x04, Runner;
    /// Runner → host: [`LoadFailed`]; the runner exits afterwards.
    LoadFailed = 0x05, Runner;
    /// Host → runner: [`CreateSession`].
    CreateSession = 0x10, Host;
    /// Runner → host: [`SessionRef`] — the session is live.
    SessionCreated = 0x11, Runner;
    /// Runner → host: [`SessionFailed`].
    SessionFailed = 0x12, Runner;
    /// Host → runner: `u32` session id + raw input bytes.
    Input = 0x13, Host;
    /// Runner → host: `u32` session id + raw output bytes.
    Output = 0x14, Runner;
    /// Host → runner: [`Resize`].
    Resize = 0x15, Host;
    /// Host → runner: [`SessionRef`] — close and destroy the session.
    Close = 0x16, Host;
    /// Runner → host: [`SessionRef`] — the session is closed and destroyed.
    Closed = 0x17, Runner;
    /// Host → runner: [`Cancel`].
    Cancel = 0x18, Host;
    /// Runner → host: [`SessionError`] for a queued operation.
    SessionError = 0x19, Runner;
    /// Runner → host: [`Alive`], pushed when a session's liveness changes.
    Alive = 0x1A, Runner;
    /// Runner → host: [`Log`].
    Log = 0x20, Runner;
    /// Host → runner: [`Heartbeat`].
    Ping = 0x21, Host;
    /// Runner → host: [`Heartbeat`], echoing a `Ping`.
    Pong = 0x22, Runner;
    /// Host → runner: no payload — run `plugin_shutdown` and exit.
    Shutdown = 0x23, Host;
}

/// A decoded frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// See [`FrameKind::Hello`].
    Hello(Hello),
    /// See [`FrameKind::Configure`].
    Configure(Configure),
    /// See [`FrameKind::SandboxReport`].
    SandboxReport(SandboxReport),
    /// See [`FrameKind::Loaded`].
    Loaded(Loaded),
    /// See [`FrameKind::LoadFailed`].
    LoadFailed(LoadFailed),
    /// See [`FrameKind::CreateSession`].
    CreateSession(CreateSession),
    /// See [`FrameKind::SessionCreated`].
    SessionCreated(SessionRef),
    /// See [`FrameKind::SessionFailed`].
    SessionFailed(SessionFailed),
    /// See [`FrameKind::Input`].
    Input {
        /// The session.
        session_id: u32,
        /// Raw bytes.
        data: Vec<u8>,
    },
    /// See [`FrameKind::Output`].
    Output {
        /// The session.
        session_id: u32,
        /// Raw bytes.
        data: Vec<u8>,
    },
    /// See [`FrameKind::Resize`].
    Resize(Resize),
    /// See [`FrameKind::Close`].
    Close(SessionRef),
    /// See [`FrameKind::Closed`].
    Closed(SessionRef),
    /// See [`FrameKind::Cancel`].
    Cancel(Cancel),
    /// See [`FrameKind::SessionError`].
    SessionError(SessionError),
    /// See [`FrameKind::Alive`].
    Alive(Alive),
    /// See [`FrameKind::Log`].
    Log(Log),
    /// See [`FrameKind::Ping`].
    Ping(Heartbeat),
    /// See [`FrameKind::Pong`].
    Pong(Heartbeat),
    /// See [`FrameKind::Shutdown`].
    Shutdown,
}

/// A protocol violation or transport failure.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// The transport failed.
    #[error("plugin IPC transport error: {0}")]
    Io(#[from] std::io::Error),
    /// A frame announced a length over [`MAX_FRAME_LEN`].
    #[error("plugin IPC frame of {0} bytes exceeds the 1 MiB limit")]
    FrameTooLarge(usize),
    /// A frame announced length 0 (no kind byte).
    #[error("plugin IPC frame is empty")]
    EmptyFrame,
    /// The stream ended inside a frame.
    #[error("plugin IPC stream ended inside a frame")]
    Truncated,
    /// The kind byte is not a known [`FrameKind`].
    #[error("unknown plugin IPC frame kind {0:#04x}")]
    UnknownKind(u8),
    /// The kind is known but its payload does not decode.
    #[error("malformed plugin IPC {kind:?} frame: {detail}")]
    Malformed {
        /// The frame kind.
        kind: FrameKind,
        /// What was wrong.
        detail: String,
    },
    /// The peer sent a kind only this side may send.
    #[error("plugin IPC {0:?} frame sent in the wrong direction")]
    WrongDirection(FrameKind),
}

impl Message {
    /// This message's frame kind.
    #[must_use]
    pub fn kind(&self) -> FrameKind {
        match self {
            Message::Hello(_) => FrameKind::Hello,
            Message::Configure(_) => FrameKind::Configure,
            Message::SandboxReport(_) => FrameKind::SandboxReport,
            Message::Loaded(_) => FrameKind::Loaded,
            Message::LoadFailed(_) => FrameKind::LoadFailed,
            Message::CreateSession(_) => FrameKind::CreateSession,
            Message::SessionCreated(_) => FrameKind::SessionCreated,
            Message::SessionFailed(_) => FrameKind::SessionFailed,
            Message::Input { .. } => FrameKind::Input,
            Message::Output { .. } => FrameKind::Output,
            Message::Resize(_) => FrameKind::Resize,
            Message::Close(_) => FrameKind::Close,
            Message::Closed(_) => FrameKind::Closed,
            Message::Cancel(_) => FrameKind::Cancel,
            Message::SessionError(_) => FrameKind::SessionError,
            Message::Alive(_) => FrameKind::Alive,
            Message::Log(_) => FrameKind::Log,
            Message::Ping(_) => FrameKind::Ping,
            Message::Pong(_) => FrameKind::Pong,
            Message::Shutdown => FrameKind::Shutdown,
        }
    }

    /// Encode as one complete frame (length prefix included), ready for a
    /// single write.
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let kind = self.kind();
        match self {
            Message::Input { session_id, data } | Message::Output { session_id, data } => {
                encode_data_frame(kind, *session_id, data)
            }
            Message::Shutdown => encode_frame(kind as u8, &[]),
            Message::Hello(m) => encode_control(kind, m),
            Message::Configure(m) => encode_control(kind, m),
            Message::SandboxReport(m) => encode_control(kind, m),
            Message::Loaded(m) => encode_control(kind, m),
            Message::LoadFailed(m) => encode_control(kind, m),
            Message::CreateSession(m) => encode_control(kind, m),
            Message::SessionCreated(m) | Message::Close(m) | Message::Closed(m) => {
                encode_control(kind, m)
            }
            Message::SessionFailed(m) => encode_control(kind, m),
            Message::Resize(m) => encode_control(kind, m),
            Message::Cancel(m) => encode_control(kind, m),
            Message::SessionError(m) => encode_control(kind, m),
            Message::Alive(m) => encode_control(kind, m),
            Message::Log(m) => encode_control(kind, m),
            Message::Ping(m) | Message::Pong(m) => encode_control(kind, m),
        }
    }

    /// Decode a raw frame. Every failure is a protocol violation.
    pub fn decode(frame: RawFrame) -> Result<Self, ProtocolError> {
        let kind = FrameKind::from_u8(frame.kind).ok_or(ProtocolError::UnknownKind(frame.kind))?;
        let payload = frame.payload;
        Ok(match kind {
            FrameKind::Input => {
                let (session_id, data) = split_data(kind, payload)?;
                Message::Input { session_id, data }
            }
            FrameKind::Output => {
                let (session_id, data) = split_data(kind, payload)?;
                Message::Output { session_id, data }
            }
            FrameKind::Shutdown => {
                if !payload.is_empty() {
                    return Err(malformed(kind, "unexpected payload"));
                }
                Message::Shutdown
            }
            FrameKind::Hello => Message::Hello(decode_control(kind, &payload)?),
            FrameKind::Configure => Message::Configure(decode_control(kind, &payload)?),
            FrameKind::SandboxReport => Message::SandboxReport(decode_control(kind, &payload)?),
            FrameKind::Loaded => Message::Loaded(decode_control(kind, &payload)?),
            FrameKind::LoadFailed => Message::LoadFailed(decode_control(kind, &payload)?),
            FrameKind::CreateSession => Message::CreateSession(decode_control(kind, &payload)?),
            FrameKind::SessionCreated => Message::SessionCreated(decode_control(kind, &payload)?),
            FrameKind::SessionFailed => Message::SessionFailed(decode_control(kind, &payload)?),
            FrameKind::Resize => Message::Resize(decode_control(kind, &payload)?),
            FrameKind::Close => Message::Close(decode_control(kind, &payload)?),
            FrameKind::Closed => Message::Closed(decode_control(kind, &payload)?),
            FrameKind::Cancel => Message::Cancel(decode_control(kind, &payload)?),
            FrameKind::SessionError => Message::SessionError(decode_control(kind, &payload)?),
            FrameKind::Alive => Message::Alive(decode_control(kind, &payload)?),
            FrameKind::Log => Message::Log(decode_control(kind, &payload)?),
            FrameKind::Ping => Message::Ping(decode_control(kind, &payload)?),
            FrameKind::Pong => Message::Pong(decode_control(kind, &payload)?),
        })
    }

    /// [`decode`](Self::decode), additionally refusing a kind that only the
    /// receiving side (`me`) may send.
    pub fn decode_from_peer(frame: RawFrame, me: Sender) -> Result<Self, ProtocolError> {
        let message = Self::decode(frame)?;
        if message.kind().sender() == me {
            return Err(ProtocolError::WrongDirection(message.kind()));
        }
        Ok(message)
    }
}

/// Encode an `Input` / `Output` frame without an intermediate copy of `data`
/// into a [`Message`] — the hot path.
pub fn encode_data_frame(
    kind: FrameKind,
    session_id: u32,
    data: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    encode_frame(kind as u8, &[&session_id.to_be_bytes(), data])
}

fn encode_control<T: Serialize>(kind: FrameKind, value: &T) -> Result<Vec<u8>, ProtocolError> {
    let payload = rmp_serde::to_vec_named(value).map_err(|e| malformed(kind, e))?;
    encode_frame(kind as u8, &[&payload])
}

fn decode_control<T: DeserializeOwned>(
    kind: FrameKind,
    payload: &[u8],
) -> Result<T, ProtocolError> {
    let mut de = rmp_serde::Deserializer::new(payload);
    let value = T::deserialize(&mut de).map_err(|e| malformed(kind, e))?;
    // Trailing bytes after the value are a malformed frame, not slack.
    if !de.get_ref().is_empty() {
        return Err(malformed(kind, "trailing bytes after the payload"));
    }
    Ok(value)
}

fn split_data(kind: FrameKind, mut payload: Vec<u8>) -> Result<(u32, Vec<u8>), ProtocolError> {
    if payload.len() < SESSION_ID_LEN {
        return Err(malformed(kind, "missing session id"));
    }
    let mut id = [0u8; SESSION_ID_LEN];
    id.copy_from_slice(&payload[..SESSION_ID_LEN]);
    payload.drain(..SESSION_ID_LEN);
    Ok((u32::from_be_bytes(id), payload))
}

fn malformed(kind: FrameKind, detail: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::Malformed {
        kind,
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod tests;
