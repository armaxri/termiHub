//! When a local bash / zsh is really at its prompt, for typing the
//! shell-integration setup (#5452).
//!
//! The PTY leaving canonical mode is not enough: a startup file that asks a
//! one-key question (zsh's `compinit` "Ignore insecure directories and
//! continue [y]?", a framework's update prompt, bash's `read -n 1`) switches
//! it too, and the setup typed then is taken as the answer, the rest running
//! as a mangled command. What only the line editor does is turn on bracketed
//! paste (`ESC [?2004h`) when it starts reading a command line, and off
//! (`ESC [?2004l`) when it accepts one — ZLE since zsh 5.1, readline since
//! bash 5.1. For those shells the setup waits for that mark
//! ([`ReadySignal::PasteMark`]); older ones keep the canonical-mode cue.
//!
//! A shell whose bracketed paste was turned off by its user
//! (`unset zle_bracketed_paste`, `set enable-bracketed-paste off`) never
//! sends the mark, and the setup is then never typed: no integration is
//! better than input typed into a question.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::session::shell::shell_kind;

/// What tells that the shell waits at its prompt with an empty line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadySignal {
    /// The PTY left canonical mode (bash < 5.1 and other line editors that
    /// never announce bracketed paste).
    Canonical,
    /// The line editor turned bracketed paste on, after any input the user
    /// typed had been accepted as a line.
    PasteMark,
}

const PASTE_ON: &[u8] = b"\x1b[?2004h";
const PASTE_OFF: &[u8] = b"\x1b[?2004l";

/// Watches the shell's output (and the user's input) for the line editor's
/// bracketed-paste marks.
#[derive(Debug, Default)]
pub(crate) struct PasteGate {
    /// The end of the previous chunk, for a mark split across two.
    tail: Vec<u8>,
    /// The user typed before the setup was.
    input_seen: bool,
    /// Since that input, the line editor accepted a line.
    accepted_since_input: bool,
    ready: bool,
}

impl PasteGate {
    /// Note a chunk of shell output.
    pub(crate) fn feed(&mut self, data: &[u8]) {
        let mut joined = std::mem::take(&mut self.tail);
        joined.extend_from_slice(data);
        let mut i = 0;
        while i + PASTE_ON.len() <= joined.len() {
            let window = &joined[i..i + PASTE_ON.len()];
            if window == PASTE_ON {
                if !self.input_seen || self.accepted_since_input {
                    self.ready = true;
                }
                i += PASTE_ON.len();
            } else if window == PASTE_OFF {
                self.ready = false;
                if self.input_seen {
                    self.accepted_since_input = true;
                }
                i += PASTE_OFF.len();
            } else {
                i += 1;
            }
        }
        // Keep what could still start a mark.
        let keep = joined.len().saturating_sub(PASTE_ON.len() - 1).max(i);
        self.tail = joined.split_off(keep);
    }

    /// The user typed before the setup: it now waits for a fresh prompt
    /// after their input has been accepted, so it never lands in their line
    /// or in a question they are answering.
    pub(crate) fn note_input(&mut self) {
        self.input_seen = true;
        self.accepted_since_input = false;
        self.ready = false;
    }

    /// Whether the line editor reads a fresh command line.
    pub(crate) fn ready(&self) -> bool {
        self.ready
    }
}

/// The [`ReadySignal`] for `kind` given its `--version` output: bash and zsh
/// from 5.1 announce bracketed paste.
pub(crate) fn signal_from_version(kind: &str, version: &str) -> ReadySignal {
    let announces =
        matches!(kind, "bash" | "zsh") && parse_version(version).is_some_and(|v| v >= (5, 1));
    if announces {
        ReadySignal::PasteMark
    } else {
        ReadySignal::Canonical
    }
}

/// The first `major.minor` in `text` (`GNU bash, version 5.2.37(1)-release`,
/// `zsh 5.9 (arm64-apple-darwin)`).
fn parse_version(text: &str) -> Option<(u32, u32)> {
    text.split_whitespace().find_map(|token| {
        let mut parts = token.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor: String = parts
            .next()?
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        Some((major, minor.parse().ok()?))
    })
}

