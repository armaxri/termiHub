//! Telnet option negotiation (RFC 854 / RFC 855) for the two options the
//! client performs: **NAWS** (window size, RFC 1073) and **TERMINAL-TYPE**
//! (RFC 1091).
//!
//! [`Negotiator`] is a pure state machine — it never touches a socket. Callers
//! feed it the `DO`/`DONT`/`WILL`/`WONT` commands and subnegotiations the
//! [`TelnetFilter`](super::TelnetFilter) parses out of the stream, and it
//! appends the bytes to send back to a caller-owned buffer. That keeps every
//! byte of the negotiation unit-testable without a TCP connection.
//!
//! Per-option state follows the relevant half of RFC 1143 ("Q method") so the
//! client never answers an acknowledgement with another request and can never
//! enter a negotiation loop:
//!
//! | State     | Meaning                                             |
//! | --------- | --------------------------------------------------- |
//! | `No`      | Option off.                                         |
//! | `WantYes` | We sent `WILL` and await the server's `DO`/`DONT`.  |
//! | `Yes`     | Option on (the server sent `DO` and we agreed).     |

/// Interpret As Command.
pub(super) const IAC: u8 = 255;
/// Subnegotiation end.
pub(super) const SE: u8 = 240;
/// Subnegotiation begin.
pub(super) const SB: u8 = 250;
pub(super) const WILL: u8 = 251;
pub(super) const WONT: u8 = 252;
pub(super) const DO: u8 = 253;
pub(super) const DONT: u8 = 254;

/// TERMINAL-TYPE option code (RFC 1091).
pub(super) const OPT_TTYPE: u8 = 24;
/// Negotiate About Window Size option code (RFC 1073).
pub(super) const OPT_NAWS: u8 = 31;

/// TERMINAL-TYPE subnegotiation: "my terminal type is …".
pub(super) const TTYPE_IS: u8 = 0;
/// TERMINAL-TYPE subnegotiation: "send me your terminal type".
pub(super) const TTYPE_SEND: u8 = 1;

/// Terminal type reported when none is configured — the same `TERM` the other
/// terminal backends (local shell, WSL, SSH) default to.
pub const DEFAULT_TERMINAL_TYPE: &str = "xterm-256color";

/// Initial window size assumed until the first resize arrives (the same
/// 80x24 default the SSH backend uses).
pub(super) const DEFAULT_COLS: u16 = 80;
pub(super) const DEFAULT_ROWS: u16 = 24;

/// Maximum length of a terminal-type name sent in `SB TTYPE IS`. RFC 1091
/// names are short (RFC 1700 caps them at 40 characters); anything longer is a
/// misconfiguration and is truncated rather than sent verbatim.
const MAX_TERMINAL_TYPE_LEN: usize = 40;

/// Client-side negotiation state of one option.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OptState {
    No,
    WantYes,
    Yes,
}

/// Telnet option negotiator for NAWS and TERMINAL-TYPE.
#[derive(Debug)]
pub(super) struct Negotiator {
    terminal_type: String,
    naws: OptState,
    ttype: OptState,
    cols: u16,
    rows: u16,
}

