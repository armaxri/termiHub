//! Length-prefixed binary frame protocol for agent ↔ daemon communication.
//!
//! Frame format: `[type: 1 byte][length: 4 bytes BE][payload: length bytes]`
//!
//! This protocol is intentionally simple and binary to avoid JSON/base64
//! overhead on the local Unix socket path. JSON-RPC encoding only happens
//! at the agent-to-desktop boundary.

use std::io;
#[cfg(test)]
use std::io::{Read, Write};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

// ── Message type constants ──────────────────────────────────────────

/// Agent → Daemon: raw input bytes for the PTY.
pub const MSG_INPUT: u8 = 0x01;
/// Agent → Daemon: resize PTY (payload: cols u16 BE + rows u16 BE).
pub const MSG_RESIZE: u8 = 0x02;
/// Agent → Daemon: detach (empty payload).
pub const MSG_DETACH: u8 = 0x03;
/// Agent → Daemon: kill shell and exit (empty payload).
pub const MSG_KILL: u8 = 0x04;
/// Agent → Daemon: request the current ring buffer contents without reconnecting.
pub const MSG_QUERY_BUFFER: u8 = 0x05;
/// Agent → Daemon: declare how a newly-connecting worker wants to attach
/// (payload: one byte — [`INTENT_TAKEOVER`] or [`INTENT_RECOVERY`]). Sent as the
/// first frame right after connecting.
///
/// `state.json` is shared per-user across every `--stdio` worker (one per
/// attached desktop, ADR-11). Without this hint the daemon evicts its current
/// writer on every `accept`, so a second desktop's worker recovering sessions on
/// startup silently steals the first desktop's live terminals (AGT-015). A
/// worker that is *recovering* declares [`INTENT_RECOVERY`] and the daemon
/// refuses to evict a still-attached live writer; a deliberate re-attach or the
/// fresh spawn declares [`INTENT_TAKEOVER`] and keeps the historical behavior.
///
/// A pre-AGT-015 daemon does not read this frame before its handshake and its
/// command loop ignores the unknown type, so a current worker connecting to an
/// old daemon still works (the guard simply does not apply there).
pub const MSG_ATTACH_INTENT: u8 = 0x06;

/// [`MSG_ATTACH_INTENT`] payload: evict any writer currently attached — the
/// historical accept behavior. Used by the spawn-path connect and explicit
/// re-attach.
pub const INTENT_TAKEOVER: u8 = 0x01;
/// [`MSG_ATTACH_INTENT`] payload: this is a session-recovery connect — the daemon
/// must REFUSE it (rather than evict) if a live writer is still attached, so a
/// second worker never steals a peer's live session (AGT-015).
pub const INTENT_RECOVERY: u8 = 0x00;

/// [`MSG_ERROR`] payload the daemon sends when it refuses an [`INTENT_RECOVERY`]
/// connect because a live writer is already attached (AGT-015). The recovering
/// worker matches this exact marker and leaves the session in the shared state
/// for its live owner instead of tearing it down.
pub const ERR_OWNED_BY_LIVE_PEER: &[u8] = b"AGT-015: session owned by a live connection";

/// Daemon → Agent: output bytes from the PTY.
pub const MSG_OUTPUT: u8 = 0x81;
/// Daemon → Agent: full ring buffer replay on connect.
pub const MSG_BUFFER_REPLAY: u8 = 0x82;
/// Daemon → Agent: shell exited (payload: exit_code i32 BE).
pub const MSG_EXITED: u8 = 0x83;
/// Daemon → Agent: error message (payload: UTF-8 string).
pub const MSG_ERROR: u8 = 0x84;
/// Daemon → Agent: daemon is ready to receive input.
pub const MSG_READY: u8 = 0x85;
/// Daemon → Agent: this connection has been **evicted** — another worker (another
/// desktop) attached with [`INTENT_TAKEOVER`] and now owns the session (SM-003,
/// single-attach). Empty payload. Sent to the incumbent writer immediately before
/// the daemon drops its connection, so the evicted worker can report an explicit
/// "taken over" state to its desktop instead of an ambiguous EOF.
///
/// Append-only and backward compatible: a pre-SM-003 worker logs the unknown frame
/// type and then observes the EOF exactly as before; a pre-SM-003 daemon never
/// sends it, so a current worker falls back to the historical EOF handling.
pub const MSG_EVICTED: u8 = 0x86;

