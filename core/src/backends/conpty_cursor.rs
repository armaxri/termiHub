//! Answer ConPTY's opening cursor-position query (#3974).
//!
//! `portable-pty` 0.9 creates the Windows pseudoconsole with
//! `PSUEDOCONSOLE_INHERIT_CURSOR`. With that flag, conhost writes a DSR
//! cursor-position query (`ESC [ 6 n`) at startup and **withholds all of the
//! child's output until something answers it**. `portable-pty` 0.8 did not set
//! the flag, so ConPTY simply assumed the cursor started at the home position.
//!
//! Relying on the frontend terminal (xterm.js) to answer is not safe: output
//! can be buffered before any terminal is attached (headless sessions, the
//! agent, tests, the WSL setup tap), and a session with no answering terminal
//! would stall forever. [`CursorQueryAnswerer`] instead answers the query at
//! the PTY reader seam with `ESC [ 1 ; 1 R` (row 1, column 1 — exactly the
//! position 0.8's ConPTY assumed) and drops it from the stream, so the
//! frontend never sees it and never answers it a second time.
//!
//! Only the **first** query inside the opening [`SCAN_LIMIT`] bytes is
//! consumed. Conhost sends it before releasing any child output, so it always
//! falls within its short startup preamble; any later `ESC [ 6 n` (e.g. from
//! an application running in the shell) passes through untouched and is
//! answered by the real terminal as before.
//!
//! The logic is platform-independent (and unit-tested on every platform); it
//! is only wired into the PTY readers on Windows.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// The DSR cursor-position query conhost emits at startup.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";

/// The cursor-position report sent back: row 1, column 1 (home).
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// How many opening output bytes are scanned for the query before the
/// answerer gives up and becomes a plain pass-through. Conhost's preamble
/// (a few mode-setting sequences) is far below this.
const SCAN_LIMIT: usize = 256;

/// A PTY writer shared between the session (user input) and the
/// [`CursorQueryAnswerer`] (the one-off cursor reply).
pub(crate) type SharedPtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// [`Write`] adapter over a [`SharedPtyWriter`], so the shared writer can be
/// handed out wherever a plain `Box<dyn Write + Send>` is expected. Only the
/// local-shell spawner needs it (WSL keeps the shared writer as-is).
#[cfg(any(test, all(windows, feature = "local-shell")))]
pub(crate) struct SharedWriter(pub(crate) SharedPtyWriter);

#[cfg(any(test, all(windows, feature = "local-shell")))]
impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|e| std::io::Error::other(format!("pty writer lock poisoned: {e}")))?
            .write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|e| std::io::Error::other(format!("pty writer lock poisoned: {e}")))?
            .flush()
    }
}

/// [`Read`] adapter over a PTY reader that answers and strips ConPTY's opening
/// cursor-position query. See the module docs.
pub(crate) struct CursorQueryAnswerer<R> {
    inner: R,
    writer: SharedPtyWriter,
    /// `true` while still looking for the opening query.
    scanning: bool,
    /// Output bytes consumed from `inner` so far while scanning.
    scanned: usize,
    /// Trailing bytes that may be the start of a query split across reads.
    carry: Vec<u8>,
    /// Processed bytes waiting to be handed to the caller.
    pending: Vec<u8>,
    /// Read offset into `pending`.
    pending_pos: usize,
}

impl<R: Read> CursorQueryAnswerer<R> {
    pub(crate) fn new(inner: R, writer: SharedPtyWriter) -> Self {
        Self {
            inner,
            writer,
            scanning: true,
            scanned: 0,
            carry: Vec::new(),
            pending: Vec::new(),
            pending_pos: 0,
        }
    }

    fn answer(&self) {
        // A failed reply is not fatal to reading: the session would behave as
        // if no answerer existed. Log-free by design (this runs on the hot
        // reader thread); the write error resurfaces on the next user input.
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(CURSOR_REPLY);
            let _ = w.flush();
        }
    }

    /// Process one freshly read chunk (prefixed by any carried bytes) into
    /// `pending`.
    fn process(&mut self, chunk: &[u8]) {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        self.scanned += chunk.len();

        if let Some(pos) = find(&data, CURSOR_QUERY) {
            self.scanning = false;
            self.answer();
            self.pending.extend_from_slice(&data[..pos]);
            self.pending
                .extend_from_slice(&data[pos + CURSOR_QUERY.len()..]);
            return;
        }

        if self.scanned >= SCAN_LIMIT {
            // Not coming: stop scanning and release everything held.
            self.scanning = false;
            self.pending.extend_from_slice(&data);
            return;
        }

        // Hold back a trailing partial query so a split one is still caught.
        let hold = partial_prefix_len(&data, CURSOR_QUERY);
        let split = data.len() - hold;
        self.pending.extend_from_slice(&data[..split]);
        self.carry.extend_from_slice(&data[split..]);
    }

    fn drain_pending(&mut self, buf: &mut [u8]) -> usize {
        let available = &self.pending[self.pending_pos..];
        let n = available.len().min(buf.len());
        buf[..n].copy_from_slice(&available[..n]);
        self.pending_pos += n;
        if self.pending_pos == self.pending.len() {
            self.pending.clear();
            self.pending_pos = 0;
        }
        n
    }
}

