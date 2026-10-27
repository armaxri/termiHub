//! Whether a bash ran the shell-integration setup it was handed through its
//! environment, judged from its output (#5014).
//!
//! The setup prints OSC 133 `A` for the first prompt, so seeing that mark
//! means it ran. When it never shows — an rc replaced `PROMPT_COMMAND` and
//! with it the bootstrap — the setup has to be typed after all, once the
//! shell sits at its first prompt: its output has shown text and then gone
//! quiet for [`PROMPT_QUIET`]. Escape sequences alone (ConPTY paints its
//! screen before the shell even starts) do not count as text.

use std::time::{Duration, Instant};

/// Output quiet this long after the shell's first text means it is waiting
/// at its prompt.
pub(crate) const PROMPT_QUIET: Duration = Duration::from_secs(3);

/// The longest wait before typing the setup anyway: a cold Git Bash on a
/// loaded machine can take many seconds to its first prompt.
pub(crate) const BOOTSTRAP_CAP: Duration = Duration::from_secs(30);

/// The mark the setup prints before the first prompt.
const PROMPT_MARK: &[u8] = b"\x1b]133;A";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Esc {
    None,
    Start,
    Csi,
    Osc,
    OscEnd,
}

/// What [`PromptWatch::verdict`] decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Keep waiting.
    Wait,
    /// The shell ran the setup itself; nothing to type.
    Ran,
    /// The shell is at its prompt without the setup; type it.
    Type,
}

/// Watches a shell's output for the bootstrapped setup.
#[derive(Debug)]
pub(crate) struct PromptWatch {
    started: Instant,
    /// The end of the previous chunk, for a mark split across two.
    tail: Vec<u8>,
    esc: Esc,
    ran: bool,
    /// When the last chunk arrived, once any text has been seen.
    last_text_output: Option<Instant>,
    text_seen: bool,
}

impl PromptWatch {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            started: now,
            tail: Vec::new(),
            esc: Esc::None,
            ran: false,
            last_text_output: None,
            text_seen: false,
        }
    }

    /// Note a chunk of output that arrived at `now`.
    pub(crate) fn feed(&mut self, data: &[u8], now: Instant) {
        if self.ran {
            return;
        }
        let mut joined = std::mem::take(&mut self.tail);
        joined.extend_from_slice(data);
        if joined.windows(PROMPT_MARK.len()).any(|w| w == PROMPT_MARK) {
            self.ran = true;
            return;
        }
        let keep = joined.len().saturating_sub(PROMPT_MARK.len() - 1);
        self.tail = joined.split_off(keep);
        for &b in data {
            self.step(b);
        }
        if self.text_seen {
            self.last_text_output = Some(now);
        }
    }

    fn step(&mut self, b: u8) {
        self.esc = match (self.esc, b) {
            (Esc::None, 0x1b) => Esc::Start,
            (Esc::None, b) => {
                if b.is_ascii_graphic() || b >= 0x80 {
                    self.text_seen = true;
                }
                Esc::None
            }
            (Esc::Start, b'[') => Esc::Csi,
            (Esc::Start, b']') => Esc::Osc,
            (Esc::Start, _) => Esc::None,
            (Esc::Csi, 0x40..=0x7e) => Esc::None,
            (Esc::Csi, _) => Esc::Csi,
            (Esc::Osc, 0x07) => Esc::None,
            (Esc::Osc, 0x1b) => Esc::OscEnd,
            (Esc::Osc, _) => Esc::Osc,
            (Esc::OscEnd, b'\\') => Esc::None,
            (Esc::OscEnd, _) => Esc::Osc,
        };
    }

    /// Decide at `now`.
    pub(crate) fn verdict(&self, now: Instant) -> Verdict {
        if self.ran {
            return Verdict::Ran;
        }
        let quiet = self
            .last_text_output
            .is_some_and(|t| now.duration_since(t) >= PROMPT_QUIET);
        if quiet || now.duration_since(self.started) >= BOOTSTRAP_CAP {
            Verdict::Type
        } else {
            Verdict::Wait
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn the_prompt_mark_means_the_setup_ran() {
        let t = Instant::now();
        let mut w = PromptWatch::new(t);
        w.feed(b"banner\r\n\x1b]7;file:///c/x\x07\x1b]133;A\x07$ ", t);
        assert_eq!(w.verdict(t + 10 * S), Verdict::Ran);
    }

    #[test]
    fn a_mark_split_across_chunks_is_seen() {
        let t = Instant::now();
        let mut w = PromptWatch::new(t);
        w.feed(b"banner\x1b]13", t);
        w.feed(b"3;A\x07$ ", t);
        assert_eq!(w.verdict(t + 10 * S), Verdict::Ran);
    }

    #[test]
    fn quiet_after_text_without_the_mark_types_the_setup() {
        let t = Instant::now();
        let mut w = PromptWatch::new(t);
        w.feed(b"banner\r\n$ ", t + S);
        assert_eq!(w.verdict(t + 2 * S), Verdict::Wait);
        assert_eq!(w.verdict(t + S + PROMPT_QUIET), Verdict::Type);
    }

    #[test]
    fn escape_sequences_alone_do_not_start_the_quiet_clock() {
        let t = Instant::now();
        // ConPTY's first paint, before bash has started.
        let mut w = PromptWatch::new(t);
        w.feed(b"\x1b[?9001h\x1b[?1004h\x1b[H\x1b[2J\x1b]0;title\x07", t);
        assert_eq!(w.verdict(t + 2 * PROMPT_QUIET), Verdict::Wait);
        assert_eq!(w.verdict(t + BOOTSTRAP_CAP), Verdict::Type);
    }

    #[test]
    fn later_output_restarts_the_quiet_clock() {
        let t = Instant::now();
        let mut w = PromptWatch::new(t);
        w.feed(b"loading", t);
        w.feed(b"\x1b[K", t + 2 * S);
        assert_eq!(w.verdict(t + PROMPT_QUIET), Verdict::Wait);
        assert_eq!(w.verdict(t + 2 * S + PROMPT_QUIET), Verdict::Type);
    }
}
