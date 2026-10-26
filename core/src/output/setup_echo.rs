//! Hide termiHub's own typed shell-integration setup from the terminal (#5009).
//!
//! Shell integration (OSC 7 CWD tracking, OSC 133 command marks) is a shell
//! snippet. Where it cannot be passed as a startup argument — a local bash or
//! zsh login shell, and every remote POSIX shell over SSH — it is *typed* into
//! the shell, so the line editor echoes it: a ~1 KB line of shell code above
//! the user's first prompt.
//!
//! [`SetupEchoFilter`] removes exactly that, and nothing else. It is armed at
//! the moment the setup is typed and holds the output back until the setup
//! prints its own end mark ([`SETUP_DONE_MARK`], emitted as the snippet's last
//! statement). Then it decides from the held bytes alone:
//!
//! - **Recognised.** The held output, from some point on, is nothing but the
//!   echo of the typed text (plus escape sequences and whitespace). Everything
//!   before that point — MOTD, rc-file output, the first prompt — is emitted
//!   untouched. The echo, the setup's own output and the end mark are dropped.
//!   The row of the first prompt is then cleared, so the shell's next prompt
//!   (drawn by the now-integrated shell, with its OSC 133 marks) takes its
//!   place instead of appearing twice. The number of rows cleared is taken
//!   from that next prompt (its newlines between OSC 133 `A` and `B`), so a
//!   two-line prompt is replaced as a whole.
//! - **Not recognised.** Anything else in the region the echo would be in —
//!   user output, an error from the setup, a second unrelated line — and the
//!   filter emits *everything* it held, unchanged. The worst case is the old
//!   behaviour (the setup line visible), never hidden user output.
//! - **No end mark.** After [`SETUP_HIDE_CAP`] (or [`SETUP_HIDE_MAX_BYTES`])
//!   everything held is emitted. Output is delayed, never dropped.
//!
//! The decision needs no timer and no screen-clear detection: both ends of the
//! hidden region come from the stream itself (the echo of our own bytes, and
//! our own end mark). The caps only bound the delay when the shell never runs
//! the setup.
//!
//! # Where it is used
//!
//! Only on Unix pseudo-terminals with a POSIX line editor (readline, ZLE):
//! the local bash/zsh backend and SSH sessions to a POSIX login shell, on the
//! desktop and on the agent alike. It is **not** used behind a Windows
//! ConPTY (local Git Bash, WSL, SSH to a Windows host): ConPTY repaints from
//! its own screen model, and dropping part of its output would desynchronise
//! that model from the terminal.

use std::time::{Duration, Instant};

/// The mark the setup snippet prints as its very last statement:
/// `ESC ] 6973 ; termihub-setup-done BEL`. An OSC no terminal implements, so
/// it is invisible even where no filter strips it.
pub const SETUP_DONE_MARK: &[u8] = b"\x1b]6973;termihub-setup-done\x07";

/// The same mark as a POSIX `printf` statement, for the setup snippets.
pub const SETUP_DONE_PRINTF: &str = r"printf '\e]6973;termihub-setup-done\a'";

/// Upper bound on holding output back while waiting for the setup's end mark.
/// The setup runs in milliseconds once typed at a prompt; this only matters
/// when the shell never runs it.
pub const SETUP_HIDE_CAP: Duration = Duration::from_secs(4);

/// Upper bound on the bytes held while waiting for the end mark.
pub const SETUP_HIDE_MAX_BYTES: usize = 256 * 1024;

/// After the end mark, how long the next prompt may stay quiet before it
/// counts as fully drawn (when its prompt-end mark `B` never comes).
pub const REPROMPT_QUIET: Duration = Duration::from_millis(150);

/// Upper bound on holding the next prompt back to measure it.
pub const REPROMPT_CAP: Duration = Duration::from_millis(1000);

/// OSC 133 prompt start (`A`) and input start (`B`).
const PROMPT_START: &[u8] = b"\x1b]133;A";
const INPUT_START: &[u8] = b"\x1b]133;B";

/// Clear the cursor's row and return to its first column.
const ERASE_ROW: &[u8] = b"\r\x1b[2K";
/// Move one row up and clear it.
const ERASE_ROW_ABOVE: &[u8] = b"\x1b[1A\x1b[2K";

/// How a hide attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HideOutcome {
    /// The echo was recognised and removed.
    Hidden,
    /// The end mark came, but the held output was not just our echo: all of
    /// it was shown.
    NotRecognised,
    /// No end mark within the cap: all of it was shown.
    TimedOut,
}

