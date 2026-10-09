//! Detect the OSC 133 prompt-start mark in terminal output.
//!
//! termiHub's shell integration makes bash, zsh, fish and PowerShell print
//! `ESC ] 133 ; A` each time they draw a prompt. Seeing it means the shell has
//! finished starting (and has run the integration setup), so it is ready to
//! read a command. The desktop uses it to time a connection's initial command
//! instead of a blind delay (#4345).

/// The OSC 133 prompt-start introducer: `ESC ] 133 ; A`.
const PROMPT_START: &[u8] = b"\x1b]133;A";

/// Finds the OSC 133 prompt-start mark in a stream of output chunks.
///
/// Match state is kept across `feed` calls, so a mark split over chunk
/// boundaries is still found. Other OSC 133 marks (`B`, `C`, `D`) and other
/// OSC sequences are ignored.
#[derive(Debug, Default)]
pub struct PromptMarkDetector {
    matched: usize,
}

impl PromptMarkDetector {
    /// A detector that has not seen any output yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of output. Returns `true` if a prompt-start mark
    /// completed anywhere within this chunk.
    pub fn feed(&mut self, data: &[u8]) -> bool {
        let mut hit = false;
        for &byte in data {
            if byte == PROMPT_START[self.matched] {
                self.matched += 1;
            } else {
                // ESC only occurs at the start of the needle, so a mismatch
                // can only restart the match on a fresh ESC.
                self.matched = usize::from(byte == PROMPT_START[0]);
            }
            if self.matched == PROMPT_START.len() {
                hit = true;
                self.matched = 0;
            }
        }
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_once(data: &[u8]) -> bool {
        PromptMarkDetector::new().feed(data)
    }

    #[test]
    fn detects_prompt_start_with_bel_terminator() {
        assert!(feed_once(b"\x1b]133;A\x07user@host:~$ "));
    }

    #[test]
    fn detects_prompt_start_with_st_terminator() {
        assert!(feed_once(b"motd\r\n\x1b]133;A\x1b\\% "));
    }

    #[test]
    fn detects_prompt_start_after_other_marks() {
        assert!(feed_once(
            b"\x1b]133;D;0\x07\x1b]7;file:///tmp\x07\x1b]133;A\x07$ "
        ));
    }

    #[test]
    fn ignores_other_osc133_marks() {
        assert!(!feed_once(b"\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07"));
    }

    #[test]
    fn ignores_plain_text_and_other_osc() {
        assert!(!feed_once(b"hello \x1b]7;file:///tmp\x07 133;A"));
    }

    #[test]
    fn ignores_the_echoed_setup_text() {
        // The shell echoes the typed integration setup, which spells the mark
        // as the literal characters `\e]133;A` rather than an ESC byte.
        assert!(!feed_once(br"printf '\e]133;A\a'"));
    }

    #[test]
    fn detects_mark_split_across_chunks() {
        let mut d = PromptMarkDetector::new();
        assert!(!d.feed(b"out\x1b"));
        assert!(!d.feed(b"]13"));
        assert!(d.feed(b"3;A\x07"));
    }

    #[test]
    fn restarts_on_esc_after_partial_match() {
        let mut d = PromptMarkDetector::new();
        assert!(!d.feed(b"\x1b]13"));
        assert!(d.feed(b"\x1b]133;A"));
    }
}
