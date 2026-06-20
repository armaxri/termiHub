//! Line-ending normalization for terminal input.
//!
//! termiHub translates the Enter keystroke and pasted text to a configurable
//! line ending (PuTTY-style) so that, for example, pasting Windows CRLF text
//! into a Unix SSH or serial session does not insert a blank line between every
//! row. Normalization happens at the single [`send_input`] choke point in the
//! session manager so every input path is covered, regardless of caller.
//!
//! [`send_input`]: super::manager::SessionManager::send_input

/// Line ending sent on Enter and used to normalize pasted text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineEnding {
    /// Carriage return (`\r`) — classic terminal behavior.
    Cr,
    /// Line feed (`\n`) — typical Unix. The default.
    #[default]
    Lf,
    /// Carriage return + line feed (`\r\n`) — Windows-style.
    Crlf,
}

impl LineEnding {
    /// Parse the frontend string form (`"cr"`, `"lf"`, `"crlf"`). Anything else
    /// — including `None` — resolves to the default ([`LineEnding::Lf`]).
    pub fn from_opt_str(value: Option<&str>) -> Self {
        match value {
            Some("cr") => LineEnding::Cr,
            Some("crlf") => LineEnding::Crlf,
            _ => LineEnding::Lf,
        }
    }

    /// The raw byte sequence this line ending emits.
    fn sequence(self) -> &'static [u8] {
        match self {
            LineEnding::Cr => b"\r",
            LineEnding::Lf => b"\n",
            LineEnding::Crlf => b"\r\n",
        }
    }
}

/// Normalize every line break in `data` to `ending`.
///
/// Each CRLF, lone CR, or lone LF becomes exactly one target ending — this is
/// what prevents Windows `\r\n` from being interpreted as two line breaks (the
/// blank-line-between-rows paste bug). Bytes that are not CR/LF are passed
/// through unchanged; because CR and LF never appear inside a multi-byte UTF-8
/// sequence, this is safe for UTF-8 text.
pub fn normalize_line_endings(data: &[u8], ending: LineEnding) -> Vec<u8> {
    // Fast path: most keystrokes are a single printable byte with no line break.
    if !data.iter().any(|&b| b == b'\r' || b == b'\n') {
        return data.to_vec();
    }

    let seq = ending.sequence();
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            b'\r' => {
                out.extend_from_slice(seq);
                // Collapse a CRLF pair so it does not produce two endings.
                if data.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
            }
            b'\n' => out.extend_from_slice(seq),
            other => out.push(other),
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_opt_str_parses_known_values() {
        assert_eq!(LineEnding::from_opt_str(Some("cr")), LineEnding::Cr);
        assert_eq!(LineEnding::from_opt_str(Some("lf")), LineEnding::Lf);
        assert_eq!(LineEnding::from_opt_str(Some("crlf")), LineEnding::Crlf);
    }

    #[test]
    fn from_opt_str_defaults_to_cr() {
        // CR (`\r`) is the standard terminal Enter byte. Defaulting to LF would
        // rewrite Enter to `\n`, which Windows ConPTY — and shells on macOS — do
        // not treat as "submit", so commands never run (the Enter-key regression).
        assert_eq!(LineEnding::from_opt_str(None), LineEnding::Cr);
        assert_eq!(LineEnding::from_opt_str(Some("bogus")), LineEnding::Cr);
        assert_eq!(LineEnding::default(), LineEnding::Cr);
    }

    #[test]
    fn bare_enter_stays_cr_by_default() {
        // Regression guard: the Enter keystroke (xterm sends `\r`) must reach the
        // PTY as `\r`, not `\n`, when no line ending is configured.
        assert_eq!(normalize_line_endings(b"\r", LineEnding::default()), b"\r");
    }

    #[test]
    fn crlf_collapses_to_single_lf() {
        // The core bug: Windows CRLF must not become two line breaks.
        assert_eq!(
            normalize_line_endings(b"a\r\nb\r\nc", LineEnding::Lf),
            b"a\nb\nc"
        );
    }

    #[test]
    fn lone_lf_to_crlf() {
        assert_eq!(
            normalize_line_endings(b"a\nb\nc", LineEnding::Crlf),
            b"a\r\nb\r\nc"
        );
    }

    #[test]
    fn lone_cr_to_lf() {
        assert_eq!(
            normalize_line_endings(b"a\rb\rc", LineEnding::Lf),
            b"a\nb\nc"
        );
    }

    #[test]
    fn bare_enter_keystroke_is_translated() {
        assert_eq!(normalize_line_endings(b"\r", LineEnding::Lf), b"\n");
        assert_eq!(normalize_line_endings(b"\r", LineEnding::Crlf), b"\r\n");
        assert_eq!(normalize_line_endings(b"\r", LineEnding::Cr), b"\r");
    }

    #[test]
    fn mixed_endings_collapse_to_one_each() {
        assert_eq!(
            normalize_line_endings(b"a\r\nb\nc\rd", LineEnding::Lf),
            b"a\nb\nc\nd"
        );
        assert_eq!(
            normalize_line_endings(b"a\r\nb\nc\rd", LineEnding::Crlf),
            b"a\r\nb\r\nc\r\nd"
        );
    }

    #[test]
    fn text_without_breaks_is_untouched() {
        assert_eq!(
            normalize_line_endings(b"plain text", LineEnding::Crlf),
            b"plain text"
        );
        assert_eq!(normalize_line_endings(b"", LineEnding::Lf), b"");
    }

    #[test]
    fn utf8_multibyte_bytes_are_preserved() {
        // "héllo\r\n" — the é is two bytes (0xC3 0xA9), neither CR nor LF.
        let input = "héllo\r\n".as_bytes();
        assert_eq!(
            normalize_line_endings(input, LineEnding::Lf),
            "héllo\n".as_bytes()
        );
    }
}