#[derive(Debug)]
enum Phase {
    /// Every byte passes straight through.
    Pass,
    /// The setup was typed; output is held until its end mark.
    Hold {
        /// The typed text, whitespace and control characters removed.
        typed: Vec<u8>,
        buf: Vec<u8>,
        deadline: Instant,
    },
    /// The echo was removed; the next prompt is held until it is measured.
    Reprompt {
        buf: Vec<u8>,
        deadline: Instant,
        last_output: Instant,
    },
}

/// Removes the echo of a typed setup line from a terminal output stream. See
/// the module docs.
#[derive(Debug)]
pub struct SetupEchoFilter {
    phase: Phase,
    outcome: Option<HideOutcome>,
    finished: bool,
}

impl Default for SetupEchoFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl SetupEchoFilter {
    /// A filter that passes everything through until [`arm`](Self::arm)ed.
    #[must_use]
    pub fn new() -> Self {
        Self {
            phase: Phase::Pass,
            outcome: None,
            finished: false,
        }
    }

    /// Start hiding: `typed` is about to be written to the shell. Arming again
    /// while holding (a second setup line, or the same setup typed again)
    /// extends the text the echo may consist of; the deadline stays.
    pub fn arm(&mut self, typed: &[u8], now: Instant) {
        match &mut self.phase {
            Phase::Pass if self.outcome.is_none() => {
                self.phase = Phase::Hold {
                    typed: significant(typed),
                    buf: Vec::new(),
                    deadline: now + SETUP_HIDE_CAP,
                };
            }
            Phase::Hold { typed: t, .. } => t.extend(significant(typed)),
            // One hide per session: a later setup is shown as typed.
            _ => {}
        }
    }

    /// Whether output is being held back.
    pub fn is_active(&self) -> bool {
        !matches!(self.phase, Phase::Pass)
    }

    /// How the hide ended, once it has.
    pub fn outcome(&self) -> Option<HideOutcome> {
        self.outcome
    }

    /// `true` exactly once, after the setup has finished (its end mark came)
    /// or the hide gave up.
    pub fn take_finished(&mut self) -> bool {
        std::mem::take(&mut self.finished)
    }

    /// When [`poll`](Self::poll) must next run, while active.
    pub fn next_deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Pass => None,
            Phase::Hold { deadline, .. } => Some(*deadline),
            Phase::Reprompt {
                deadline,
                last_output,
                ..
            } => Some((*last_output + REPROMPT_QUIET).min(*deadline)),
        }
    }

    /// Feed a chunk of shell output; returns the bytes to show now.
    pub fn feed(&mut self, data: &[u8], now: Instant) -> Vec<u8> {
        match &mut self.phase {
            Phase::Pass => data.to_vec(),
            Phase::Hold { buf, .. } => {
                buf.extend_from_slice(data);
                if find(buf, SETUP_DONE_MARK).is_some() {
                    self.on_done(now)
                } else if buf.len() > SETUP_HIDE_MAX_BYTES {
                    self.give_up()
                } else {
                    self.poll(now)
                }
            }
            Phase::Reprompt {
                buf, last_output, ..
            } => {
                buf.extend_from_slice(data);
                *last_output = now;
                self.resolve_reprompt(now, false)
            }
        }
    }

    /// Emit whatever a deadline releases (see [`next_deadline`](Self::next_deadline)).
    pub fn poll(&mut self, now: Instant) -> Vec<u8> {
        match &self.phase {
            Phase::Pass => Vec::new(),
            Phase::Hold { deadline, .. } => {
                if now >= *deadline {
                    self.give_up()
                } else {
                    Vec::new()
                }
            }
            Phase::Reprompt { .. } => self.resolve_reprompt(now, true),
        }
    }

    /// Show everything held: the hide did not happen.
    fn give_up(&mut self) -> Vec<u8> {
        let Phase::Hold { buf, .. } = std::mem::replace(&mut self.phase, Phase::Pass) else {
            return Vec::new();
        };
        self.outcome = Some(HideOutcome::TimedOut);
        self.finished = true;
        buf
    }

    /// The end mark is in the held output: cut the echo or show it all.
    fn on_done(&mut self, now: Instant) -> Vec<u8> {
        let Phase::Hold { typed, buf, .. } = std::mem::replace(&mut self.phase, Phase::Pass) else {
            return Vec::new();
        };
        self.finished = true;
        let Some(idx) = find(&buf, SETUP_DONE_MARK) else {
            // Only called once the mark is in `buf`; show everything if not.
            self.outcome = Some(HideOutcome::NotRecognised);
            return buf;
        };
        let (pre, post) = (&buf[..idx], &buf[idx + SETUP_DONE_MARK.len()..]);
        match echo_start(pre, &typed) {
            Some(start) => {
                self.outcome = Some(HideOutcome::Hidden);
                let shown = pre[..start].to_vec();
                self.phase = Phase::Reprompt {
                    buf: post.to_vec(),
                    deadline: now + REPROMPT_CAP,
                    last_output: now,
                };
                let mut out = shown;
                out.extend(self.resolve_reprompt(now, false));
                out
            }
            None => {
                self.outcome = Some(HideOutcome::NotRecognised);
                let mut out = pre.to_vec();
                out.extend_from_slice(post);
                out
            }
        }
    }

    /// Once the next prompt is measurable, clear the first prompt's rows and
    /// release the held prompt. `timer` says a deadline (not output) woke us.
    fn resolve_reprompt(&mut self, now: Instant, timer: bool) -> Vec<u8> {
        let Phase::Reprompt {
            buf,
            deadline,
            last_output,
        } = &self.phase
        else {
            return Vec::new();
        };
        let prompt = find(buf, PROMPT_START).map(|a| a + PROMPT_START.len());
        let rows = match prompt {
            Some(a) => match find(&buf[a..], INPUT_START) {
                // The prompt is complete: count its line breaks.
                Some(b) => Some(count_newlines(&buf[a..a + b])),
                None if timer && now >= *last_output + REPROMPT_QUIET => {
                    Some(count_newlines(&buf[a..]))
                }
                None => None,
            },
            None => None,
        };
        let rows = match rows {
            Some(rows) => rows,
            None if timer && now >= *deadline => prompt.map_or(0, |a| count_newlines(&buf[a..])),
            None => return Vec::new(),
        };
        let Phase::Reprompt { buf, .. } = std::mem::replace(&mut self.phase, Phase::Pass) else {
            return Vec::new();
        };
        let mut out = ERASE_ROW.to_vec();
        for _ in 0..rows {
            out.extend_from_slice(ERASE_ROW_ABOVE);
        }
        out.extend(buf);
        out
    }
}

