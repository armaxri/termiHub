//! Efficient byte transport across the Tauri IPC boundary (PERF-009).
//!
//! Tauri IPC is JSON-string based, so a `Vec<u8>` returned from a command is
//! serialized as serde's default JSON number-array (`[104, 101, ...]`) — one
//! decimal element plus a separator per byte, a ~4–6x wire bloat over the raw
//! bytes, plus a per-byte array→`Uint8Array` copy on the frontend. For buffers
//! that can reach the 1 MiB ring-buffer ceiling (scrollback replay and the agent
//! session buffer) that turns a 1 MiB payload into several MiB of JSON to
//! serialize and parse.
//!
//! [`encode_bytes_base64`] mirrors the terminal-output hot path (#2072) and the
//! remote file transport (PERF-002): the bytes cross IPC as a compact base64
//! (standard alphabet, padded) string that the frontend decodes with
//! `base64ToBytes` in `src/services/events.ts`. base64 is ~1.33 bytes/byte with
//! no per-element overhead and is byte-for-byte faithful for **all** values
//! 0x00–0xFF — high bytes and non-UTF8 sequences survive intact, which matters
//! because terminal scrollback is arbitrary bytes, not valid UTF-8.

use base64::Engine;

/// Encode a byte slice as a base64 (standard alphabet, padded) string for the
/// IPC boundary.
///
/// Exact inverse of `base64ToBytes` in `src/services/events.ts`. Byte-for-byte
/// faithful for all values 0x00–0xFF (high bytes and non-UTF8 sequences survive
/// intact); empty input encodes to the empty string.
pub fn encode_bytes_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::encode_bytes_base64;
    use base64::Engine;

    /// Scrollback / agent-buffer bytes cross IPC as base64 (PERF-009). The
    /// encoding must round-trip arbitrary bytes — including high bytes (>127)
    /// and non-UTF8 sequences — byte-for-byte, or terminal scrollback corrupts
    /// on replay. Decoding here mirrors the frontend's `base64ToBytes`.
    #[test]
    fn scrollback_bytes_base64_round_trip_is_byte_exact() {
        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),                                     // empty buffer → ""
            b"plain ascii scrollback".to_vec(),             // plain ASCII
            "héllo — 日本語 🎉".as_bytes().to_vec(),        // UTF-8 multi-byte
            vec![0x00, 0x7f, 0x80, 0xfe, 0xff],             // boundary + high bytes
            vec![0xff, 0xfe, 0xc0, 0xc1, 0x80],             // invalid-as-UTF8 bytes
            vec![0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0x07], // ANSI escape + NUL + BEL
            (0u16..=255).map(|b| b as u8).collect(),        // every byte value
        ];

        for bytes in cases {
            let encoded = encode_bytes_base64(&bytes);

            // Wire form is a compact base64 string, not a JSON number-array.
            assert!(
                !encoded.starts_with('['),
                "expected a base64 string on the wire, not a JSON array"
            );

            // Round-trips byte-for-byte via the same decode the frontend runs.
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&encoded)
                .expect("test decode of our own base64 must succeed");
            assert_eq!(decoded, bytes, "byte-exact round-trip failed");
        }
    }

    /// Empty scrollback (nothing captured yet, or an unknown session) must
    /// encode to the empty string — the frontend decodes that to a zero-length
    /// array and replays nothing.
    #[test]
    fn empty_scrollback_encodes_to_empty_string() {
        assert_eq!(encode_bytes_base64(&[]), "");
    }
}
