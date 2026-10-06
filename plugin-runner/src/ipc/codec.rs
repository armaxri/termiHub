//! Frame codec: `[u32 BE length][u8 kind][payload]`.
//!
//! `length` counts the kind byte plus the payload, so it is never `0` and never
//! exceeds [`MAX_FRAME_LEN`]. It is the same layout `tokio_util`'s
//! `LengthDelimitedCodec` reads with a 4-byte big-endian length field, so either
//! side may later move to it without a protocol change. Both ends here use the
//! small synchronous reader/writer below: the runner is synchronous by design
//! (no async runtime inside the sandbox), and the host drives each runner from
//! a dedicated reader thread.

use std::io::{self, Read, Write};

use super::ProtocolError;

/// Bytes in the length prefix.
pub const LENGTH_PREFIX_LEN: usize = 4;

/// Largest permitted value of the length field (kind byte + payload): 1 MiB.
/// A peer announcing more is a protocol violation, refused before any
/// allocation.
pub const MAX_FRAME_LEN: usize = 1024 * 1024;

/// Largest payload a frame can carry.
pub const MAX_PAYLOAD_LEN: usize = MAX_FRAME_LEN - 1;

/// One raw frame: a kind byte and its payload, not yet interpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFrame {
    /// The kind byte (see [`super::FrameKind`]).
    pub kind: u8,
    /// The payload bytes (length-checked, possibly empty).
    pub payload: Vec<u8>,
}

/// Encode one frame whose payload is the concatenation of `parts` into a
/// single buffer, so the caller can hand it to the transport in **one** write
/// (the concept's "one writev / WriteFile per send").
pub fn encode_frame(kind: u8, parts: &[&[u8]]) -> Result<Vec<u8>, ProtocolError> {
    let payload_len: usize = parts.iter().map(|p| p.len()).sum();
    if payload_len > MAX_PAYLOAD_LEN {
        return Err(ProtocolError::FrameTooLarge(payload_len.saturating_add(1)));
    }
    let frame_len = payload_len + 1;
    let mut buf = Vec::with_capacity(LENGTH_PREFIX_LEN + frame_len);
    // `frame_len <= MAX_FRAME_LEN` (1 MiB) always fits in a u32.
    buf.extend_from_slice(&u32::try_from(frame_len).unwrap_or(u32::MAX).to_be_bytes());
    buf.push(kind);
    for part in parts {
        buf.extend_from_slice(part);
    }
    Ok(buf)
}

/// Write one already-encoded frame (from [`encode_frame`]) with a single
/// `write_all` and flush.
pub fn write_encoded<W: Write>(writer: &mut W, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

/// A small synchronous frame reader over any [`Read`].
///
/// Untrusted-peer safe: the length is validated before anything is allocated,
/// and a short read inside a frame is an error, not a partial frame.
#[derive(Debug)]
pub struct FrameReader<R> {
    inner: R,
}

impl<R: Read> FrameReader<R> {
    /// Wrap a reader.
    pub fn new(inner: R) -> Self {
        Self { inner }
    }

    /// The wrapped reader.
    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    /// Read the next frame.
    ///
    /// Returns `Ok(None)` on a clean end of stream **at a frame boundary** (the
    /// peer closed the channel). An end of stream inside a frame is
    /// [`ProtocolError::Truncated`].
    pub fn read_frame(&mut self) -> Result<Option<RawFrame>, ProtocolError> {
        let mut header = [0u8; LENGTH_PREFIX_LEN];
        if !read_exact_or_eof(&mut self.inner, &mut header)? {
            return Ok(None);
        }
        let len = u32::from_be_bytes(header) as usize;
        if len == 0 {
            return Err(ProtocolError::EmptyFrame);
        }
        if len > MAX_FRAME_LEN {
            return Err(ProtocolError::FrameTooLarge(len));
        }
        let mut kind = [0u8; 1];
        read_exact_in_frame(&mut self.inner, &mut kind)?;
        let mut payload = vec![0u8; len - 1];
        read_exact_in_frame(&mut self.inner, &mut payload)?;
        Ok(Some(RawFrame {
            kind: kind[0],
            payload,
        }))
    }
}

/// Fill `buf`, returning `Ok(false)` if the stream ended before the first byte
/// and [`ProtocolError::Truncated`] if it ended part-way.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<bool, ProtocolError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(ProtocolError::Truncated),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(ProtocolError::Io(e)),
        }
    }
    Ok(true)
}

/// Fill `buf` inside a frame: any end of stream is [`ProtocolError::Truncated`].
fn read_exact_in_frame<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<(), ProtocolError> {
    if buf.is_empty() {
        return Ok(());
    }
    if read_exact_or_eof(reader, buf)? {
        Ok(())
    } else {
        Err(ProtocolError::Truncated)
    }
}