impl Negotiator {
    /// Create a negotiator reporting `terminal_type` (an empty or all-blank
    /// value falls back to [`DEFAULT_TERMINAL_TYPE`]).
    pub(super) fn new(terminal_type: &str) -> Self {
        Self {
            terminal_type: sanitize_terminal_type(terminal_type),
            naws: OptState::No,
            ttype: OptState::No,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }

    /// The terminal type this negotiator reports.
    #[cfg(test)]
    pub(super) fn terminal_type(&self) -> &str {
        &self.terminal_type
    }

    /// Whether NAWS is currently active (the server agreed to receive sizes).
    pub(super) fn naws_enabled(&self) -> bool {
        self.naws == OptState::Yes
    }

    /// Bytes to send right after the TCP connect: proactively offer
    /// `WILL NAWS` so servers that never ask (many embedded telnetds) still
    /// learn the window size. A refusing server answers `DONT NAWS`, which
    /// quietly returns the option to `No`.
    pub(super) fn initial_offer(&mut self) -> Vec<u8> {
        if self.naws == OptState::No {
            self.naws = OptState::WantYes;
            vec![IAC, WILL, OPT_NAWS]
        } else {
            Vec::new()
        }
    }

    /// Handle `IAC <cmd> <opt>` from the server, appending any reply to `out`.
    pub(super) fn on_command(&mut self, cmd: u8, opt: u8, out: &mut Vec<u8>) {
        match (cmd, opt) {
            (DO, OPT_NAWS) => {
                if Self::accept(&mut self.naws, OPT_NAWS, out) {
                    // Newly enabled: report the current size straight away.
                    out.extend_from_slice(&naws_subnegotiation(self.cols, self.rows));
                }
            }
            (DO, OPT_TTYPE) => {
                // The type itself is only sent on `SB TTYPE SEND`.
                Self::accept(&mut self.ttype, OPT_TTYPE, out);
            }
            (DONT, OPT_NAWS) => Self::refuse(&mut self.naws, OPT_NAWS, out),
            (DONT, OPT_TTYPE) => Self::refuse(&mut self.ttype, OPT_TTYPE, out),
            // Any other option we are asked to perform: decline.
            (DO, other) => out.extend_from_slice(&[IAC, WONT, other]),
            // Options the server offers to perform: decline (unchanged
            // historical behaviour — the backend runs a plain byte stream).
            (WILL, other) => out.extend_from_slice(&[IAC, DONT, other]),
            // DONT for an option we never enabled, or WONT for any option:
            // nothing to acknowledge.
            _ => {}
        }
    }

    /// Handle a complete subnegotiation payload (the bytes between `IAC SB`
    /// and `IAC SE`, already IAC-unescaped), appending any reply to `out`.
    pub(super) fn on_subnegotiation(&mut self, payload: &[u8], out: &mut Vec<u8>) {
        if let [OPT_TTYPE, TTYPE_SEND, ..] = payload {
            // Only answer when the option is actually enabled — a server must
            // not ask before `DO TERMINAL-TYPE` was agreed (RFC 1091).
            if self.ttype == OptState::Yes {
                out.extend_from_slice(&ttype_is(&self.terminal_type));
            }
        }
    }

    /// Record a new window size. Returns the `SB NAWS` to send when NAWS is
    /// active and the size actually changed, otherwise `None` (the size is
    /// still remembered and reported once the server enables NAWS).
    pub(super) fn resize(&mut self, cols: u16, rows: u16) -> Option<Vec<u8>> {
        let changed = (cols, rows) != (self.cols, self.rows);
        self.cols = cols;
        self.rows = rows;
        (changed && self.naws_enabled()).then(|| naws_subnegotiation(cols, rows))
    }

    /// Server sent `DO <opt>` for an option we support. Returns `true` when
    /// the option transitioned to enabled by this call.
    fn accept(slot: &mut OptState, opt: u8, out: &mut Vec<u8>) -> bool {
        match *slot {
            // Unsolicited request: agree.
            OptState::No => {
                out.extend_from_slice(&[IAC, WILL, opt]);
                *slot = OptState::Yes;
                true
            }
            // Acknowledgement of our own `WILL`: no reply (that would loop).
            OptState::WantYes => {
                *slot = OptState::Yes;
                true
            }
            // Already on — a redundant `DO` is ignored.
            OptState::Yes => false,
        }
    }

    /// Server sent `DONT <opt>`: a refusal of our offer, or a request to stop.
    fn refuse(slot: &mut OptState, opt: u8, out: &mut Vec<u8>) {
        match *slot {
            OptState::Yes => {
                out.extend_from_slice(&[IAC, WONT, opt]);
                *slot = OptState::No;
            }
            // Refusal of our offer — the negotiation simply ends.
            OptState::WantYes => *slot = OptState::No,
            OptState::No => {}
        }
    }
}

/// Double every `0xFF` so data can travel inside a telnet stream or
/// subnegotiation without being read as `IAC` (RFC 854).
pub(super) fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out
}

/// Build `IAC SB NAWS <width16> <height16> IAC SE` (RFC 1073). Size bytes of
/// `0xFF` (e.g. a 255-column window) are IAC-doubled, as the RFC requires.
pub(super) fn naws_subnegotiation(cols: u16, rows: u16) -> Vec<u8> {
    let mut size = Vec::with_capacity(4);
    size.extend_from_slice(&cols.to_be_bytes());
    size.extend_from_slice(&rows.to_be_bytes());
    let mut out = vec![IAC, SB, OPT_NAWS];
    out.extend_from_slice(&escape_iac(&size));
    out.extend_from_slice(&[IAC, SE]);
    out
}

/// Build `IAC SB TERMINAL-TYPE IS <name> IAC SE` (RFC 1091).
pub(super) fn ttype_is(name: &str) -> Vec<u8> {
    let mut out = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
    out.extend_from_slice(&escape_iac(name.as_bytes()));
    out.extend_from_slice(&[IAC, SE]);
    out
}

/// Normalise a configured terminal type: keep only printable ASCII (RFC 1091
/// names are ASCII), trim, cap the length, and fall back to the default when
/// nothing usable remains.
pub(super) fn sanitize_terminal_type(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(MAX_TERMINAL_TYPE_LEN)
        .collect();
    if cleaned.is_empty() {
        DEFAULT_TERMINAL_TYPE.to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
#[path = "negotiation_tests.rs"]
mod tests;