/// Maximum allowed frame payload size (16 MiB).
const MAX_PAYLOAD_SIZE: u32 = 16 * 1024 * 1024;

/// Mid-frame read timeout for the session-daemon steady-state read loops (#3015).
///
/// Bounds only the time to receive the *rest* of a frame once its first byte has
/// arrived (see [`read_frame_async_capped_timeout`]); the wait for a frame's
/// first byte stays **unbounded**, so a legitimately idle-but-alive session — a
/// shell parked at a prompt for hours with no output — is never affected. The
/// value is deliberately generous so a genuinely busy peer streaming a 16 MiB
/// buffer replay is never tripped; only a peer that writes a partial frame and
/// then wedges reaches it, at which point the caller fails the session so the
/// normal reconnect/redrive path takes over.
///
/// This is the contained, protocol-change-free half of #3015 (AGT-023
/// follow-up): it catches the *mid-frame stall* class of wedged-but-connected
/// peer. Detecting a peer that goes fully silent (sends no bytes at all) still
/// requires an application-level heartbeat/ping-pong frame — a protocol change
/// coupled to version negotiation (AGT-010) — which is tracked as a follow-up.
pub const SESSION_MID_FRAME_TIMEOUT: Duration = Duration::from_secs(30);

/// Header size: 1 byte type + 4 bytes length.
const HEADER_SIZE: usize = 5;

// ── Frame struct ────────────────────────────────────────────────────

/// A parsed frame from the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub msg_type: u8,
    pub payload: Vec<u8>,
}

// ── Blocking I/O (used by the daemon process) ───────────────────────

/// Read a single frame from a blocking reader.
///
/// Returns `Ok(None)` on clean EOF (0 bytes read for the header).
#[cfg(test)]
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; HEADER_SIZE];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(ref e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let msg_type = header[0];
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);

    if length > MAX_PAYLOAD_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Frame payload too large: {length} bytes"),
        ));
    }

    let mut payload = vec![0u8; length as usize];
    if length > 0 {
        reader.read_exact(&mut payload)?;
    }

    Ok(Some(Frame { msg_type, payload }))
}

/// Write a single frame to a blocking writer.
#[cfg(test)]
pub fn write_frame(writer: &mut impl Write, msg_type: u8, payload: &[u8]) -> io::Result<()> {
    let length = payload.len() as u32;
    let mut header = [0u8; HEADER_SIZE];
    header[0] = msg_type;
    header[1..5].copy_from_slice(&length.to_be_bytes());

    writer.write_all(&header)?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    writer.flush()?;
    Ok(())
}

// ── Async I/O (used by the daemon process and agent client) ─────────

/// Read a single frame from any async reader.
///
/// Generic over [`AsyncRead`] so the same code drives a Unix domain socket
/// on unix and a Windows named pipe on windows (see [`crate::daemon::transport`]).
///
/// Returns `Ok(None)` on clean EOF. Enforces the session-daemon payload ceiling
/// of [`MAX_PAYLOAD_SIZE`] (16 MiB) — session frames carry PTY buffer replays and
/// are legitimately large.
pub async fn read_frame_async<R>(reader: &mut R) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
{
    read_frame_async_capped(reader, MAX_PAYLOAD_SIZE).await
}

/// [`read_frame_async`] with a caller-supplied maximum payload size.
///
/// The cap is enforced **before** any payload buffer is allocated, so an
/// oversized length prefix costs nothing beyond reading the 5-byte header. This
/// lets a role with small frames (the host-wide registry, whose frames are a
/// handful of small JSON records) declare a far smaller ceiling than the session
/// daemon's 16 MiB, so a peer cannot make it pre-allocate a large buffer per
/// connection (see [`crate::registry_daemon`]).
pub async fn read_frame_async_capped<R>(
    reader: &mut R,
    max_payload: u32,
) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut header = [0u8; HEADER_SIZE];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(ref e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    read_frame_body(reader, header, max_payload).await.map(Some)
}

