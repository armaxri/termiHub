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

/// Outcome of reading one NDJSON line under a size cap via
/// [`read_line_resumable`].
///
/// Unlike [`read_line`] — which returns a raw byte count and hard-errors on an
/// over-cap line — the resumable reader distinguishes a clean EOF, a complete
/// line, and an over-cap line that the caller can *reject and keep serving*.
#[derive(Debug)]
pub enum LineOutcome {
    /// A complete line — newline-terminated, or a trailing line delivered at
    /// EOF — whose length is within the cap. The trailing newline is stripped.
    Line(String),
    /// The line exceeded the cap. Any buffered bytes were dropped and the rest
    /// of the over-long line was discarded up to (and including) its terminating
    /// newline, so the caller can reject it and keep serving the connection
    /// without ever having buffered the whole thing.
    TooLarge,
    /// Clean EOF with no buffered bytes.
    Eof,
}

/// Read one newline-delimited line, **cancellation-safe** in a `select!` and
/// **bounded** to `max_len` resident bytes.
///
/// This differs from [`read_line`] on two axes that matter for a long-lived
/// JSON-RPC transport loop, so both live here rather than one being expressed in
/// terms of the other:
///
/// - **Cancellation safety (#1559).** [`AsyncBufReadExt::read_line`] is *not*
///   cancellation safe: used as a `select!` branch, when another branch (e.g. an
///   outbound notification) completes first, the bytes it has already consumed
///   are lost — silently dropping the front of an in-flight request. Under a peer
///   that fragments a request across TCP segments the surviving tail is then
///   parsed as its own frame. This reader keeps the partial-line accumulator
///   (`pending`) *outside* the future and only ever `await`s on
///   [`AsyncBufReadExt::fill_buf`], which is cancellation safe; bytes are
///   `consume`d synchronously with no intervening await, so a cancelled future
///   can never lose data — whatever was consumed is already in `pending`.
/// - **Bounded, recoverable over-cap handling (#2352).** The cap is enforced
///   *while reading*: once the current line would exceed `max_len`, `pending` is
///   cleared and subsequent bytes are discarded (never buffered) until the
///   terminating newline, keeping resident memory at ~`max_len` regardless of
///   how much a peer sends before a newline. The over-cap line is reported as
///   [`LineOutcome::TooLarge`] rather than an error, so the caller may reject it
///   and continue serving the connection. `max_len` bounds the line *content*
///   (the trailing newline is not counted).
///
/// `pending` must be owned by the caller and carried across calls (typically one
/// buffer for the lifetime of a connection). Callers pass their own `max_len`
/// (e.g. the agent JSON-RPC transport's 1 MiB protocol limit), which is why the
/// cap is a parameter rather than [`MAX_LINE_LEN`].
///
/// Returns [`LineOutcome::Line`] (newline stripped) for a complete line within
/// the cap, [`LineOutcome::TooLarge`] when the cap was exceeded, or
/// [`LineOutcome::Eof`] at a clean EOF with no buffered bytes.
pub async fn read_line_resumable<R>(
    reader: &mut R,
    pending: &mut Vec<u8>,
    max_len: usize,
) -> io::Result<LineOutcome>
where
    R: AsyncBufRead + Unpin + ?Sized,
{
    // Whether the current line has already crossed the cap. A partial line
    // carried over from a cancelled read is always within the cap, but never
    // trust that blindly.
    let mut over = pending.len() > max_len;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // EOF.
            if over {
                pending.clear();
                return Ok(LineOutcome::TooLarge);
            }
            // A trailing line without a newline is still delivered once; an
            // empty accumulator means a clean close.
            if pending.is_empty() {
                return Ok(LineOutcome::Eof);
            }
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(LineOutcome::Line(line));
        }

        if let Some(idx) = available.iter().position(|&b| b == b'\n') {
            // A complete line ends here. If it (or an earlier chunk) crossed the
            // cap, discard it up to and including the newline and report the
            // overflow; otherwise hand it back.
            if over || pending.len().saturating_add(idx) > max_len {
                reader.consume(idx + 1);
                pending.clear();
                return Ok(LineOutcome::TooLarge);
            }
            pending.extend_from_slice(&available[..idx]);
            reader.consume(idx + 1);
            let line = String::from_utf8(std::mem::take(pending))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(LineOutcome::Line(line));
        }

        // No newline yet. Buffer the chunk unless doing so would cross the cap,
        // in which case drop what we have and switch to discard-until-newline
        // mode. `available` is a borrow of the reader, so finish using it before
        // consuming.
        let len = available.len();
        if over {
            // Already discarding: drop this chunk.
        } else if pending.len().saturating_add(len) > max_len {
            over = true;
            pending.clear();
        } else {
            pending.extend_from_slice(available);
        }
        reader.consume(len);
    }
}

