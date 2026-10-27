//! Tell from a shell's output alone that it waits at its prompt (#5029).
//!
//! The remote end of an SSH session cannot be asked whether its line editor
//! reads, so the session watches what the shell prints: a login shell is
//! idle exactly when it waits at its prompt. The rule is the SSH setup gate's
//! settle heuristic (`SETUP_GATE_SETTLE`), with one guard more: the output
//! must end mid-line, as a prompt does (`user@host:~$ `, `PS C:\>`). Output
//! that ends with a line break — a MOTD, an rc file's `echo` before a slow
//! `nvm` load — leaves the shell still starting, however long it is quiet.
//!
//! Escape sequences are not text: they neither end a line nor start one, and
//! output made of nothing else (a cwd report, a mode switch) is ignored.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long the output must stay quiet after a prompt-like end.
pub const PROMPT_SETTLE: Duration = Duration::from_millis(300);

/// Where the escape-sequence scanner stands between chunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Scan {
    #[default]
    Text,
    /// After `ESC`.
    Esc,
    /// In an `ESC` sequence's intermediate bytes (`ESC ( B`).
    EscIntermediate,
    /// In a CSI sequence (`ESC [ ... final`).
    Csi,
    /// In a string sequence (OSC, DCS, ...) ended by `BEL` or `ESC \`.
    Str,
    /// After an `ESC` inside a string sequence.
    StrEsc,
}

#[derive(Debug, Default)]
struct State {
    scan: Scan,
    /// When text was last printed, and whether it ended a line.
    last_text: Option<(Instant, bool)>,
}

/// Watches a session's output for a settled prompt; see the module docs.
#[derive(Debug, Default)]
pub struct OutputSettle {
    state: Mutex<State>,
}

impl OutputSettle {
    /// A tracker that has seen no output.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Note that the shell printed `data` at `now`.
    pub fn observe(&self, data: &[u8], now: Instant) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let mut ends_line = None;
        for &byte in data {
            state.scan = match (state.scan, byte) {
                (Scan::Text, 0x1b) => Scan::Esc,
                (Scan::Text, b'\n') => {
                    ends_line = Some(true);
                    Scan::Text
                }
                // Other C0 controls (CR, BS, BEL, ...) and DEL move the cursor
                // or ring; they print nothing.
                (Scan::Text, b) if b < 0x20 || b == 0x7f => Scan::Text,
                (Scan::Text, _) => {
                    ends_line = Some(false);
                    Scan::Text
                }
                (Scan::Esc, b'[') => Scan::Csi,
                (Scan::Esc, b']' | b'P' | b'X' | b'^' | b'_') => Scan::Str,
                (Scan::Esc | Scan::EscIntermediate, 0x20..=0x2f) => Scan::EscIntermediate,
                (Scan::Esc | Scan::EscIntermediate, _) => Scan::Text,
                (Scan::Csi, 0x40..=0x7e) => Scan::Text,
                (Scan::Csi, _) => Scan::Csi,
                (Scan::Str, 0x07) => Scan::Text,
                (Scan::Str, 0x1b) => Scan::StrEsc,
                (Scan::Str, _) => Scan::Str,
                (Scan::StrEsc, b'\\') => Scan::Text,
                (Scan::StrEsc, _) => Scan::Str,
            };
        }
        if let Some(ends_line) = ends_line {
            state.last_text = Some((now, ends_line));
        }
    }

    /// Whether the output ended mid-line and has been quiet for
    /// [`PROMPT_SETTLE`] by `now`.
    pub fn is_settled(&self, now: Instant) -> bool {
        self.state.lock().is_ok_and(|state| {
            matches!(state.last_text, Some((at, false)) if now.saturating_duration_since(at) >= PROMPT_SETTLE)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn nothing_printed_is_not_a_prompt() {
        let settle = OutputSettle::new();
        assert!(!settle.is_settled(Instant::now() + Duration::from_secs(60)));
    }

    #[test]
    fn a_prompt_settles_after_the_quiet_period() {
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"Welcome\r\n\x1b[?2004huser@host:~$ ", t0);
        assert!(!settle.is_settled(t0 + PROMPT_SETTLE - ms(1)));
        assert!(settle.is_settled(t0 + PROMPT_SETTLE));
    }

    #[test]
    fn output_ending_a_line_never_settles() {
        // A MOTD, then an rc file that sleeps before its prompt.
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"Last login: today\r\nRC-START\r\n", t0);
        assert!(!settle.is_settled(t0 + Duration::from_secs(5)));
        settle.observe(b"RC-DONE\r\nuser@host:~$ ", t0 + Duration::from_secs(2));
        assert!(!settle.is_settled(t0 + Duration::from_secs(2) + ms(299)));
        assert!(settle.is_settled(t0 + Duration::from_secs(2) + PROMPT_SETTLE));
    }

    #[test]
    fn new_output_restarts_the_quiet_period() {
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"loading", t0);
        settle.observe(b"...", t0 + ms(200));
        assert!(!settle.is_settled(t0 + ms(400)));
        assert!(settle.is_settled(t0 + ms(500)));
    }

    #[test]
    fn escape_only_output_is_ignored() {
        // A cwd report and a mode switch after the rc's line break must not
        // pass for a prompt, nor push a real prompt's settle back.
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"RC-START\r\n", t0);
        settle.observe(b"\x1b]7;file://host/home/u\x07\x1b[?2004h", t0 + ms(10));
        assert!(!settle.is_settled(t0 + Duration::from_secs(5)));

        settle.observe(b"$ ", t0 + Duration::from_secs(6));
        settle.observe(
            b"\x1b]7;file://host/tmp\x1b\\",
            t0 + Duration::from_secs(6) + ms(200),
        );
        assert!(settle.is_settled(t0 + Duration::from_secs(6) + PROMPT_SETTLE));
    }

    #[test]
    fn sequences_split_over_chunks_are_still_skipped() {
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"motd\r\n\x1b]7;file://ho", t0);
        settle.observe(b"st/x\x07\x1b[3", t0);
        settle.observe(b"2m", t0);
        assert!(!settle.is_settled(t0 + Duration::from_secs(1)));
    }

    #[test]
    fn a_trailing_carriage_return_keeps_the_line_state() {
        // zsh's PROMPT_SP ends with `\r` before it draws the prompt.
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(b"done\r\n%   \r \r", t0);
        assert!(settle.is_settled(t0 + PROMPT_SETTLE));
        settle.observe(b"ok\r\n\r", t0);
        assert!(!settle.is_settled(t0 + PROMPT_SETTLE));
    }

    #[test]
    fn a_windows_prompt_settles() {
        let t0 = Instant::now();
        let settle = OutputSettle::new();
        settle.observe(
            b"\x1b[2J\x1b[HMicrosoft Windows\r\n\r\nC:\\Users\\t>\x1b[?25h",
            t0,
        );
        assert!(settle.is_settled(t0 + PROMPT_SETTLE));
    }
}
