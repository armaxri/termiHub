//! Generic cancellable chunked reader→writer copy loop (audit finding DUP-025).
//!
//! Both the SFTP transfer path (`src-tauri`'s `files::transfer`) and the FTP
//! transfer primitive ([`crate::backends::ftp`]) drove the same
//! "read a chunk → honour a stop request → write the chunk → report progress →
//! flush at EOF" loop over different transports, so a fix to
//! cancellation/progress/flush semantics in one could silently miss the other.
//!
//! [`run_chunked_copy`] is that one loop, parameterised over:
//!
//! - the reader/writer (any [`AsyncReadExt`]/[`AsyncWriteExt`]),
//! - the chunk size and a resume `start_offset` (FTP resumes via `REST`; SFTP
//!   always starts at `0`),
//! - a `should_stop` probe returning a caller-defined reason (`()` for SFTP's
//!   plain cancel, [`StopReason`](crate::backends::ftp::StopReason) for FTP's
//!   pause-vs-cancel),
//! - an `on_progress(transferred)` callback invoked after each chunk (the caller
//!   owns any throttling), and
//! - a `map_err(phase, io_error)` hook so each transport keeps its own error
//!   type and message text for the read/write/flush phases.
//!
//! The loop itself makes no I/O beyond the reader/writer, so it is transport- and
//! error-type-agnostic and lives here (non-feature-gated) rather than in the
//! `ftp`-gated backend.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Which I/O operation in the copy loop produced an error, so a caller can map
/// each phase to its own transport-specific error variant and message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyPhase {
    /// A `read` from the source reader failed.
    Read,
    /// A `write_all` to the destination writer failed.
    Write,
    /// The final `flush` of the destination writer failed.
    Flush,
}

/// Outcome of a chunked copy: either it ran to EOF, or it stopped early at a
/// chunk boundary (carrying the caller's stop reason and the partial byte count
/// reached so far, usable for cleanup or as a resume offset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkedCopyOutcome<S> {
    /// The reader hit EOF and the writer was flushed. `transferred` is the total
    /// cumulative byte count (including any `start_offset`).
    Completed { transferred: u64 },
    /// `should_stop` asked to stop before a chunk. `transferred` is the byte
    /// count reached so far; the writer is **not** flushed on this path.
    Stopped { transferred: u64, reason: S },
}