/// Why [`LineSplitter`] rejected a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LineError {
    /// The line's content exceeded the splitter's byte cap. Its bytes were
    /// dropped (never buffered past the cap); the splitter discards the rest of
    /// the line up to its terminating newline and then resumes. A peer that
    /// sends this is either broken or hostile, so connection-oriented callers
    /// treat it as a protocol error and tear the connection down.
    #[error("ndjson line exceeds {max_len} byte limit")]
    TooLong {
        /// The cap that was exceeded, in bytes of line content.
        max_len: usize,
    },
    /// A complete line was not valid UTF-8. Only that line is lost; the
    /// splitter carries on with the next one.
    #[error("ndjson line is not valid UTF-8: {0}")]
    InvalidUtf8(std::str::Utf8Error),
}

/// Push-based NDJSON line splitter for transports that deliver raw byte chunks
/// rather than an [`AsyncBufRead`] — e.g. an SSH channel's `Data` messages
/// (#4303, DUP2-002).
///
/// It is the chunk-driven sibling of [`read_line_resumable`] and shares its
/// semantics: the cap bounds line *content* (the trailing `\n` is not
/// counted), and an over-cap line is reported once as [`LineError::TooLong`]
/// while the rest of it is discarded up to its newline.
///
/// Properties:
///
/// - **UTF-8-safe across chunk boundaries (AGT2-001).** Bytes are buffered raw
///   and only a *complete* line is decoded, so a multi-byte character split
///   across two chunks is reassembled before decoding instead of turning into
///   two U+FFFD replacement characters.
/// - **Bounded (AGT2-003).** An unterminated line never grows the buffer past
///   the cap: a newline-free chunk that would cross it is rejected before it is
///   copied in, so resident memory stays at about `max_len` plus one chunk.
/// - **Linear.** A scan offset means each byte is searched for `\n` once, and
///   consumed lines are compacted away once per [`push`](Self::push) rather
///   than by re-copying the tail after every line.
#[derive(Debug)]
pub struct LineSplitter {
    buf: Vec<u8>,
    /// First unconsumed byte of `buf`.
    start: usize,
    /// `buf[start..scanned]` is known to hold no `\n`.
    scanned: usize,
    max_len: usize,
    /// Dropping the remainder of an over-cap line until its newline.
    discarding: bool,
    /// An over-cap rejection detected in [`push`](Self::push), reported by the
    /// next [`next_line`](Self::next_line).
    pending_error: Option<LineError>,
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl LineSplitter {
    /// A splitter capped at [`MAX_LINE_LEN`].
    pub fn new() -> Self {
        Self::with_max_len(MAX_LINE_LEN)
    }

    /// A splitter whose lines may hold at most `max_len` bytes of content.
    pub fn with_max_len(max_len: usize) -> Self {
        Self {
            buf: Vec::new(),
            start: 0,
            scanned: 0,
            max_len,
            discarding: false,
            pending_error: None,
        }
    }

    /// The byte cap on one line's content.
    pub fn max_len(&self) -> usize {
        self.max_len
    }

    /// Bytes buffered but not yet returned as a line (an unterminated tail plus
    /// any complete lines not yet taken).
    pub fn buffered_len(&self) -> usize {
        self.buf.len() - self.start
    }

    /// Drop everything buffered, e.g. when the transport is replaced and a
    /// partial line belongs to the old peer.
    pub fn clear(&mut self) {
        self.buf.clear();
        self.start = 0;
        self.scanned = 0;
        self.discarding = false;
        self.pending_error = None;
    }

    /// Feed one chunk and iterate the lines it completes, newline stripped.
    ///
    /// Lines the iterator does not get to stay buffered and are returned by
    /// the next [`next_line`](Self::next_line) or `push`.
    pub fn push(&mut self, chunk: &[u8]) -> Lines<'_> {
        self.compact();
        let mut chunk = chunk;
        if self.discarding {
            // `buf` is empty while discarding (it was cleared on entry).
            match chunk.iter().position(|&b| b == b'\n') {
                None => return Lines(self),
                Some(idx) => {
                    self.discarding = false;
                    chunk = &chunk[idx + 1..];
                }
            }
        }
        // Everything buffered is one unterminated partial line, and this chunk
        // does not end it: reject before copying in rather than growing past
        // the cap.
        if self.scanned == self.buf.len()
            && self.buf.len().saturating_add(chunk.len()) > self.max_len
            && !chunk.contains(&b'\n')
        {
            self.buf.clear();
            self.start = 0;
            self.scanned = 0;
            self.discarding = true;
            self.pending_error = Some(LineError::TooLong {
                max_len: self.max_len,
            });
            return Lines(self);
        }
        self.buf.extend_from_slice(chunk);
        Lines(self)
    }