/// The bytes of `typed` an echo must show: everything but whitespace and
/// control characters.
fn significant(typed: &[u8]) -> Vec<u8> {
    typed
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace() && !b.is_ascii_control())
        .collect()
}

fn count_newlines(data: &[u8]) -> usize {
    data.iter().filter(|&&b| b == b'\n').count()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The visible bytes of `data` with their offsets: escape sequences, control
/// characters and whitespace removed.
fn visible(data: &[u8]) -> Vec<(usize, u8)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == 0x1b {
            i = skip_escape(data, i);
            continue;
        }
        if !b.is_ascii_whitespace() && !b.is_ascii_control() {
            out.push((i, b));
        }
        i += 1;
    }
    out
}

/// The index just past the escape sequence starting at `data[at]` (an ESC).
fn skip_escape(data: &[u8], at: usize) -> usize {
    let mut i = at + 1;
    match data.get(i) {
        // CSI: parameters and intermediates, then a final byte in @..~.
        Some(b'[') => {
            i += 1;
            while i < data.len() && !(0x40..=0x7e).contains(&data[i]) {
                i += 1;
            }
            i + 1
        }
        // OSC / DCS / APC / PM / SOS: a string ended by BEL or ST (ESC \).
        Some(b']' | b'P' | b'_' | b'^' | b'X') => {
            i += 1;
            while i < data.len() {
                if data[i] == 0x07 {
                    return i + 1;
                }
                if data[i] == 0x1b && data.get(i + 1) == Some(&b'\\') {
                    return i + 2;
                }
                i += 1;
            }
            i
        }
        // Two-character (or intermediate-prefixed) escape.
        Some(_) => {
            while i < data.len() && (0x20..=0x2f).contains(&data[i]) {
                i += 1;
            }
            i + 1
        }
        None => i,
    }
}

/// Where the echo of `typed` starts in `pre`, if everything visible from
/// there on is that echo: the typed text in order, possibly echoed twice
/// (the tty and then the line editor), with a character repeated where a line
/// editor redraws it at a line wrap. `None` when any other visible text is
/// in that region.
fn echo_start(pre: &[u8], typed: &[u8]) -> Option<usize> {
    let first = *typed.first()?;
    let vis = visible(pre);
    (0..vis.len())
        .filter(|&i| vis[i].1 == first)
        .find(|&i| is_only_echo(&vis[i..], typed))
        .map(|i| vis[i].0)
}

fn is_only_echo(vis: &[(usize, u8)], typed: &[u8]) -> bool {
    let mut j = 0;
    for &(_, c) in vis {
        if j < typed.len() && c == typed[j] {
            j += 1;
        } else if j == typed.len() && c == typed[0] {
            // A second, complete echo of the same text.
            j = 1;
        } else if j > 0 && c == typed[j - 1] {
            // A character redrawn at a line wrap.
        } else {
            return false;
        }
    }
    j == typed.len()
}

#[cfg(test)]
#[path = "setup_echo_tests.rs"]
mod tests;
