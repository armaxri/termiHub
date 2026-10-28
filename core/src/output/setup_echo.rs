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
//!   The first prompt's rows are then erased, with everything below them,
//!   so the shell's next prompt (drawn by the now-integrated shell, with its
//!   OSC 133 marks) takes their place instead of appearing twice, and no
//!   stale text is left under it. Lines above the cursor's line count only
//!   where they hold the same text as the next prompt's upper lines (a
//!   two-line prompt), never a banner or other output. Given the terminal's
//!   width ([`SetupEchoFilter::set_width`]), the rows a long prompt wrapped
//!   onto count too (#5054).
//! - **Typed too early.** When the line reached a tty still in cooked mode,
//!   the tty echoed it ahead of the first prompt and the line editor echoed
//!   it again. If only the first prompt (the same rows as the next prompt)
//!   lies between the two echoes, both echoes and that prompt are dropped;
//!   otherwise only the line editor's echo is, and the tty's stays visible.
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

use super::setup_echo_rows::rows_above_prompt;

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
/// How much passed-through output is kept to measure the first prompt.
const RECENT_BYTES: usize = 4096;
/// Bracketed paste on: what readline and ZLE send once a prompt is drawn.
const BRACKETED_PASTE_ON: &[u8] = b"\x1b[?2004h";

/// Erase from the cursor to the end of the screen.
const ERASE_BELOW: &[u8] = b"\x1b[J";

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
    /// The echo was found; the next prompt is held until it is measured.
    Reprompt {
        /// Everything before the end mark.
        pre: Vec<u8>,
        /// Where the line editor's echo starts in `pre`.
        echo: usize,
        typed: Vec<u8>,
        /// Everything after the end mark: the next prompt.
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
    /// The tail of the output passed through before arming: the first
    /// prompt's rows, to compare with the next prompt's.
    recent: Vec<u8>,
    outcome: Option<HideOutcome>,
    finished: bool,
    /// The terminal's width, to count the rows a wrapped prompt spans.
    cols: usize,
    /// Whether the width changed while hiding, after the first prompt was
    /// drawn. The terminal has then reflowed it, but not the cursor's row
    /// (xterm.js leaves that one to the shell's redraw), so its wrapped rows
    /// are no longer above the cursor.
    resized: bool,
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
            recent: Vec::new(),
            outcome: None,
            finished: false,
            cols: 0,
            resized: false,
        }
    }

    /// The terminal's width in columns (0: unknown). Set at spawn and on
    /// every resize, so a prompt that wraps is replaced with all its rows.
    pub fn set_width(&mut self, cols: u16) {
        let cols = usize::from(cols);
        if self.is_active() && cols != self.cols {
            self.resized = true;
        }
        self.cols = cols;
    }

    /// Start hiding: `typed` is about to be written to the shell. Arming again
    /// while holding with a different line extends the text the echo may
    /// consist of; the same line again (a retype) changes nothing. The
    /// deadline stays.
    pub fn arm(&mut self, typed: &[u8], now: Instant) {
        match &mut self.phase {
            Phase::Pass if self.outcome.is_none() => {
                self.phase = Phase::Hold {
                    typed: significant(typed),
                    buf: Vec::new(),
                    deadline: now + SETUP_HIDE_CAP,
                };
            }
            Phase::Hold { typed: t, .. } => {
                // The same setup typed again (a retype) may echo once or
                // twice, which the match already allows.
                let more = significant(typed);
                if !t.ends_with(&more) {
                    t.extend(more);
                }
            }
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
            Phase::Pass => {
                if self.outcome.is_none() {
                    self.recent.extend_from_slice(data);
                    let excess = self.recent.len().saturating_sub(RECENT_BYTES);
                    self.recent.drain(..excess);
                }
                data.to_vec()
            }
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

    /// The end mark is in the held output: find the echo (then measure the
    /// next prompt) or show it all.
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
            Some(echo) => {
                self.outcome = Some(HideOutcome::Hidden);
                self.phase = Phase::Reprompt {
                    pre: pre.to_vec(),
                    echo,
                    typed,
                    buf: post.to_vec(),
                    deadline: now + REPROMPT_CAP,
                    last_output: now,
                };
                self.resolve_reprompt(now, false)
            }
            None => {
                self.outcome = Some(HideOutcome::NotRecognised);
                let mut out = pre.to_vec();
                out.extend_from_slice(post);
                out
            }
        }
    }

    /// Once the next prompt is measurable, release everything: the output
    /// before the echo, then the next prompt in place of the first one.
    /// `timer` says a deadline (not output) woke us.
    fn resolve_reprompt(&mut self, now: Instant, timer: bool) -> Vec<u8> {
        let Phase::Reprompt {
            buf,
            deadline,
            last_output,
            ..
        } = &self.phase
        else {
            return Vec::new();
        };
        let Some(prompt_end) = prompt_end(buf, timer && now >= *last_output + REPROMPT_QUIET)
            .or_else(|| (timer && now >= *deadline).then_some(buf.len()))
        else {
            return Vec::new();
        };
        let Phase::Reprompt {
            pre,
            echo,
            typed,
            buf,
            ..
        } = std::mem::replace(&mut self.phase, Phase::Pass)
        else {
            return Vec::new();
        };
        let prompt = &buf[..prompt_end];
        let next = find(prompt, PROMPT_START).map_or(prompt, |a| &prompt[a..]);
        let mut out;
        if let Some(mut early) = earlier_echo(&pre[..echo], &typed, next) {
            // The typed line's leading space is part of that echo.
            if early > 0 && pre[early - 1] == b' ' {
                early -= 1;
            }
            // Typed before the shell was reading: the tty echoed the line
            // ahead of the first prompt. That echo and the first prompt (the
            // same text as the next one) go too, so nothing needs clearing.
            out = pre[..early].to_vec();
        } else {
            // Erase the first prompt's rows — those it wrapped onto too — and
            // everything below; the next prompt takes its place (#5054).
            let mut before = std::mem::take(&mut self.recent);
            before.extend_from_slice(&pre[..echo]);
            let lines = prompt_rows_above(&before, next);
            let cols = if self.resized { 0 } else { self.cols };
            let rows = rows_above_prompt(&before, next, lines, cols).unwrap_or(lines);
            out = pre[..echo].to_vec();
            out.push(b'\r');
            if rows > 0 {
                out.extend_from_slice(format!("\x1b[{rows}A").as_bytes());
            }
            out.extend_from_slice(ERASE_BELOW);
        }
        out.extend(buf);
        out
    }
}