    /// Take the next complete buffered line, if any.
    pub fn next_line(&mut self) -> Option<Result<String, LineError>> {
        if let Some(err) = self.pending_error.take() {
            return Some(Err(err));
        }
        if let Some(rel) = self.buf[self.scanned..].iter().position(|&b| b == b'\n') {
            let end = self.scanned + rel;
            let line_start = self.start;
            self.start = end + 1;
            self.scanned = self.start;
            let line = &self.buf[line_start..end];
            if line.len() > self.max_len {
                return Some(Err(LineError::TooLong {
                    max_len: self.max_len,
                }));
            }
            return Some(
                std::str::from_utf8(line)
                    .map(str::to_owned)
                    .map_err(LineError::InvalidUtf8),
            );
        }
        self.scanned = self.buf.len();
        if self.buffered_len() > self.max_len {
            // The unterminated tail crossed the cap (a chunk that also carried
            // complete lines): drop it and discard until its newline.
            self.buf.clear();
            self.start = 0;
            self.scanned = 0;
            self.discarding = true;
            return Some(Err(LineError::TooLong {
                max_len: self.max_len,
            }));
        }
        None
    }

    /// Release consumed bytes. Each byte is moved at most once: after a
    /// compaction it belongs to the first, still-unterminated line.
    fn compact(&mut self) {
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.scanned -= self.start;
            self.start = 0;
        }
    }
}

/// Iterator over the lines completed by one [`LineSplitter::push`].
#[derive(Debug)]
pub struct Lines<'a>(&'a mut LineSplitter);

