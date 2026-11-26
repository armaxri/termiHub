//! One session's captured output, with its position in the session's stream
//! (#1900, #5990).
//!
//! Every byte a session emits to the webview is also written here, so a tab
//! that mounts later can repaint history. A repaint is followed by live output,
//! and the two must meet exactly: a chunk the snapshot already holds must not
//! be shown again, and a chunk emitted after the snapshot must not be dropped.
//! Comparing text cannot decide that (two equal lines look the same), so every
//! emitted chunk carries the position it starts at ([`OutputCapture::write`])
//! and every snapshot the position it ends at ([`ScrollbackReplay`]). Both are
//! taken under this capture's lock.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use termihub_core::buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};

use super::manager::serialize_bytes_base64;

/// A session's scrollback for a repaint (#5990).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ScrollbackReplay {
    /// The output bytes as a base64 (standard alphabet, padded) string.
    #[serde(serialize_with = "serialize_bytes_base64")]
    #[cfg_attr(test, ts(type = "string"))]
    pub data: Vec<u8>,
    /// Where `data` ends in the session's output stream. A `terminal-output`
    /// byte of the same `epoch` before this position is already part of `data`.
    #[cfg_attr(test, ts(type = "number"))]
    pub end_offset: u64,
    /// Which output stream of the session this is (see [`StreamPosition`]).
    #[cfg_attr(test, ts(type = "number"))]
    pub epoch: u64,
    /// `data` is empty, but the agent holds output that is on its way as live
    /// output: a tab that shows the session's earlier output itself will get it
    /// again.
    pub coming: bool,
}

/// Where a chunk starts.
///
/// A session that is created again under the same id starts a new stream at
/// position 0. Its `epoch` is larger than that of every stream before it, so a
/// position is never compared with one of another stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamPosition {
    pub epoch: u64,
    pub offset: u64,
}

/// The epoch of the next stream.
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

/// The capture of one session: its last 1 MiB of output, and how much output
/// it has seen in total.
pub struct OutputCapture {
    ring: RingBuffer,
    epoch: u64,
    /// Every byte written so far, including the ones the ring dropped.
    written: u64,
    /// Where the history this capture keeps starts: 0, or the last replay.
    history_start: u64,
}

impl Default for OutputCapture {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_BUFFER_CAPACITY)
    }
}