/// How many rows above the cursor belong to the first prompt: the rows the
/// next prompt (`next`) has above its last one, as long as the text before
/// the echo (`before`) ends with those same rows. Anything else on those
/// rows — a login banner, the echo of input typed early — is never cleared,
/// so a mismatch clears only the cursor's own row (the first prompt's last).
fn prompt_rows_above(before: &[u8], next: &[u8]) -> usize {
    let first = row_texts(before);
    let next = row_texts(next);
    let mut rows = 0;
    for k in 1..next.len() {
        let (Some(a), Some(b)) = (
            first.len().checked_sub(k + 1).map(|i| &first[i]),
            next.len().checked_sub(k + 1).map(|i| &next[i]),
        ) else {
            break;
        };
        if a != b {
            break;
        }
        rows = k;
    }
    rows
}

/// The visible text of each row `data` paints, approximately: printable
/// bytes overwrite cells, CR returns to the row start, LF starts a new row,
/// BS steps back, `CSI K` clears to the row end; other escapes are skipped.
/// Rows are compared without blanks.
fn row_texts(data: &[u8]) -> Vec<Vec<u8>> {
    let mut rows: Vec<Vec<u8>> = vec![Vec::new()];
    let mut col = 0;
    let mut i = 0;
    while i < data.len() {
        let Some(row) = rows.last_mut() else {
            break;
        };
        match data[i] {
            0x1b => {
                let end = skip_escape(data, i);
                if data.get(i + 1) == Some(&b'[') && data.get(end - 1) == Some(&b'K') {
                    row.truncate(col);
                }
                i = end;
                continue;
            }
            b'\r' => col = 0,
            b'\n' => {
                rows.push(Vec::new());
                col = 0;
            }
            0x08 => col = col.saturating_sub(1),
            b if b.is_ascii_control() => {}
            b => {
                if col < row.len() {
                    row[col] = b;
                } else {
                    row.resize(col, b' ');
                    row.push(b);
                }
                col += 1;
            }
        }
        i += 1;
    }
    for row in &mut rows {
        row.retain(|b| !b.is_ascii_whitespace());
    }
    rows
}

/// Where the next prompt in `buf` (the output after the end mark) is fully
/// drawn: at its input-start mark `B`, or where the line editor turns on
/// bracketed paste after drawing its text. With `quiet`, a prompt that started but
/// shows neither counts as drawn at the end of `buf`.
fn prompt_end(buf: &[u8], quiet: bool) -> Option<usize> {
    let a = find(buf, PROMPT_START)? + PROMPT_START.len();
    // readline turns bracketed paste on before it draws the prompt, ZLE
    // after: it only ends a prompt that has shown text.
    let paste =
        find(&buf[a..], BRACKETED_PASTE_ON).filter(|&p| !visible(&buf[a..a + p]).is_empty());
    let ends = find(&buf[a..], INPUT_START).into_iter().chain(paste).min();
    match ends {
        Some(e) => Some(a + e),
        None if quiet => Some(buf.len()),
        None => None,
    }
}

/// An earlier echo of `typed` in `before` (the output before the line
/// editor's echo) followed by nothing but the first prompt: the tty's echo
/// of a line typed while the shell was still starting. The rows after that
/// echo must be exactly the last rows of the next prompt (`next`) — the same
/// prompt drawn again — so no other output is ever taken for it. Returns
/// where that echo starts.
fn earlier_echo(before: &[u8], typed: &[u8], next: &[u8]) -> Option<usize> {
    let first = *typed.first()?;
    let next_rows: Vec<Vec<u8>> = row_texts(next)
        .into_iter()
        .filter(|r| !r.is_empty())
        .collect();
    let vis = visible(before);
    (0..vis.len())
        .filter(|&i| vis[i].1 == first)
        .find(|&i| {
            let Some(end) = echo_end(&vis[i..], typed) else {
                return false;
            };
            let rows: Vec<Vec<u8>> = row_texts(&before[end..])
                .into_iter()
                .filter(|r| !r.is_empty())
                .collect();
            !rows.is_empty()
                && rows.len() <= next_rows.len()
                && rows[..] == next_rows[next_rows.len() - rows.len()..]
        })
        .map(|i| vis[i].0)
}

/// The byte offset just past one echo of `typed` (with wrap redraws) at the
/// start of `vis`, if `vis` starts with one.
fn echo_end(vis: &[(usize, u8)], typed: &[u8]) -> Option<usize> {
    let mut j = 0;
    for &(offset, c) in vis {
        if c == typed[j] {
            j += 1;
            if j == typed.len() {
                return Some(offset + 1);
            }
        } else if !(j > 0 && c == typed[j - 1]) {
            return None;
        }
    }
    None
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
pub(crate) fn skip_escape(data: &[u8], at: usize) -> usize {
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
