//! Newline-delimited JSON (NDJSON) framing helpers.
//!
//! A single serialized JSON message per line, terminated by `\n`. This is the
//! framing shared by the desktop spawn IPC and the agent's JSON-RPC transport.
//! The helpers are protocol-agnostic — they move opaque `&str`/`String` lines
//! and never inspect the JSON — so any newline-delimited protocol can reuse
//! them.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Write `line` followed by a single `\n` and flush the writer.
///
/// The caller is responsible for ensuring `line` itself contains no interior
/// newline (i.e. it is one serialized JSON value); NDJSON framing relies on
/// `\n` being a message boundary.
pub async fn write_line<W>(_writer: &mut W, _line: &str) -> io::Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    todo!("implemented in the following commit")
}

/// Read one newline-delimited line into `buf` (cleared first).
///
/// Returns the number of bytes read, or `0` at end-of-stream. The trailing
/// newline is included in `buf` when present, matching
/// [`tokio::io::AsyncBufReadExt::read_line`]; callers typically `trim()` before
/// parsing. A line split across multiple underlying reads is transparently
/// reassembled by the buffered reader.
pub async fn read_line<R>(_reader: &mut R, _buf: &mut String) -> io::Result<usize>
where
    R: AsyncBufRead + Unpin + ?Sized,
{
    todo!("implemented in the following commit")
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
        read_line(&mut reader, &mut line).await.expect("read second");
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
            client.write_all(b"lo world\n").await.expect("write chunk 2");
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
    async fn read_line_returns_zero_at_eof() {
        let empty: &[u8] = b"";
        let mut reader = BufReader::new(empty);
        let mut line = String::new();
        let n = read_line(&mut reader, &mut line).await.expect("read_line");
        assert_eq!(n, 0, "EOF yields zero bytes");
    }
}