/// [`read_frame_async_capped`] with a **mid-frame** read timeout.
///
/// The wait for a frame's *first byte* is unbounded: a connected-but-idle peer
/// (a registry worker parked waiting for the next broadcast) legitimately blocks
/// there and must never be reaped. Once the first byte has arrived a frame has
/// begun, and the remaining header + payload bytes must all arrive within
/// `mid_frame_timeout`; a peer that writes a partial header and then stalls (a
/// local slowloris) trips the timeout and the caller drops the connection rather
/// than pinning the reader task forever. A clean EOF between frames still returns
/// `Ok(None)` — an idle disconnect is normal, not a timeout error.
pub async fn read_frame_async_capped_timeout<R>(
    reader: &mut R,
    max_payload: u32,
    mid_frame_timeout: Duration,
) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
{
    // First byte: unbounded — waiting here is a normal idle connection.
    let mut first = [0u8; 1];
    match reader.read_exact(&mut first).await {
        Ok(_) => {}
        Err(ref e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    // A frame has begun: bound the time to receive the rest of it.
    let rest = async {
        let mut header = [0u8; HEADER_SIZE];
        header[0] = first[0];
        reader.read_exact(&mut header[1..]).await?;
        read_frame_body(reader, header, max_payload).await
    };
    match tokio::time::timeout(mid_frame_timeout, rest).await {
        Ok(Ok(frame)) => Ok(Some(frame)),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Timed out mid-frame waiting for the rest of a frame",
        )),
    }
}

/// Read a session-daemon frame with the session payload ceiling and the
/// steady-state [`SESSION_MID_FRAME_TIMEOUT`] (#3015).
///
/// The session-daemon steady-state read loops (the [`crate::daemon::client`]
/// reader and the [`crate::daemon::process`] agent reader) use this instead of
/// the unbounded [`read_frame_async`]: a peer that begins a frame and then
/// wedges no longer parks the reader task forever, while an idle-but-alive peer
/// (no bytes in flight) is untouched because the first-byte wait is unbounded.
pub async fn read_session_frame_timeout<R>(reader: &mut R) -> io::Result<Option<Frame>>
where
    R: AsyncRead + Unpin + ?Sized,
{
    read_frame_async_capped_timeout(reader, MAX_PAYLOAD_SIZE, SESSION_MID_FRAME_TIMEOUT).await
}

/// Validate a frame header against `max_payload` and read its payload.
///
/// Shared by every async read path so the size check always happens **before**
/// allocation. Assumes the full 5-byte `header` has already been read.
async fn read_frame_body<R>(
    reader: &mut R,
    header: [u8; HEADER_SIZE],
    max_payload: u32,
) -> io::Result<Frame>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let msg_type = header[0];
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);

    if length > max_payload {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Frame payload too large: {length} bytes"),
        ));
    }

    let mut payload = vec![0u8; length as usize];
    if length > 0 {
        reader.read_exact(&mut payload).await.map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::UnexpectedEof, "Truncated frame payload")
            } else {
                e
            }
        })?;
    }

    Ok(Frame { msg_type, payload })
}

/// Write a single frame to any async writer.
///
/// Generic over [`AsyncWrite`] so the same code drives a Unix domain socket
/// on unix and a Windows named pipe on windows (see [`crate::daemon::transport`]).
pub async fn write_frame_async<W>(writer: &mut W, msg_type: u8, payload: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let length = payload.len() as u32;
    let mut header = [0u8; HEADER_SIZE];
    header[0] = msg_type;
    header[1..5].copy_from_slice(&length.to_be_bytes());

    writer.write_all(&header).await?;
    if !payload.is_empty() {
        writer.write_all(payload).await?;
    }
    writer.flush().await?;
    Ok(())
}

// ── Helper: encode resize payload ───────────────────────────────────