impl OutputCapture {
    /// A capture of a new stream that keeps the last `capacity` bytes.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            ring: RingBuffer::new(capacity),
            epoch: NEXT_EPOCH.fetch_add(1, Ordering::SeqCst),
            written: 0,
            history_start: 0,
        }
    }

    /// Append `data`; returns where it starts.
    pub fn write(&mut self, data: &[u8]) -> StreamPosition {
        let start = StreamPosition {
            epoch: self.epoch,
            offset: self.written,
        };
        self.written += data.len() as u64;
        // What comes before the history may still be on its way when the replay
        // is known: it is part of the stream, not of the history.
        let stale = self.history_start.saturating_sub(start.offset);
        if let Some(history) = usize::try_from(stale).ok().and_then(|n| data.get(n..)) {
            self.ring.write(history);
        }
        start
    }

    /// The kept output and where it ends.
    pub fn snapshot(&self) -> ScrollbackReplay {
        ScrollbackReplay {
            data: self.ring.read_all(),
            end_offset: self.written,
            epoch: self.epoch,
            coming: false,
        }
    }

    /// Which stream of the session this captures (#6032).
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The position the next byte will have.
    pub fn end_offset(&self) -> u64 {
        self.written
    }

    /// Where the kept output starts.
    fn kept_start(&self) -> u64 {
        self.written - self.ring.len() as u64
    }

    /// [`snapshot`](Self::snapshot) with the history before what is kept, taken
    /// from `older`: the source's own buffer, which ends at `older_end` in the
    /// stream and may be configured larger than the capture.
    ///
    /// Nothing is added when `older` does not reach what is kept.
    pub fn snapshot_after(&self, older: &[u8], older_end: u64) -> ScrollbackReplay {
        let mut replay = self.snapshot();
        let before = older_end
            .checked_sub(self.kept_start())
            .and_then(|shared| older.len().checked_sub(usize::try_from(shared).ok()?))
            .and_then(|end| older.get(..end));
        if let Some(before) = before {
            replay.data.splice(0..0, before.iter().copied());
        }
        replay
    }

    /// The source sends everything it has again from `offset` on
    /// ([`output_replay`]): forget what came before, which would
    /// otherwise be in the history twice. Positions stay as they are.
    ///
    /// `offset` may be ahead of what was written; nothing is kept then until
    /// the replay arrives.
    ///
    /// [`output_replay`]: termihub_core::connection::ConnectionType::output_replay
    pub fn history_starts_at(&mut self, offset: u64) {
        if offset <= self.history_start {
            return;
        }
        self.history_start = offset;
        let keep = usize::try_from(self.written.saturating_sub(offset)).unwrap_or(usize::MAX);
        let all = self.ring.read_all();
        if keep < all.len() {
            self.ring.clear();
            self.ring.write(&all[all.len() - keep..]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_starts_where_the_one_before_ended() {
        let mut capture = OutputCapture::default();
        assert_eq!(capture.write(b"abc").offset, 0);
        assert_eq!(capture.write(b"").offset, 3);
        let start = capture.write(b"de");
        assert_eq!(start.offset, 3);
        assert_eq!(
            capture.snapshot(),
            ScrollbackReplay {
                data: b"abcde".to_vec(),
                end_offset: 5,
                epoch: start.epoch,
                coming: false,
            }
        );
    }

    #[test]
    fn the_end_position_counts_what_the_ring_dropped() {
        let mut capture = OutputCapture::with_capacity(4);
        capture.write(b"abcdef");
        capture.write(b"g");
        let snapshot = capture.snapshot();
        assert_eq!(snapshot.data, b"defg");
        assert_eq!(snapshot.end_offset, 7);
    }

    #[test]
    fn a_later_stream_has_a_larger_epoch() {
        let (mut first, mut second) = (OutputCapture::default(), OutputCapture::default());
        assert!(second.write(b"").epoch > first.write(b"").epoch);
        assert_eq!(second.snapshot().epoch, second.write(b"x").epoch);
    }

    #[test]
    fn a_replay_restarts_the_history_and_keeps_the_positions() {
        let mut capture = OutputCapture::default();
        capture.write(b"old");
        capture.write(b"old+new");
        capture.history_starts_at(3);
        assert_eq!(capture.snapshot().data, b"old+new");
        assert_eq!(capture.snapshot().end_offset, 10);
        assert_eq!(capture.write(b"!").offset, 10);
        // Told again, or of an earlier one: nothing changes.
        capture.history_starts_at(3);
        capture.history_starts_at(0);
        assert_eq!(capture.snapshot().data, b"old+new!");
        // A replay that is announced but not here yet.
        capture.history_starts_at(20);
        assert!(capture.snapshot().data.is_empty());
        // The rest of what came before it arrives first, and must not stay.
        assert_eq!(capture.write(b"stale").offset, 11);
        assert!(capture.snapshot().data.is_empty());
        assert_eq!(capture.snapshot().end_offset, 16);
        // Also when one chunk holds both.
        assert_eq!(capture.write(b"4567old+").offset, 16);
        capture.write(b"new");
        assert_eq!(capture.snapshot().data, b"old+new");
        assert_eq!(capture.snapshot().end_offset, 27);
    }

    /// A capture of `kept` bytes that saw all of `history`.
    fn capture_of(history: &[u8], kept: usize) -> OutputCapture {
        let mut capture = OutputCapture::with_capacity(kept);
        capture.write(history);
        capture
    }

    #[test]
    fn a_larger_buffer_adds_exactly_what_came_before() {
        // All alike: only positions can tell where the buffer belongs.
        let history = b"heartbeat OK\r\n".repeat(100);
        for lag in [0, 1, 14, 200] {
            let capture = capture_of(&history, 300);
            let end = history.len() - lag;
            let older = &history[end - 1_000..end];
            let replay = capture.snapshot_after(older, end as u64);
            assert!(replay.data == history[end - 1_000..], "lag {lag}");
            assert_eq!(replay.end_offset, history.len() as u64);
        }
    }

    #[test]
    fn a_buffer_that_ends_before_what_is_kept_adds_nothing() {
        let history = b"heartbeat OK\r\n".repeat(100);
        let capture = capture_of(&history, 300);
        let end = history.len() - 301;
        assert_eq!(
            capture.snapshot_after(&history[..end], end as u64).data,
            history[history.len() - 300..]
        );
    }

    #[test]
    fn a_buffer_inside_what_is_kept_adds_nothing() {
        let capture = capture_of(b"abcdef", 300);
        assert_eq!(capture.snapshot_after(b"bcd", 4).data, b"abcdef");
        assert_eq!(capture.snapshot_after(b"", 0).data, b"abcdef");
    }

    #[test]
    fn a_buffer_is_placed_after_a_replay_too() {
        let mut capture = OutputCapture::with_capacity(4);
        capture.write(b"old");
        capture.write(b"0123456789");
        capture.history_starts_at(3);
        // The buffer read when 8 bytes of the replay had been sent.
        assert_eq!(capture.snapshot_after(b"01234567", 11).data, b"0123456789");
    }

    #[test]
    fn the_wire_form_is_base64_and_camel_case() {
        let json = serde_json::to_value(ScrollbackReplay {
            data: vec![0xff, 0x00],
            end_offset: 7,
            epoch: 3,
            coming: true,
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "data": "/wA=", "endOffset": 7, "epoch": 3, "coming": true })
        );
    }
}
