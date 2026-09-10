//! Newline-delimited JSON (NDJSON) framing helpers.
//!
//! A single serialized JSON message per line, terminated by `\n`. This is the
//! framing shared by the desktop spawn IPC and the agent's JSON-RPC transport.
//! The helpers are protocol-agnostic — they move opaque `&str`/`String` lines
//! and never inspect the JSON — so any newline-delimited protocol can reuse
//! them.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Maximum length, in bytes, of a single NDJSON line (including its trailing
/// `\n`) that [`read_line`] will accept before rejecting the frame.
///
/// The read side spans a trust boundary: the desktop↔agent JSON-RPC transport
/// runs over SSH (a potentially hostile or compromised agent, or a MITM), and
/// the local spawn IPC reads from a child process. Legitimate frames are small
/// JSON objects, so a peer that streams bytes and never sends a `\n` is only
/// ever trying to exhaust memory — without a cap, [`read_line`] grows its buffer
/// without bound until the process OOMs (a trivial denial of service against a
/// safety-critical app). This cap bounds resident memory for one line.
///
/// 16 MiB matches the order of magnitude of the sibling binary-frame protocol's
/// `MAX_PAYLOAD_SIZE` (`agent/src/daemon/protocol.rs`); it is far above any real
/// JSON-RPC or spawn frame, so it never rejects legitimate traffic.
pub const MAX_LINE_LEN: usize = 16 * 1024 * 1024;

/// Write `line` followed by a single `\n` and flush the writer.
///
/// The caller is responsible for ensuring `line` itself contains no interior
/// newline (i.e. it is one serialized JSON value); NDJSON framing relies on
/// `\n` being a message boundary.
pub async fn write_line<W>(writer: &mut W, line: &str) -> io::Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

/// Read one newline-delimited line into `buf` (cleared first).
///
/// Returns the number of bytes read, or `0` at end-of-stream. The trailing
/// newline is included in `buf` when present, matching
/// [`tokio::io::AsyncBufReadExt::read_line`]; callers typically `trim()` before
/// parsing. A line split across multiple underlying reads is transparently
/// reassembled by the buffered reader.
///
/// The line length is bounded by [`MAX_LINE_LEN`]: a peer that never sends a
/// `\n` cannot drive unbounded allocation. Once the accumulated line would
/// exceed the cap the read stops (it does not keep buffering) and returns an
/// [`io::ErrorKind::InvalidData`] error rather than growing `buf` without bound.
pub async fn read_line<R>(reader: &mut R, buf: &mut String) -> io::Result<usize>
where
    R: AsyncBufRead + Unpin + ?Sized,
{
    read_line_capped(reader, buf, MAX_LINE_LEN).await
}

/// [`read_line`] with an explicit byte cap. Exists so tests can exercise the
/// over-cap path without allocating [`MAX_LINE_LEN`] bytes.
///
/// The cap is enforced *while reading*, not after: once the current line would
/// exceed `max_len`, no further bytes are buffered and the call returns an
/// error, so resident memory stays near `max_len` regardless of how much a peer
/// sends before a newline.
async fn read_line_capped<R>(reader: &mut R, buf: &mut String, max_len: usize) -> io::Result<usize>
where
    R: AsyncBufRead + Unpin + ?Sized,
{
    buf.clear();
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break; // EOF — return whatever trailing bytes we have (possibly none).
        }
        if let Some(idx) = available.iter().position(|&b| b == b'\n') {
            // A complete line ends here (newline at `idx`, inclusive).
            if bytes.len().saturating_add(idx + 1) > max_len {
                reader.consume(idx + 1);
                return Err(oversize_error(max_len));
            }
            bytes.extend_from_slice(&available[..=idx]);
            reader.consume(idx + 1);
            break;
        }
        // No newline in this chunk: reject before buffering if it would overflow.
        let take = available.len();
        if bytes.len().saturating_add(take) > max_len {
            reader.consume(take);
            return Err(oversize_error(max_len));
        }
        bytes.extend_from_slice(available);
        reader.consume(take);
    }
    let line =
        String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let n = line.len();
    buf.push_str(&line);
    Ok(n)
}

/// The error returned when a single NDJSON line exceeds the byte cap.
fn oversize_error(max_len: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("ndjson line exceeds {max_len} byte limit"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn write_line_appends_single_newline_and_flushes() {
        let mut buf: Vec<u8> = Vec::new();
        let json = r#"{"jsonrpc":"2.0","result":{},"id":1}"#;
        write_line(&mut buf, json).await.expect("write_line");
        let output = String::from_utf8(buf).expect("utf8");
        assert!(output.ends_with('\n'), "must terminate with newline");
        assert_eq!(output.matches('\n').count(), 1, "exactly one newline");
        assert_eq!(output.trim_end(), json, "payload preserved verbatim");
    }

    #[tokio::test]
    async fn read_line_reads_one_framed_line() {
        let data = b"first line\nsecond line\n";
        let mut reader = BufReader::new(&data[..]);
        let mut line = String::new();

        let n = read_line(&mut reader, &mut line).await.expect("read first");
        assert_eq!(n, "first line\n".len());
        assert_eq!(line.trim(), "first line");

        // A second read advances past the frame boundary.
        read_line(&mut reader, &mut line)
            .await
            .expect("read second");
        assert_eq!(line.trim(), "second line");
    }

    #[tokio::test]
    async fn read_line_reassembles_partial_reads() {
        // Simulate a line delivered across two separate writes: the buffered
        // reader must reassemble it into a single framed line.
        let (client, server) = tokio::io::duplex(64);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut client = client;
            client.write_all(b"hel").await.expect("write chunk 1");
            client.flush().await.expect("flush 1");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            client
                .write_all(b"lo world\n")
                .await
                .expect("write chunk 2");
            client.flush().await.expect("flush 2");
        });

        let mut reader = BufReader::new(server);
        let mut line = String::new();
        let n = read_line(&mut reader, &mut line).await.expect("read_line");
        assert_eq!(n, "hello world\n".len());
        assert_eq!(line.trim(), "hello world");
        writer.await.expect("writer task");
    }

    #[tokio::test]
    async fn read_line_rejects_line_over_cap_without_unbounded_growth() {
        // A peer that streams bytes and never sends a newline: with no cap this
        // grows the buffer without bound (DoS). With the cap it must return a
        // bounded error instead. Use a small cap so the test stays cheap.
        const CAP: usize = 64;
        let data = vec![b'x'; CAP * 4]; // 256 bytes, no newline.
        let mut reader = BufReader::new(&data[..]);
        let mut line = String::new();

        let err = read_line_capped(&mut reader, &mut line, CAP)
            .await
            .expect_err("over-cap line must be rejected");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn read_line_accepts_line_at_cap_boundary() {
        // A line exactly at the cap (including its newline) is still accepted.
        const CAP: usize = 8;
        let data = b"abcdefg\n"; // 7 payload bytes + newline == 8 == CAP.
        let mut reader = BufReader::new(&data[..]);
        let mut line = String::new();
        let n = read_line_capped(&mut reader, &mut line, CAP)
            .await
            .expect("line at cap boundary");
        assert_eq!(n, CAP);
        assert_eq!(line.trim(), "abcdefg");
    }

    #[tokio::test]
    async fn read_line_returns_zero_at_eof() {
        let empty: &[u8] = b"";
        let mut reader = BufReader::new(empty);
        let mut line = String::new();
        let n = read_line(&mut reader, &mut line).await.expect("read_line");
        assert_eq!(n, 0, "EOF yields zero bytes");
    }
}