/// Encode cols and rows into a 4-byte resize payload.
pub fn encode_resize(cols: u16, rows: u16) -> [u8; 4] {
    let mut buf = [0u8; 4];
    buf[0..2].copy_from_slice(&cols.to_be_bytes());
    buf[2..4].copy_from_slice(&rows.to_be_bytes());
    buf
}

/// Decode cols and rows from a 4-byte resize payload.
pub fn decode_resize(payload: &[u8]) -> Option<(u16, u16)> {
    if payload.len() < 4 {
        return None;
    }
    let cols = u16::from_be_bytes([payload[0], payload[1]]);
    let rows = u16::from_be_bytes([payload[2], payload[3]]);
    Some((cols, rows))
}

/// Encode an exit code into a 4-byte payload.
pub fn encode_exit_code(code: i32) -> [u8; 4] {
    code.to_be_bytes()
}

/// Decode an exit code from a 4-byte payload.
pub fn decode_exit_code(payload: &[u8]) -> Option<i32> {
    if payload.len() < 4 {
        return None;
    }
    Some(i32::from_be_bytes([
        payload[0], payload[1], payload[2], payload[3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_empty_payload() {
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_READY, &[]).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_READY);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn round_trip_with_payload() {
        let data = b"hello world";
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_OUTPUT, data).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_OUTPUT);
        assert_eq!(frame.payload, data);
    }

    #[test]
    fn round_trip_input_message() {
        let data = b"ls -la\n";
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_INPUT, data).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_INPUT);
        assert_eq!(frame.payload, data);
    }

    #[test]
    fn round_trip_resize() {
        let payload = encode_resize(120, 40);
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_RESIZE, &payload).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_RESIZE);
        let (cols, rows) = decode_resize(&frame.payload).unwrap();
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn round_trip_exit_code() {
        let payload = encode_exit_code(42);
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_EXITED, &payload).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_EXITED);
        assert_eq!(decode_exit_code(&frame.payload), Some(42));
    }

    #[test]
    fn round_trip_negative_exit_code() {
        let payload = encode_exit_code(-1);
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_EXITED, &payload).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(decode_exit_code(&frame.payload), Some(-1));
    }

    #[test]
    fn round_trip_error_message() {
        let msg = "serial port disconnected";
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_ERROR, msg.as_bytes()).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_ERROR);
        assert_eq!(std::str::from_utf8(&frame.payload).unwrap(), msg);
    }

    #[test]
    fn eof_returns_none() {
        let buf: Vec<u8> = Vec::new();
        let mut cursor = Cursor::new(&buf);
        let result = read_frame(&mut cursor).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn multiple_frames() {
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_READY, &[]).unwrap();
        write_frame(&mut buf, MSG_OUTPUT, b"data1").unwrap();
        write_frame(&mut buf, MSG_OUTPUT, b"data2").unwrap();

        let mut cursor = Cursor::new(&buf);
        let f1 = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(f1.msg_type, MSG_READY);

        let f2 = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(f2.msg_type, MSG_OUTPUT);
        assert_eq!(f2.payload, b"data1");

        let f3 = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(f3.msg_type, MSG_OUTPUT);
        assert_eq!(f3.payload, b"data2");

        let f4 = read_frame(&mut cursor).unwrap();
        assert!(f4.is_none());
    }

    #[test]
    fn large_payload() {
        let data = vec![0xAB; 100_000];
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_BUFFER_REPLAY, &data).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_BUFFER_REPLAY);
        assert_eq!(frame.payload.len(), 100_000);
        assert!(frame.payload.iter().all(|&b| b == 0xAB));
    }

    #[test]
    fn round_trip_query_buffer() {
        // MSG_QUERY_BUFFER is an Agent→Daemon message with an empty payload.
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_QUERY_BUFFER, &[]).unwrap();

        let mut cursor = Cursor::new(&buf);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_QUERY_BUFFER);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn decode_resize_too_short() {
        assert!(decode_resize(&[0, 1]).is_none());
    }

    #[test]
    fn decode_exit_code_too_short() {
        assert!(decode_exit_code(&[0, 1]).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn async_round_trip() {
        let (client, server) = tokio::net::UnixStream::pair().unwrap();
        let (_, mut write_half) = client.into_split();
        let (mut read_half, _) = server.into_split();

        write_frame_async(&mut write_half, MSG_OUTPUT, b"async test")
            .await
            .unwrap();
        drop(write_half); // close writer so reader gets EOF after the frame

        let frame = read_frame_async(&mut read_half).await.unwrap().unwrap();
        assert_eq!(frame.msg_type, MSG_OUTPUT);
        assert_eq!(frame.payload, b"async test");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn async_eof_returns_none() {
        let (client, server) = tokio::net::UnixStream::pair().unwrap();
        drop(client); // immediately close
        let (mut read_half, _) = server.into_split();

        let result = read_frame_async(&mut read_half).await.unwrap();
        assert!(result.is_none());
    }

    /// The registry gives its reader a small per-connection frame ceiling so a
    /// peer cannot make it pre-allocate a large buffer. A length prefix above the
    /// cap must be rejected *before* any payload buffer is touched — here no
    /// payload bytes follow the header at all, so the reader can only reject
    /// pre-allocation.
    #[tokio::test]
    async fn capped_read_rejects_oversized_frame_before_allocation() {
        let cap: u32 = 64 * 1024;
        let mut buf = Vec::new();
        buf.push(MSG_OUTPUT);
        buf.extend_from_slice(&(cap + 1).to_be_bytes());
        // Deliberately no payload bytes: a reader that allocated first would hang
        // or read garbage; the size check must fire on the header alone.
        let mut cursor = Cursor::new(buf);
        let err = read_frame_async_capped(&mut cursor, cap)
            .await
            .expect_err("oversized frame must be rejected");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    /// A frame at exactly the cap is accepted (off-by-one guard).
    #[tokio::test]
    async fn capped_read_accepts_a_frame_at_the_ceiling() {
        let cap: u32 = 8;
        let mut buf = Vec::new();
        write_frame(&mut buf, MSG_OUTPUT, &[0xABu8; 8]).unwrap();
        let mut cursor = Cursor::new(buf);
        let frame = read_frame_async_capped(&mut cursor, cap)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload.len(), 8);
    }

    /// The mid-frame timeout only bounds a frame that has *started* arriving: a
    /// peer that writes one header byte then stalls is a local slowloris and must
    /// be dropped, not parked forever.
    #[tokio::test]
    async fn mid_frame_stall_trips_the_timeout() {
        let (mut client, mut server) = tokio::io::duplex(64);
        client.write_all(&[MSG_OUTPUT]).await.unwrap(); // one header byte, then stall
        let err = read_frame_async_capped_timeout(&mut server, 1024, Duration::from_millis(50))
            .await
            .expect_err("a stalled mid-frame read must time out");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        drop(client); // keep the peer alive until after the timeout fired
    }

    /// A complete small frame passes the mid-frame timeout untouched — the
    /// timeout must never trip a healthy peer.
    #[tokio::test]
    async fn a_complete_frame_passes_the_mid_frame_timeout() {
        let (mut client, mut server) = tokio::io::duplex(64);
        write_frame_async(&mut client, MSG_OUTPUT, b"hi")
            .await
            .unwrap();
        let frame = read_frame_async_capped_timeout(&mut server, 1024, Duration::from_secs(5))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.msg_type, MSG_OUTPUT);
        assert_eq!(frame.payload, b"hi");
    }

    /// A clean disconnect between frames (no bytes in flight) is a normal EOF, not
    /// a timeout: an idle-but-connected worker that goes away must return
    /// `Ok(None)`, never a `TimedOut` error.
    #[tokio::test]
    async fn mid_frame_timeout_returns_none_on_clean_eof() {
        let (client, mut server) = tokio::io::duplex(64);
        drop(client);
        let result = read_frame_async_capped_timeout(&mut server, 1024, Duration::from_millis(50))
            .await
            .unwrap();
        assert!(result.is_none());
    }
}
