//! Length-prefixed binary frame protocol for agent ↔ daemon communication.
//!
//! Frame format: `[type: 1 byte][length: 4 bytes BE][payload: length bytes]`
//!
//! This protocol is intentionally simple and binary to avoid JSON/base64
//! overhead on the local Unix socket path. JSON-RPC encoding only happens
//! at the agent-to-desktop boundary.

use std::io::{self, Read, Write};

#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

// ── Message type constants ──────────────────────────────────────────

/// Agent → Daemon: raw input bytes for the PTY.
pub const MSG_INPUT: u8 = 0x01;
/// Agent → Daemon: resize PTY (payload: cols u16 BE + rows u16 BE).
pub const MSG_RESIZE: u8 = 0x02;
/// Agent → Daemon: detach (empty payload).
pub const MSG_DETACH: u8 = 0x03;
/// Agent → Daemon: kill shell and exit (empty payload).
pub const MSG_KILL: u8 = 0x04;

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

/// Maximum allowed frame payload size (16 MiB).
const MAX_PAYLOAD_SIZE: u32 = 16 * 1024 * 1024;

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

// ── Async I/O (used by the agent's ShellBackend, Unix only) ─────────

/// Read a single frame from an async Unix socket read half.
///
/// Returns `Ok(None)` on clean EOF.
#[cfg(unix)]
pub async fn read_frame_async(reader: &mut OwnedReadHalf) -> io::Result<Option<Frame>> {
    let mut header = [0u8; HEADER_SIZE];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
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
        reader.read_exact(&mut payload).await.map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::UnexpectedEof, "Truncated frame payload")
            } else {
                e
            }
        })?;
    }

    Ok(Some(Frame { msg_type, payload }))
}

/// Write a single frame to an async Unix socket write half.
#[cfg(unix)]
pub async fn write_frame_async(
    writer: &mut OwnedWriteHalf,
    msg_type: u8,
    payload: &[u8],
) -> io::Result<()> {
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
}