impl Iterator for Lines<'_> {
    type Item = Result<String, LineError>;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next_line()
    }
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

    #[tokio::test(start_paused = true)]
    async fn read_line_reassembles_partial_reads() {
        // Simulate a line delivered across two separate writes: the buffered
        // reader must reassemble it into a single framed line.
        //
        // Timing is deterministic, not wall-clock: `start_paused` runs the
        // sleep on tokio's virtual clock, which only auto-advances once every
        // task is parked. The first flush wakes the reader, so it consumes the
        // partial "hel" (exercising the reassembly path) and parks waiting for
        // more before the clock advances and the remainder is written. This
        // sequences the two chunks without a real-time delay (TBE-012).
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

    // ── read_line_resumable (cancellation-safe, bounded, recoverable) ──────

    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    fn expect_line(outcome: LineOutcome) -> String {
        match outcome {
            LineOutcome::Line(line) => line,
            other => panic!("expected a complete line, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_line_resumable_reassembles_fragmented_line() {
        // A line delivered across two writes must reassemble into one frame,
        // draining the accumulator when the newline arrives.
        let (mut client, server) = tokio::io::duplex(1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        client.write_all(b"{\"a\":1").await.expect("chunk 1");
        client.write_all(b",\"b\":2}\n").await.expect("chunk 2");

        let line = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("read"),
        );
        assert_eq!(line, r#"{"a":1,"b":2}"#);
        assert!(pending.is_empty(), "accumulator drained after a line");
    }

    #[tokio::test]
    async fn read_line_resumable_returns_one_line_per_call() {
        // Two complete lines arriving in a single chunk must be handed back one
        // per call, with the remainder left buffered in the reader.
        let data = b"first\nsecond\n";
        let mut reader = BufReader::new(&data[..]);
        let mut pending = Vec::new();

        let first = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("first"),
        );
        assert_eq!(first, "first");
        let second = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("second"),
        );
        assert_eq!(second, "second");
    }

    #[tokio::test]
    async fn read_line_resumable_handles_empty_and_leading_newlines() {
        // A bare newline is a valid empty line, and a leading newline yields an
        // empty line before the next content line.
        let data = b"\nabc\n";
        let mut reader = BufReader::new(&data[..]);
        let mut pending = Vec::new();

        let empty = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("empty"),
        );
        assert_eq!(empty, "", "leading newline yields an empty line");
        let content = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("content"),
        );
        assert_eq!(content, "abc");
    }

    #[tokio::test]
    async fn read_line_resumable_delivers_trailing_line_without_newline_at_eof() {
        // A final line with no trailing newline is delivered once at EOF.
        let data = b"no newline here";
        let mut reader = BufReader::new(&data[..]);
        let mut pending = Vec::new();

        let line = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("trailing"),
        );
        assert_eq!(line, "no newline here");
        // The next read sees a clean EOF.
        let outcome = read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
            .await
            .expect("eof");
        assert!(
            matches!(outcome, LineOutcome::Eof),
            "clean EOF after trailing line"
        );
    }

    #[tokio::test]
    async fn read_line_resumable_returns_eof_on_clean_close() {
        let empty: &[u8] = b"";
        let mut reader = BufReader::new(empty);
        let mut pending = Vec::new();
        let outcome = read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
            .await
            .expect("eof");
        assert!(matches!(outcome, LineOutcome::Eof));
    }

    #[tokio::test]
    async fn read_line_resumable_accepts_line_at_cap_boundary() {
        // `max_len` bounds the line content (newline excluded): 7 content bytes
        // at a cap of 7 is accepted; a cap of 6 rejects the same line.
        const CAP: usize = 7;
        let data = b"abcdefg\n";
        let mut reader = BufReader::new(&data[..]);
        let mut pending = Vec::new();
        let line = expect_line(
            read_line_resumable(&mut reader, &mut pending, CAP)
                .await
                .expect("at cap"),
        );
        assert_eq!(line, "abcdefg");

        let mut reader = BufReader::new(&data[..]);
        let mut pending = Vec::new();
        let outcome = read_line_resumable(&mut reader, &mut pending, CAP - 1)
            .await
            .expect("over cap");
        assert!(
            matches!(outcome, LineOutcome::TooLarge),
            "one byte over the cap is rejected"
        );
    }

    #[tokio::test]
    async fn read_line_resumable_rejects_oversize_without_unbounded_buffering() {
        // A peer that streams far more than the cap with no newline must be
        // rejected as TooLarge and never fully buffered (the #2352 DoS bound).
        const CAP: usize = 64;
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        let writer = tokio::spawn(async move {
            client.write_all(&vec![b'x'; 100_000]).await.expect("body");
            client.write_all(b"\n").await.expect("newline");
            client // keep the writer alive until the read completes
        });

        let outcome = read_line_resumable(&mut reader, &mut pending, CAP)
            .await
            .expect("read");
        assert!(
            matches!(outcome, LineOutcome::TooLarge),
            "over-size line rejected"
        );
        assert!(
            pending.is_empty(),
            "accumulator cleared, not left holding the blob"
        );
        let _client = writer.await.expect("writer task");
    }

    #[tokio::test]
    async fn read_line_resumable_recovers_after_oversize_line() {
        // After an over-size line is rejected the connection keeps working: a
        // normal line that follows still parses.
        const CAP: usize = 32;
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        client.write_all(&vec![b'A'; 1000]).await.expect("big");
        client.write_all(b"\n").await.expect("nl1");
        client.write_all(b"{\"ok\":true}\n").await.expect("small");

        let first = read_line_resumable(&mut reader, &mut pending, CAP)
            .await
            .expect("first");
        assert!(
            matches!(first, LineOutcome::TooLarge),
            "over-size line rejected"
        );

        let second = expect_line(
            read_line_resumable(&mut reader, &mut pending, CAP)
                .await
                .expect("second"),
        );
        assert_eq!(
            second, r#"{"ok":true}"#,
            "line after over-size still parses"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn read_line_resumable_is_cancellation_safe() {
        // The #1559 property: a partial line survives the future being dropped
        // (as when a `select!` notification branch wins), because `pending`
        // lives outside the future. Simulated by letting a sleep branch win
        // while only the front of the line has arrived, then delivering the rest.
        //
        // `start_paused` keeps this deterministic and instant: the read future
        // parks (no newline yet) and the sleep is the only live timer, so the
        // virtual clock auto-advances and the sleep branch always wins — no
        // real 100ms wall-clock wait, no timing flake (TBE-012).
        let (mut client, server) = tokio::io::duplex(1024);
        let mut reader = BufReader::new(server);
        let mut pending = Vec::new();

        client
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"conn")
            .await
            .expect("front");

        tokio::select! {
            _ = read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN) => {
                panic!("read must not complete before the newline arrives");
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }

        assert_eq!(
            pending, b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"conn",
            "consumed prefix preserved across the cancellation"
        );

        client
            .write_all(b"ection.close\",\"params\":{}}\n")
            .await
            .expect("rest");
        let line = expect_line(
            read_line_resumable(&mut reader, &mut pending, MAX_LINE_LEN)
                .await
                .expect("read"),
        );
        assert_eq!(
            line,
            r#"{"jsonrpc":"2.0","id":7,"method":"connection.close","params":{}}"#
        );
    }

    // ── LineSplitter (push-based, bounded, UTF-8-safe; #4303) ──────────────

    fn collect(splitter: &mut LineSplitter, chunk: &[u8]) -> Vec<Result<String, LineError>> {
        splitter.push(chunk).collect()
    }

    #[test]
    fn splitter_decodes_multibyte_char_split_across_chunks() {
        // "Ü" is 0xC3 0x9C; split the line inside it (AGT2-001).
        let line = "{\"name\":\"Übersicht\"}\n".as_bytes();
        let split = line.iter().position(|&b| b == 0xC3).expect("Ü lead byte") + 1;
        let mut splitter = LineSplitter::new();
        assert!(collect(&mut splitter, &line[..split]).is_empty());
        let lines = collect(&mut splitter, &line[split..]);
        assert_eq!(lines, vec![Ok("{\"name\":\"Übersicht\"}".to_string())]);
    }

    #[test]
    fn splitter_decodes_every_byte_split_of_multibyte_text() {
        // Every split point of a line mixing 2-, 3- and 4-byte characters must
        // reassemble to the exact original text.
        let text = "Ü€😀 ok";
        let wire = format!("{text}\n");
        let bytes = wire.as_bytes();
        for split in 0..=bytes.len() {
            let mut splitter = LineSplitter::new();
            let mut lines = collect(&mut splitter, &bytes[..split]);
            lines.extend(collect(&mut splitter, &bytes[split..]));
            assert_eq!(lines, vec![Ok(text.to_string())], "split at {split}");
        }
    }

    #[test]
    fn splitter_yields_every_line_of_one_chunk_and_keeps_partial_tail() {
        let mut splitter = LineSplitter::new();
        let lines = collect(&mut splitter, b"a\n\nbc\npart");
        assert_eq!(
            lines,
            vec![Ok("a".to_string()), Ok(String::new()), Ok("bc".to_string())]
        );
        assert_eq!(splitter.buffered_len(), 4, "partial tail retained");
        assert_eq!(
            collect(&mut splitter, b"ial\n"),
            vec![Ok("partial".to_string())]
        );
        assert_eq!(splitter.buffered_len(), 0);
    }

    #[test]
    fn splitter_keeps_unread_lines_for_the_next_push() {
        // Dropping the iterator early must not lose lines.
        let mut splitter = LineSplitter::new();
        let first = splitter.push(b"one\ntwo\n").next();
        assert_eq!(first, Some(Ok("one".to_string())));
        assert_eq!(splitter.next_line(), Some(Ok("two".to_string())));
        assert_eq!(splitter.next_line(), None);
    }

    #[test]
    fn splitter_rejects_oversize_unterminated_stream_with_bounded_memory() {
        // A peer that streams bytes and never sends a newline: the splitter must
        // report TooLong and never hold more than the cap.
        const CAP: usize = 64;
        let mut splitter = LineSplitter::with_max_len(CAP);
        let mut errors = 0;
        for _ in 0..10_000 {
            for item in splitter.push(&[b'x'; 16]) {
                assert_eq!(item, Err(LineError::TooLong { max_len: CAP }));
                errors += 1;
            }
            assert!(
                splitter.buffered_len() <= CAP,
                "buffer grew to {}",
                splitter.buffered_len()
            );
        }
        assert_eq!(errors, 1, "an over-cap line is reported exactly once");
    }

    #[test]
    fn splitter_rejects_oversize_line_inside_one_chunk() {
        const CAP: usize = 8;
        let mut splitter = LineSplitter::with_max_len(CAP);
        let lines = collect(&mut splitter, b"0123456789\nok\n");
        assert_eq!(
            lines,
            vec![
                Err(LineError::TooLong { max_len: CAP }),
                Ok("ok".to_string())
            ]
        );
    }

    #[test]
    fn splitter_accepts_line_at_cap_boundary() {
        // Same semantics as `read_line_resumable`: the cap bounds content, the
        // newline is not counted.
        let mut splitter = LineSplitter::with_max_len(7);
        assert_eq!(
            collect(&mut splitter, b"abcdefg\n"),
            vec![Ok("abcdefg".into())]
        );
        let mut splitter = LineSplitter::with_max_len(6);
        assert_eq!(
            collect(&mut splitter, b"abcdefg\n"),
            vec![Err(LineError::TooLong { max_len: 6 })]
        );
    }

    #[test]
    fn splitter_discards_rest_of_oversize_line_then_recovers() {
        const CAP: usize = 4;
        let mut splitter = LineSplitter::with_max_len(CAP);
        assert_eq!(
            collect(&mut splitter, b"xxxxxx"),
            vec![Err(LineError::TooLong { max_len: CAP })]
        );
        assert!(
            collect(&mut splitter, b"yyyyyyyy").is_empty(),
            "still discarding"
        );
        assert_eq!(
            collect(&mut splitter, b"zz\nok\n"),
            vec![Ok("ok".to_string())]
        );
    }

    #[test]
    fn splitter_reports_invalid_utf8_per_line_and_continues() {
        let mut splitter = LineSplitter::new();
        let lines = collect(&mut splitter, b"\xff\xfe\nok\n");
        assert!(matches!(lines[0], Err(LineError::InvalidUtf8(_))));
        assert_eq!(lines[1], Ok("ok".to_string()));
    }

    #[test]
    fn splitter_clear_drops_partial_line() {
        let mut splitter = LineSplitter::new();
        assert!(collect(&mut splitter, b"stale partial").is_empty());
        splitter.clear();
        assert_eq!(
            collect(&mut splitter, b"fresh\n"),
            vec![Ok("fresh".to_string())]
        );
    }

    #[test]
    fn splitter_processes_many_small_chunks_of_one_long_line_linearly() {
        // AGT2-003: a long line in small chunks must not rescan the buffer per
        // chunk. 4 MiB in 1-byte-ish chunks would take minutes if quadratic.
        let len = 4 * 1024 * 1024;
        let mut splitter = LineSplitter::new();
        let chunk = [b'a'; 64];
        let start = std::time::Instant::now();
        for _ in 0..len / chunk.len() {
            assert!(splitter.push(&chunk).next().is_none());
        }
        let lines = collect(&mut splitter, b"\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].as_ref().map(String::len), Ok(len));
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn splitter_processes_many_lines_in_one_chunk_linearly() {
        // AGT2-003: many short lines in one large chunk must not copy the tail
        // once per line.
        let count = 200_000;
        let chunk: Vec<u8> = b"{\"m\":1}\n".repeat(count);
        let mut splitter = LineSplitter::new();
        let start = std::time::Instant::now();
        let n = splitter.push(&chunk).filter(|l| l.is_ok()).count();
        assert_eq!(n, count);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            start.elapsed()
        );
    }
}
