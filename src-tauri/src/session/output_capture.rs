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
        self.ring.write(data);
        self.written += data.len() as u64;
        start
    }

    /// The kept output and where it ends.
    pub fn snapshot(&self) -> ScrollbackReplay {
        ScrollbackReplay {
            data: self.ring.read_all(),
            end_offset: self.written,
            epoch: self.epoch,
        }
    }

    /// The source sends everything it has again from `offset` on
    /// ([`output_replay_start`]): forget what came before, which would
    /// otherwise be in the history twice. Positions stay as they are.
    ///
    /// `offset` may be ahead of what was written; nothing is kept then until
    /// the replay arrives.
    ///
    /// [`output_replay_start`]: termihub_core::connection::ConnectionType::output_replay_start
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

    /// How much of the history was written so far, kept or not.
    fn history_len(&self) -> u64 {
        self.written.saturating_sub(self.history_start)
    }

    /// Whether everything the source held when it had `len` bytes is here.
    pub fn has_caught_up_with(&self, len: usize) -> bool {
        self.history_len() >= len as u64
    }

    /// Whether the history is longer than what is kept of it.
    pub fn has_dropped_history(&self) -> bool {
        self.history_len() > self.ring.len() as u64
    }
}

/// Shortest run of bytes that places `recent` inside `older`.
const MIN_OVERLAP: usize = 4096;

/// `recent` with the output before it, taken from `older`.
///
/// `older` is the agent's own buffer of the same session, which may be
/// configured larger than the capture. It must end inside `recent`, so call
/// this only for a capture that has caught up with `older` and dropped the
/// start of its history. Only the part before `recent` is used, so where the
/// replay ends is still decided by `recent` alone. When `recent` cannot be
/// found in `older`, `recent` is all there is.
pub fn extend_back(older: &[u8], recent: Vec<u8>) -> Vec<u8> {
    if older.len() <= recent.len() || recent.len() < MIN_OVERLAP {
        return recent;
    }
    let overlap = longest_overlap(&older[older.len() - recent.len()..], &recent);
    if overlap < MIN_OVERLAP {
        return recent;
    }
    let mut all = older[..older.len() - overlap].to_vec();
    all.extend_from_slice(&recent);
    all
}

/// The longest prefix of `recent` that `older` ends with (Knuth-Morris-Pratt,
/// so repetitive output costs no more than any other).
fn longest_overlap(older: &[u8], recent: &[u8]) -> usize {
    let mut fallback = vec![0usize; recent.len()];
    let mut len = 0;
    for i in 1..recent.len() {
        while len > 0 && recent[i] != recent[len] {
            len = fallback[len - 1];
        }
        if recent[i] == recent[len] {
            len += 1;
        }
        fallback[i] = len;
    }
    let mut matched = 0;
    for &byte in older {
        while matched > 0 && (matched == recent.len() || byte != recent[matched]) {
            matched = fallback[matched - 1];
        }
        if byte == recent[matched] {
            matched += 1;
        }
    }
    matched
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
        assert!(!capture.has_caught_up_with(1));
    }

    #[test]
    fn catching_up_and_dropping_count_from_the_replay() {
        let mut capture = OutputCapture::with_capacity(4);
        assert!(capture.has_caught_up_with(0));
        capture.write(b"abcd");
        assert!(!capture.has_dropped_history());
        capture.write(b"e");
        assert!(capture.has_dropped_history());
        assert!(capture.has_caught_up_with(5) && !capture.has_caught_up_with(6));
        capture.history_starts_at(3);
        assert!(!capture.has_dropped_history());
        assert!(capture.has_caught_up_with(2) && !capture.has_caught_up_with(3));
    }

    /// Non-periodic bytes, so an overlap has one place.
    fn stream(len: usize) -> Vec<u8> {
        (0..len as u32)
            .flat_map(|i| i.wrapping_mul(2_654_435_761).to_le_bytes())
            .take(len)
            .collect()
    }

    #[test]
    fn a_larger_agent_buffer_supplies_only_what_came_before() {
        let all = stream(40_000);
        // The agent's buffer was read before the last 1000 bytes came.
        let older = &all[5_000..39_000];
        let recent = all[20_000..].to_vec();
        assert_eq!(extend_back(older, recent), all[5_000..].to_vec());
    }

    #[test]
    fn an_agent_buffer_that_does_not_fit_is_not_used() {
        let recent = stream(20_000);
        for older in [Vec::new(), vec![b'x'; 30_000], stream(100)] {
            assert_eq!(extend_back(&older, recent.clone()), recent);
        }
        // Too little captured to place it: the capture wins.
        let short = stream(10);
        assert_eq!(extend_back(&stream(30_000), short.clone()), short);
    }

    #[test]
    fn repetitive_output_is_placed_in_linear_time() {
        // A megabyte of one byte with a different end: a naive search compares
        // a megabyte at each of a million starts.
        let mut older = vec![b'z'; 100];
        older.extend(vec![b'x'; 1 << 20]);
        let mut recent = vec![b'x'; 1 << 20];
        recent.extend(b"end");
        let out = extend_back(&older, recent.clone());
        assert_eq!(&out[..100], vec![b'z'; 100]);
        assert_eq!(&out[100..], recent);
    }

    #[test]
    fn the_wire_form_is_base64_and_camel_case() {
        let json = serde_json::to_value(ScrollbackReplay {
            data: vec![0xff, 0x00],
            end_offset: 7,
            epoch: 3,
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "data": "/wA=", "endOffset": 7, "epoch": 3 })
        );
    }
}