impl<R: Read> Read for CursorQueryAnswerer<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.pending_pos < self.pending.len() {
                return Ok(self.drain_pending(buf));
            }
            if !self.scanning {
                if !self.carry.is_empty() {
                    self.pending = std::mem::take(&mut self.carry);
                    continue;
                }
                return self.inner.read(buf);
            }

            let mut chunk = vec![0u8; buf.len().max(CURSOR_QUERY.len())];
            let n = self.inner.read(&mut chunk)?;
            if n == 0 {
                // EOF: release any held partial bytes, then report EOF.
                self.scanning = false;
                if self.carry.is_empty() {
                    return Ok(0);
                }
                continue;
            }
            self.process(&chunk[..n]);
            // `pending` may be empty if the whole chunk was the query or a
            // held partial prefix — loop to read more rather than return 0
            // (which would signal EOF).
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Length of the longest proper prefix of `needle` that `data` ends with.
fn partial_prefix_len(data: &[u8], needle: &[u8]) -> usize {
    (1..needle.len())
        .rev()
        .find(|&k| data.len() >= k && data[data.len() - k..] == needle[..k])
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Reader yielding the given chunks one `read()` at a time, then EOF.
    struct ChunkReader(VecDeque<Vec<u8>>);

    impl Read for ChunkReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(chunk) => {
                    let n = chunk.len().min(buf.len());
                    buf[..n].copy_from_slice(&chunk[..n]);
                    if n < chunk.len() {
                        self.0.push_front(chunk[n..].to_vec());
                    }
                    Ok(n)
                }
            }
        }
    }

    struct LogWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for LogWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Run `chunks` through an answerer; return (output, bytes written back).
    fn run(chunks: &[&[u8]], read_size: usize) -> (Vec<u8>, Vec<u8>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedPtyWriter = Arc::new(Mutex::new(Box::new(LogWriter(log.clone()))));
        let reader = ChunkReader(chunks.iter().map(|c| c.to_vec()).collect());
        let mut answerer = CursorQueryAnswerer::new(reader, writer);
        let mut out = Vec::new();
        let mut buf = vec![0u8; read_size];
        loop {
            let n = answerer.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let written = log.lock().unwrap().clone();
        (out, written)
    }

    #[test]
    fn answers_and_strips_opening_query() {
        let (out, written) = run(&[b"\x1b[6n", b"PS C:\\> "], 4096);
        assert_eq!(out, b"PS C:\\> ");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn answers_query_after_conhost_preamble() {
        let (out, written) = run(&[b"\x1b[?1004h\x1b[?9001h\x1b[6nPS> "], 4096);
        assert_eq!(out, b"\x1b[?1004h\x1b[?9001hPS> ");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn answers_query_split_across_reads() {
        let (out, written) = run(&[b"\x1b[?9001h\x1b", b"[6", b"nhello"], 4096);
        assert_eq!(out, b"\x1b[?9001hhello");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn answers_only_the_first_query() {
        let (out, written) = run(&[b"\x1b[6nabc\x1b[6ndef"], 4096);
        assert_eq!(out, b"abc\x1b[6ndef");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn later_query_passes_through_in_a_later_read() {
        let (out, written) = run(&[b"\x1b[6n", b"x", b"\x1b[6n"], 4096);
        assert_eq!(out, b"x\x1b[6n");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn passes_through_when_no_query_arrives() {
        let (out, written) = run(&[b"hello ", b"world\x1b"], 4096);
        assert_eq!(out, b"hello world\x1b");
        assert!(written.is_empty());
    }

    #[test]
    fn stops_scanning_after_limit() {
        let preamble = vec![b'a'; SCAN_LIMIT];
        let (out, written) = run(&[&preamble, b"\x1b[6n"], 4096);
        let mut expected = preamble.clone();
        expected.extend_from_slice(CURSOR_QUERY);
        assert_eq!(out, expected);
        assert!(written.is_empty());
    }

    #[test]
    fn small_caller_buffer_loses_no_bytes() {
        let (out, written) = run(&[b"\x1b[?9001h\x1b[6nPS C:\\Users> "], 3);
        assert_eq!(out, b"\x1b[?9001hPS C:\\Users> ");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn eof_right_after_partial_prefix_releases_it() {
        let (out, written) = run(&[b"ab\x1b["], 4096);
        assert_eq!(out, b"ab\x1b[");
        assert!(written.is_empty());
    }

    // -- The sideloaded OpenConsole host (#4121) ------------------------------
    //
    // The packaged ConPTY host sends a DA1 query right after the cursor query
    // (`ESC [ 6 n ESC [ c ESC [ ? 1004 h ESC [ ? 9001 h`) and holds the child's
    // output up to 3 s for the reply.

    /// What the answerer must reply to the opening DA1 query: xterm.js's own
    /// answer, so conhost sees the same terminal either way.
    const XTERM_DA1_REPLY: &[u8] = b"\x1b[?1;2c";

    fn cpr_then_da1_reply() -> Vec<u8> {
        [CURSOR_REPLY, XTERM_DA1_REPLY].concat()
    }

    #[test]
    fn answers_and_strips_openconsole_da1_after_cursor_query() {
        let (out, written) = run(&[b"\x1b[6n\x1b[c\x1b[?1004h\x1b[?9001hPS> "], 4096);
        assert_eq!(out, b"\x1b[?1004h\x1b[?9001hPS> ");
        assert_eq!(written, cpr_then_da1_reply());
    }

    #[test]
    fn answers_openconsole_da1_split_across_reads() {
        let (out, written) = run(&[b"\x1b[6n\x1b", b"[", b"c\x1b[?9001hPS> "], 4096);
        assert_eq!(out, b"\x1b[?9001hPS> ");
        assert_eq!(written, cpr_then_da1_reply());
    }

    #[test]
    fn answers_openconsole_da1_with_a_tiny_caller_buffer() {
        let (out, written) = run(&[b"\x1b[6n\x1b[c\x1b[?9001hPS C:\\> "], 2);
        assert_eq!(out, b"\x1b[?9001hPS C:\\> ");
        assert_eq!(written, cpr_then_da1_reply());
    }

    #[test]
    fn da1_not_right_after_the_cursor_query_passes_through() {
        let (out, written) = run(&[b"\x1b[6nPS> \x1b[c"], 4096);
        assert_eq!(out, b"PS> \x1b[c");
        assert_eq!(written, CURSOR_REPLY);
    }

    #[test]
    fn da1_without_a_cursor_query_passes_through() {
        let (out, written) = run(&[b"\x1b[cPS> "], 4096);
        assert_eq!(out, b"\x1b[cPS> ");
        assert!(written.is_empty());
    }

    #[test]
    fn eof_inside_a_partial_da1_releases_it() {
        let (out, written) = run(&[b"\x1b[6n\x1b["], 4096);
        assert_eq!(out, b"\x1b[");
        assert_eq!(written, CURSOR_REPLY);
    }

    /// The inbox host sends the cursor query alone and releases nothing until
    /// it is answered, so the reply must go out before the answerer reads on
    /// (waiting for a possible DA1 first would deadlock the session).
    #[test]
    fn answers_the_cursor_query_before_reading_on() {
        struct GatedReader {
            log: Arc<Mutex<Vec<u8>>>,
            step: usize,
        }
        impl Read for GatedReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.step += 1;
                let chunk: &[u8] = match self.step {
                    1 => b"\x1b[6n",
                    2 => {
                        assert_eq!(
                            *self.log.lock().unwrap(),
                            CURSOR_REPLY,
                            "cursor query must be answered before the next read"
                        );
                        b"PS> "
                    }
                    _ => b"",
                };
                buf[..chunk.len()].copy_from_slice(chunk);
                Ok(chunk.len())
            }
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedPtyWriter = Arc::new(Mutex::new(Box::new(LogWriter(log.clone()))));
        let mut answerer = CursorQueryAnswerer::new(
            GatedReader {
                log: log.clone(),
                step: 0,
            },
            writer,
        );
        let mut out = Vec::new();
        answerer.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"PS> ");
    }

    #[test]
    fn shared_writer_writes_through() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let shared: SharedPtyWriter = Arc::new(Mutex::new(Box::new(LogWriter(log.clone()))));
        let mut w = SharedWriter(shared);
        w.write_all(b"exit\r").unwrap();
        w.flush().unwrap();
        assert_eq!(*log.lock().unwrap(), b"exit\r");
    }

    #[test]
    fn partial_prefix_len_matches_proper_prefixes_only() {
        assert_eq!(partial_prefix_len(b"x\x1b", CURSOR_QUERY), 1);
        assert_eq!(partial_prefix_len(b"x\x1b[", CURSOR_QUERY), 2);
        assert_eq!(partial_prefix_len(b"x\x1b[6", CURSOR_QUERY), 3);
        assert_eq!(partial_prefix_len(b"x[6", CURSOR_QUERY), 0);
        assert_eq!(partial_prefix_len(b"", CURSOR_QUERY), 0);
    }
}