/// Copy `reader` → `writer` in `chunk_size` chunks, checking `should_stop`
/// before each chunk and reporting cumulative progress after each write.
///
/// - `start_offset` seeds the cumulative `transferred` counter so a resumed
///   transfer reports absolute (not per-attempt) byte counts; pass `0` for a
///   fresh copy.
/// - `should_stop()` is polled *before* each chunk read; returning `Some(reason)`
///   stops promptly and yields [`ChunkedCopyOutcome::Stopped`] **without**
///   flushing (matching both callers' cancel-at-chunk-boundary behaviour).
/// - `on_progress(transferred)` is called after every non-empty chunk with the
///   cumulative byte count; throttling, if any, is the caller's responsibility.
/// - `map_err(phase, err)` converts an [`std::io::Error`] from the read, write,
///   or flush phase into the caller's error type, preserving its message text.
///
/// On EOF the writer is flushed and [`ChunkedCopyOutcome::Completed`] is
/// returned. Any transport-specific finalisation (e.g. FTP's
/// `finalize_*_stream`) stays at the call site, after this returns.
#[allow(clippy::too_many_arguments)]
pub async fn run_chunked_copy<R, W, E, S, Stop, Prog, Err>(
    reader: &mut R,
    writer: &mut W,
    chunk_size: usize,
    start_offset: u64,
    should_stop: Stop,
    mut on_progress: Prog,
    map_err: Err,
) -> Result<ChunkedCopyOutcome<S>, E>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
    Stop: Fn() -> Option<S>,
    Prog: FnMut(u64),
    Err: Fn(CopyPhase, std::io::Error) -> E,
{
    let mut buf = vec![0u8; chunk_size];
    let mut transferred = start_offset;

    loop {
        if let Some(reason) = should_stop() {
            return Ok(ChunkedCopyOutcome::Stopped {
                transferred,
                reason,
            });
        }

        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| map_err(CopyPhase::Read, e))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| map_err(CopyPhase::Write, e))?;
        transferred += n as u64;
        on_progress(transferred);
    }

    writer
        .flush()
        .await
        .map_err(|e| map_err(CopyPhase::Flush, e))?;

    Ok(ChunkedCopyOutcome::Completed { transferred })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

    /// Map every phase to a string tagged with the phase, so a test can assert
    /// which phase an error came from and that the io-error text is preserved.
    fn tag_err(phase: CopyPhase, e: io::Error) -> String {
        let label = match phase {
            CopyPhase::Read => "read",
            CopyPhase::Write => "write",
            CopyPhase::Flush => "flush",
        };
        format!("{label}: {e}")
    }

    fn never_stop() -> Option<()> {
        None
    }

    #[tokio::test]
    async fn copies_multiple_chunks_with_exact_byte_fidelity() {
        // 10 bytes over a 4-byte chunk = chunks of 4, 4, 2 — a multi-chunk copy
        // whose tail chunk is smaller than the buffer.
        let input: Vec<u8> = (0..10u8).collect();
        let mut reader: &[u8] = &input;
        let mut out: Vec<u8> = Vec::new();

        let outcome = run_chunked_copy(&mut reader, &mut out, 4, 0, never_stop, |_| {}, tag_err)
            .await
            .expect("copy succeeds");

        assert_eq!(outcome, ChunkedCopyOutcome::Completed { transferred: 10 });
        assert_eq!(out, input, "every byte copied in order, unchanged");
    }

    #[tokio::test]
    async fn invokes_progress_once_per_chunk_with_cumulative_counts() {
        let input: Vec<u8> = (0..10u8).collect();
        let mut reader: &[u8] = &input;
        let mut out: Vec<u8> = Vec::new();
        let calls = RefCell::new(Vec::<u64>::new());

        let outcome = run_chunked_copy(
            &mut reader,
            &mut out,
            4,
            0,
            never_stop,
            |t| calls.borrow_mut().push(t),
            tag_err,
        )
        .await
        .expect("copy succeeds");

        assert_eq!(outcome, ChunkedCopyOutcome::Completed { transferred: 10 });
        // One call per non-empty chunk (4, 4, 2 bytes), cumulative.
        assert_eq!(*calls.borrow(), vec![4, 8, 10]);
    }

    #[tokio::test]
    async fn resume_offset_seeds_cumulative_transferred_count() {
        // A resumed transfer reports absolute byte counts: 6 bytes copied on top
        // of a 100-byte offset ends at 106, and progress is offset-relative too.
        let input: Vec<u8> = (0..6u8).collect();
        let mut reader: &[u8] = &input;
        let mut out: Vec<u8> = Vec::new();
        let calls = RefCell::new(Vec::<u64>::new());

        let outcome = run_chunked_copy(
            &mut reader,
            &mut out,
            4,
            100,
            never_stop,
            |t| calls.borrow_mut().push(t),
            tag_err,
        )
        .await
        .expect("copy succeeds");

        assert_eq!(outcome, ChunkedCopyOutcome::Completed { transferred: 106 });
        assert_eq!(*calls.borrow(), vec![104, 106]);
    }

    #[tokio::test]
    async fn empty_input_completes_without_progress_calls() {
        let mut reader: &[u8] = &[];
        let mut out: Vec<u8> = Vec::new();
        let calls = RefCell::new(0u32);

        let outcome = run_chunked_copy(
            &mut reader,
            &mut out,
            4,
            0,
            never_stop,
            |_| *calls.borrow_mut() += 1,
            tag_err,
        )
        .await
        .expect("copy succeeds");

        assert_eq!(outcome, ChunkedCopyOutcome::Completed { transferred: 0 });
        assert!(out.is_empty());
        assert_eq!(*calls.borrow(), 0, "no progress for a zero-byte copy");
    }

    #[tokio::test]
    async fn stops_at_chunk_boundary_with_partial_bytes_and_reason() {
        // should_stop returns None once (letting one 4-byte chunk through), then
        // Some — so the copy stops at the next boundary with 4 bytes written.
        let input: Vec<u8> = (0..16u8).collect();
        let mut reader: &[u8] = &input;
        let mut out: Vec<u8> = Vec::new();
        let calls = RefCell::new(0u32);

        let outcome = run_chunked_copy(
            &mut reader,
            &mut out,
            4,
            0,
            || {
                let mut n = calls.borrow_mut();
                *n += 1;
                if *n <= 1 {
                    None
                } else {
                    Some("cancelled")
                }
            },
            |_| {},
            tag_err,
        )
        .await
        .expect("stop is not an error");

        assert_eq!(
            outcome,
            ChunkedCopyOutcome::Stopped {
                transferred: 4,
                reason: "cancelled",
            }
        );
        assert_eq!(out, vec![0, 1, 2, 3], "only the pre-stop chunk was written");
    }

    /// A reader whose first `read` fails, to exercise the [`CopyPhase::Read`]
    /// error-mapping path.
    struct FailingReader;

    impl tokio::io::AsyncRead for FailingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, "boom")))
        }
    }

    #[tokio::test]
    async fn read_error_is_mapped_via_the_read_phase() {
        let mut reader = FailingReader;
        let mut out: Vec<u8> = Vec::new();

        let err = run_chunked_copy(&mut reader, &mut out, 4, 0, never_stop, |_| {}, tag_err)
            .await
            .expect_err("a failing read surfaces as an error");

        assert_eq!(err, "read: boom", "phase-tagged and text preserved");
    }
}
