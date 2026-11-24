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
    /// byte before this position is already part of `data`.
    #[cfg_attr(test, ts(type = "number"))]
    pub end_offset: u64,
}

/// The capture of one session: its last 1 MiB of output, and how much output
/// it has seen in total.
pub struct OutputCapture {
    ring: RingBuffer,
    /// Every byte written so far, including the ones the ring dropped.
    written: u64,
}

impl Default for OutputCapture {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_BUFFER_CAPACITY)
    }
}

impl OutputCapture {
    /// A capture that keeps the last `capacity` bytes.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            ring: RingBuffer::new(capacity),
            written: 0,
        }
    }

    /// Append `data`; returns the position it starts at.
    pub fn write(&mut self, data: &[u8]) -> u64 {
        let start = self.written;
        self.ring.write(data);
        self.written += data.len() as u64;
        start
    }

    /// The position the next byte will have.
    pub fn end_offset(&self) -> u64 {
        self.written
    }

    /// The kept output and the position it ends at.
    pub fn snapshot(&self) -> ScrollbackReplay {
        ScrollbackReplay {
            data: self.ring.read_all(),
            end_offset: self.written,
        }
    }

    /// Forget everything before `offset`; positions stay as they are.
    ///
    /// After a Reclaim the daemon sends its whole buffer again: what was
    /// captured before that would otherwise be in the capture twice.
    pub fn forget_before(&mut self, offset: u64) {
        let keep = usize::try_from(self.written.saturating_sub(offset)).unwrap_or(usize::MAX);
        let all = self.ring.read_all();
        if keep < all.len() {
            self.ring.clear();
            self.ring.write(&all[all.len() - keep..]);
        }
    }
}

/// Shortest run of bytes that places `recent` inside `older`.
const MIN_OVERLAP: usize = 4096;

/// `recent` with the output before it, taken from `older`.
///
/// `older` is the agent's own buffer of the same session, which may be
/// configured larger than the capture. It ends somewhere inside `recent` (it
/// was read a moment earlier). Only its part before `recent` is used, so where
/// the replay ends is still decided by `recent` alone. When `recent` cannot be
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
        assert_eq!(capture.write(b"abc"), 0);
        assert_eq!(capture.write(b""), 3);
        assert_eq!(capture.write(b"de"), 3);
        assert_eq!(capture.end_offset(), 5);
        assert_eq!(
            capture.snapshot(),
            ScrollbackReplay {
                data: b"abcde".to_vec(),
                end_offset: 5
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
    fn forgetting_keeps_the_positions() {
        let mut capture = OutputCapture::default();
        capture.write(b"old");
        let mark = capture.end_offset();
        capture.write(b"old+new");
        capture.forget_before(mark);
        assert_eq!(capture.snapshot().data, b"old+new");
        assert_eq!(capture.snapshot().end_offset, 10);
        assert_eq!(capture.write(b"!"), 10);
        // Nothing to forget.
        capture.forget_before(0);
        assert_eq!(capture.snapshot().data, b"old+new!");
        capture.forget_before(11);
        assert!(capture.snapshot().data.is_empty());
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
        })
        .expect("serialize");
        assert_eq!(json, serde_json::json!({ "data": "/wA=", "endOffset": 7 }));
    }
}
