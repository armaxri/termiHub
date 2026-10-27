//! Follow a shell's working directory without touching the shell (#5009).
//!
//! The file browser follows a terminal's directory from OSC 7 (`file://` URI)
//! in its output. Shells only print that when something in them is set up to
//! — termiHub used to type a hook into every bash/zsh for it, which left a
//! visible line, a history entry, functions and a changed `PROMPT_COMMAND` /
//! `PS1` behind. Instead, the backend reads the directory from the operating
//! system — the shell's process, found through the session it owns (a local
//! PTY, or a sibling exec channel on the same SSH connection) — and adds the
//! OSC 7 to the output stream itself. Nothing is typed, nothing in the user's
//! shell changes.
//!
//! [`CwdFollower`] decides *when* to read the directory and *whether* to add
//! the OSC 7; reading it is the backend's job:
//!
//! - It reads after a command has run: output that contained a line break
//!   and then went quiet for [`SETTLE`] (the next prompt is drawn). Typing at
//!   the prompt never triggers a read; a read is never repeated more often
//!   than the backend's minimum interval.
//! - It adds an OSC 7 only when the directory changed, and only at a point of
//!   the stream that is outside any escape sequence.
//! - It turns itself off for good the moment the shell reports its directory
//!   itself (OSC 7 or OSC 9;9 — a user's own shell integration, macOS
//!   Terminal hooks, Fedora's `vte.sh`, PowerShell/cmd started with
//!   termiHub's arguments), so the two never fight over the path.

use std::time::{Duration, Instant};

/// How long output must stay quiet after a line break before the directory
/// is read.
pub const SETTLE: Duration = Duration::from_millis(150);

const OSC7: &[u8] = b"\x1b]7;";
const OSC9_9: &[u8] = b"\x1b]9;9;";

/// Where a byte stream stands relative to escape sequences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum EscState {
    #[default]
    Ground,
    Escape,
    Csi,
    /// OSC / DCS / APC / PM / SOS string, until BEL or ST.
    Str,
    /// ESC inside a string (maybe the start of ST).
    StrEscape,
}

impl EscState {
    fn step(self, b: u8) -> EscState {
        match self {
            EscState::Ground => {
                if b == 0x1b {
                    EscState::Escape
                } else {
                    EscState::Ground
                }
            }
            EscState::Escape => match b {
                b'[' => EscState::Csi,
                b']' | b'P' | b'_' | b'^' | b'X' => EscState::Str,
                0x20..=0x2f => EscState::Escape,
                _ => EscState::Ground,
            },
            EscState::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    EscState::Ground
                } else {
                    EscState::Csi
                }
            }
            EscState::Str => match b {
                0x07 => EscState::Ground,
                0x1b => EscState::StrEscape,
                _ => EscState::Str,
            },
            EscState::StrEscape => match b {
                b'\\' => EscState::Ground,
                0x1b => EscState::StrEscape,
                _ => EscState::Str,
            },
        }
    }
}

/// When to read a shell's directory and when to report it. See the module
/// docs.
#[derive(Debug)]
pub struct CwdFollower {
    min_interval: Duration,
    /// The shell reports its own directory: never add ours.
    shell_reports: bool,
    esc: EscState,
    /// The last few bytes, to find a cwd report split across chunks.
    tail: Vec<u8>,
    /// Output since the last read contained a line break.
    ran_command: bool,
    last_output: Option<Instant>,
    last_read: Option<Instant>,
    reading: bool,
    last_cwd: Option<String>,
    /// An OSC 7 waiting for the stream to leave an escape sequence.
    pending: Option<Vec<u8>>,
}

impl CwdFollower {
    /// A follower that reads at most once per `min_interval`. The first
    /// prompt counts as a command having run, so the start directory is
    /// reported too.
    #[must_use]
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            shell_reports: false,
            esc: EscState::Ground,
            tail: Vec::new(),
            ran_command: true,
            last_output: None,
            last_read: None,
            reading: false,
            last_cwd: None,
            pending: None,
        }
    }

    /// Whether the shell reports its directory itself (the follower is off).
    pub fn shell_reports_cwd(&self) -> bool {
        self.shell_reports
    }

    /// Note a chunk of the shell's output (as it reaches the terminal).
    pub fn observe(&mut self, data: &[u8], now: Instant) {
        if data.is_empty() {
            return;
        }
        self.last_output = Some(now);
        if data.contains(&b'\n') {
            self.ran_command = true;
        }
        let mut window = std::mem::take(&mut self.tail);
        window.extend_from_slice(data);
        if contains(&window, OSC7) || contains(&window, OSC9_9) {
            self.shell_reports = true;
            self.pending = None;
        }
        let keep = window.len().saturating_sub(OSC9_9.len());
        self.tail = window.split_off(keep);
        for &b in data {
            self.esc = self.esc.step(b);
        }
    }

    /// When the directory should next be read, or `None` when there is
    /// nothing to do (no command ran since, a read is running, or the shell
    /// reports its directory itself).
    pub fn next_read(&self) -> Option<Instant> {
        if self.shell_reports || self.reading || !self.ran_command {
            return None;
        }
        let settled = self.last_output? + SETTLE;
        Some(match self.last_read {
            Some(last) => settled.max(last + self.min_interval),
            None => settled,
        })
    }

    /// Whether a read is due at `now`; if so it is marked as started.
    pub fn start_read(&mut self, now: Instant) -> bool {
        match self.next_read() {
            Some(due) if now >= due => {
                self.reading = true;
                self.ran_command = false;
                self.last_read = Some(now);
                true
            }
            _ => false,
        }
    }

    /// The read finished with `cwd` (`None`: it could not be read). Returns
    /// the OSC 7 to add to the stream now, if the directory changed and the
    /// stream is outside an escape sequence; otherwise it waits for
    /// [`take_pending`](Self::take_pending).
    pub fn finish_read(&mut self, cwd: Option<&str>) -> Option<Vec<u8>> {
        self.reading = false;
        let cwd = cwd.filter(|c| !c.is_empty())?;
        if self.shell_reports || self.last_cwd.as_deref() == Some(cwd) {
            return None;
        }
        self.last_cwd = Some(cwd.to_string());
        self.pending = Some(osc7(cwd));
        self.take_pending()
    }

    /// The waiting OSC 7, once the stream is outside an escape sequence.
    pub fn take_pending(&mut self) -> Option<Vec<u8>> {
        if self.esc != EscState::Ground || self.shell_reports {
            return None;
        }
        self.pending.take()
    }
}

/// The OSC 7 report for `path`: `ESC ] 7 ; file://<path> BEL`, the path
/// percent-encoded except for `/`. A Windows path (`C:\x`) becomes `/C:/x`,
/// the form the terminal's OSC 7 parser maps back to a drive path.
#[must_use]
pub fn osc7(path: &str) -> Vec<u8> {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Everything a URI path may not carry literally; `/` and `:` stay.
    const PATH: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');
    let mut p = path.replace('\\', "/");
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    format!("\x1b]7;file://{}\x07", utf8_percent_encode(&p, PATH)).into_bytes()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
#[path = "cwd_follow_tests.rs"]
mod tests;
