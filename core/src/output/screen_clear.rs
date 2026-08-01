use vte::{Params, Parser, Perform};

/// Detects ANSI screen-clear sequences in a stream of terminal output.
///
/// Parser state is retained across `feed` calls, so escape sequences that span
/// chunk boundaries are detected correctly. Recognized as a screen clear:
///
/// - `CSI 2 J` — erase entire display
/// - `CSI 3 J` — erase display + scrollback (xterm extension)
///
/// Other `CSI n J` variants (`0`, `1`, default) are not treated as a clear.
pub struct ScreenClearDetector {
    parser: Parser,
}

impl ScreenClearDetector {
    pub fn new() -> Self {
        Self {
            parser: Parser::new(),
        }
    }

    /// Feed a chunk of output bytes. Returns `true` if a full screen-clear
    /// was dispatched anywhere within this chunk.
    pub fn feed(&mut self, data: &[u8]) -> bool {
        let mut hit = Hit(false);
        for &byte in data {
            self.parser.advance(&mut hit, byte);
        }
        hit.0
    }
}

impl Default for ScreenClearDetector {
    fn default() -> Self {
        Self::new()
    }
}

struct Hit(bool);

impl Perform for Hit {
    fn csi_dispatch(&mut self, params: &Params, _intermediates: &[u8], _ignore: bool, c: char) {
        if c != 'J' {
            return;
        }
        let n = params
            .iter()
            .next()
            .and_then(|p| p.first().copied())
            .unwrap_or(0);
        if n == 2 || n == 3 {
            self.0 = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_once(data: &[u8]) -> bool {
        ScreenClearDetector::new().feed(data)
    }

    #[test]
    fn detects_full_clear_sequence() {
        assert!(feed_once(b"\x1b[2J\x1b[H"));
    }

    #[test]
    fn detects_erase_display_alone() {
        assert!(feed_once(b"\x1b[2J"));
    }

    #[test]
    fn detects_clear_embedded_in_data() {
        assert!(feed_once(b"some output before \x1b[2J\x1b[H and after"));
    }

    #[test]
    fn detects_erase_display_embedded_in_data() {
        assert!(feed_once(b"prefix \x1b[2J suffix"));
    }

    #[test]
    fn no_match_on_empty_data() {
        assert!(!feed_once(b""));
    }

    #[test]
    fn no_match_on_plain_text() {
        assert!(!feed_once(b"hello world"));
    }

    #[test]
    fn no_match_on_partial_escape() {
        assert!(!feed_once(b"\x1b["));
    }

    #[test]
    fn no_match_on_incomplete_sequence() {
        assert!(!feed_once(b"\x1b[2"));
    }

    #[test]
    fn no_match_on_erase_above_cursor() {
        assert!(!feed_once(b"\x1b[1J\x1b[H"));
    }

    #[test]
    fn no_match_on_erase_below_cursor() {
        assert!(!feed_once(b"\x1b[0J"));
    }

    #[test]
    fn no_match_on_default_param() {
        // CSI J with no param defaults to 0 — erase below cursor, not a clear.
        assert!(!feed_once(b"\x1b[J"));
    }

    #[test]
    fn detects_clear_at_start() {
        assert!(feed_once(b"\x1b[2J\x1b[Hwelcome to the shell"));
    }

    #[test]
    fn detects_clear_at_end() {
        assert!(feed_once(b"initializing...\x1b[2J\x1b[H"));
    }

    #[test]
    fn detects_clear_plus_scrollback_param_3() {
        // CSI 3 J — xterm extension that erases display and scrollback.
        assert!(feed_once(b"\x1b[3J"));
    }

    #[test]
    fn detects_sequence_split_across_chunks() {
        let mut d = ScreenClearDetector::new();
        assert!(!d.feed(b"\x1b["));
        assert!(d.feed(b"2J"));
    }

    #[test]
    fn detects_sequence_split_after_esc() {
        let mut d = ScreenClearDetector::new();
        assert!(!d.feed(b"\x1b"));
        assert!(d.feed(b"[2J"));
    }

    #[test]
    fn detects_sequence_split_before_final_byte() {
        let mut d = ScreenClearDetector::new();
        assert!(!d.feed(b"\x1b[2"));
        assert!(d.feed(b"J"));
    }

    #[test]
    fn state_persists_across_multiple_feeds_without_clear() {
        let mut d = ScreenClearDetector::new();
        assert!(!d.feed(b"hello "));
        assert!(!d.feed(b"world"));
        assert!(d.feed(b"\x1b[2J"));
    }

    #[test]
    fn detects_ris_full_reset() {
        // ESC c (RIS) resets the terminal, clearing the visible screen.
        assert!(feed_once(b"\x1bc"));
    }

    #[test]
    fn detects_ris_embedded_in_data() {
        assert!(feed_once(b"before \x1bc after"));
    }

    #[test]
    fn detects_ris_split_across_chunks() {
        let mut d = ScreenClearDetector::new();
        assert!(!d.feed(b"\x1b"));
        assert!(d.feed(b"c"));
    }

    #[test]
    fn no_match_on_esc_with_intermediate() {
        // ESC ( B designates the ASCII charset — an ESC sequence with an
        // intermediate byte, not a reset. It must not count as a clear.
        assert!(!feed_once(b"\x1b(B"));
    }

    #[test]
    fn no_match_on_plain_lowercase_c() {
        // A bare 'c' with no preceding ESC is ordinary output, not RIS.
        assert!(!feed_once(b"c"));
    }
}
