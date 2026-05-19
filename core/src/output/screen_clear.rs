/// The standard screen-clear sequence: ESC[2J (erase entire display) followed by
/// ESC[H (cursor home).
const SCREEN_CLEAR_SEQ: &[u8] = b"\x1b[2J\x1b[H";

/// The erase-display sequence alone: ESC[2J.
const ERASE_DISPLAY_SEQ: &[u8] = b"\x1b[2J";

/// Detect whether `data` contains an ANSI screen-clear sequence.
///
/// Checks for both the full `ESC[2J ESC[H` (erase display + cursor home) and
/// the standalone `ESC[2J` (erase display). The sequence can appear anywhere
/// in the data — it does not need to be at the start.
pub fn contains_screen_clear(data: &[u8]) -> bool {
    contains_subsequence(data, SCREEN_CLEAR_SEQ) || contains_subsequence(data, ERASE_DISPLAY_SEQ)
}

/// Check whether `haystack` contains `needle` as a contiguous subsequence.
fn contains_subsequence(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_full_clear_sequence() {
        let data = b"\x1b[2J\x1b[H";
        assert!(contains_screen_clear(data));
    }

    #[test]
    fn detects_erase_display_alone() {
        let data = b"\x1b[2J";
        assert!(contains_screen_clear(data));
    }

    #[test]
    fn detects_clear_embedded_in_data() {
        let mut data = Vec::new();
        data.extend_from_slice(b"some output before ");
        data.extend_from_slice(b"\x1b[2J\x1b[H");
        data.extend_from_slice(b" and after");
        assert!(contains_screen_clear(&data));
    }

    #[test]
    fn detects_erase_display_embedded_in_data() {
        let mut data = Vec::new();
        data.extend_from_slice(b"prefix ");
        data.extend_from_slice(b"\x1b[2J");
        data.extend_from_slice(b" suffix");
        assert!(contains_screen_clear(&data));
    }

    #[test]
    fn no_match_on_empty_data() {
        assert!(!contains_screen_clear(b""));
    }

    #[test]
    fn no_match_on_plain_text() {
        assert!(!contains_screen_clear(b"hello world"));
    }

    #[test]
    fn no_match_on_partial_escape() {
        // Just ESC[ without the rest
        assert!(!contains_screen_clear(b"\x1b["));
    }

    #[test]
    fn no_match_on_incomplete_sequence() {
        // ESC[2 without J
        assert!(!contains_screen_clear(b"\x1b[2"));
    }

    #[test]
    fn no_match_on_wrong_escape() {
        // ESC[1J is erase from cursor to beginning, not erase all
        assert!(!contains_screen_clear(b"\x1b[1J\x1b[H"));
    }

    #[test]
    fn detects_clear_at_start() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[2J\x1b[H");
        data.extend_from_slice(b"welcome to the shell");
        assert!(contains_screen_clear(&data));
    }

    #[test]
    fn detects_clear_at_end() {
        let mut data = Vec::new();
        data.extend_from_slice(b"initializing...");
        data.extend_from_slice(b"\x1b[2J\x1b[H");
        assert!(contains_screen_clear(&data));
    }

    // --- Regression tests for behavior the substring scanner gets wrong.
    // These currently fail and will pass once the detector is replaced with a
    // real VT parser (see #729).

    #[test]
    fn detects_clear_plus_scrollback_param_3() {
        // CSI 3 J — xterm extension that erases display and scrollback. The
        // user sees a fully cleared terminal, so we should treat it as a clear.
        assert!(contains_screen_clear(b"\x1b[3J"));
    }

    #[test]
    fn does_not_false_positive_inside_osc_payload() {
        // The bytes \x1b[2J appearing inside an OSC string (e.g. a window title)
        // must not be treated as a CSI clear. A real VT parser stays in OSC
        // state until ST/BEL and never dispatches the inner bytes as CSI.
        let payload = b"\x1b]0;title \x1b[2J fake\x07rest";
        assert!(!contains_screen_clear(payload));
    }
}