/// The [`ReadySignal`] for the shell `program`, from its `--version` (run
/// once per program and remembered). A shell that cannot tell keeps the
/// canonical-mode cue.
pub(crate) fn ready_signal(program: &str) -> ReadySignal {
    let kind = shell_kind(program);
    if !matches!(kind, "bash" | "zsh") {
        return ReadySignal::Canonical;
    }
    static CACHE: OnceLock<Mutex<HashMap<String, ReadySignal>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(signal) = cache.lock().ok().and_then(|c| c.get(program).copied()) {
        return signal;
    }
    let signal = std::process::Command::new(program)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| signal_from_version(kind, &String::from_utf8_lossy(&out.stdout)))
        .unwrap_or(ReadySignal::Canonical);
    if let Ok(mut c) = cache.lock() {
        c.insert(program.to_string(), signal);
    }
    signal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_from_51_announce_bracketed_paste() {
        let bash = |v: &str| signal_from_version("bash", v);
        assert_eq!(
            bash("GNU bash, version 5.2.37(1)-release (aarch64)"),
            ReadySignal::PasteMark
        );
        assert_eq!(
            bash("GNU bash, version 5.1.0(1)-release"),
            ReadySignal::PasteMark
        );
        assert_eq!(
            bash("GNU bash, version 5.0.17(1)-release"),
            ReadySignal::Canonical
        );
        assert_eq!(
            bash("GNU bash, version 3.2.57(1)-release (arm64-apple-darwin26)"),
            ReadySignal::Canonical
        );
        assert_eq!(
            signal_from_version("zsh", "zsh 5.9 (arm64-apple-darwin26.0)"),
            ReadySignal::PasteMark
        );
        assert_eq!(
            signal_from_version("zsh", "zsh 5.0.2 (x86_64)"),
            ReadySignal::Canonical
        );
        assert_eq!(signal_from_version("zsh", ""), ReadySignal::Canonical);
        assert_eq!(
            signal_from_version("fish", "fish, version 4.0.2"),
            ReadySignal::Canonical
        );
    }

    #[test]
    fn a_startup_question_is_not_a_prompt() {
        let mut g = PasteGate::default();
        g.feed(b"zsh compinit: insecure directories\r\nIgnore insecure directories and continue [y] or abort compinit [n]? ");
        assert!(!g.ready());
        g.feed(b"\r\n\x1b]7;file:///x\x07THPROMPT> \x1b[K\x1b[?1h\x1b=\x1b[?2004h");
        assert!(g.ready());
    }

    #[test]
    fn a_mark_split_across_chunks_is_seen() {
        let mut g = PasteGate::default();
        g.feed(b"prompt> \x1b[?20");
        assert!(!g.ready());
        g.feed(b"04h");
        assert!(g.ready());
    }

    #[test]
    fn accepting_a_line_ends_the_ready_state() {
        let mut g = PasteGate::default();
        g.feed(b"\x1b[?2004h");
        g.feed(b"\x1b[?2004l\r\n");
        assert!(!g.ready());
        g.feed(b"\x1b[?2004l\r\nout\r\n\x1b[?2004h");
        assert!(g.ready());
    }

    #[test]
    fn after_input_only_a_prompt_after_an_accepted_line_counts() {
        let mut g = PasteGate::default();
        // The user types (a partial line, or the answer to a question)
        // before the line editor starts.
        g.note_input();
        g.feed(b"prompt> \x1b[?2004h");
        assert!(!g.ready(), "their input may sit in this line");
        g.feed(b"ls\x1b[?2004l\r\nfile\r\nprompt> \x1b[?2004h");
        assert!(g.ready());
    }

    #[test]
    fn input_at_a_ready_prompt_resets_it() {
        let mut g = PasteGate::default();
        g.feed(b"\x1b[?2004h");
        g.note_input();
        assert!(!g.ready());
    }
}
