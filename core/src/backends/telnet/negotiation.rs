//! Telnet option negotiation (RFC 854 / RFC 855) for the options the client
//! performs — **NAWS** (window size, RFC 1073), **TERMINAL-TYPE** (RFC 1091)
//! and **SUPPRESS-GO-AHEAD** (RFC 858) — and the options it lets the server
//! perform: **ECHO** (RFC 857) and **SUPPRESS-GO-AHEAD**.
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
//! | `WantYes` | We asked (`WILL`/`DO`) and await the server's answer. |
//! | `Yes`     | Option on (both sides agreed).                      |
//!
//! The same three states are tracked for options the *server* performs
//! (`WILL`/`WONT` from the server, answered with `DO`/`DONT`). The client
//! never asks to *disable* an option, so the RFC 1143 `WantNo` states are not
//! needed. A redundant request for an option already in the requested state
//! is never answered, which is what makes the machine loop-safe.
//!
//! Which server options are accepted depends on the [`InputMode`]:
//!
//! | Server offers | Character mode (default) | Line mode            |
//! | ------------- | ------------------------ | -------------------- |
//! | `WILL ECHO`   | `DO` (server echoes)     | `DO` (hides passwords) |
//! | `WILL SGA`    | `DO`                     | `DONT`               |
//!
//! Character mode also requests `DO SGA` up front, like classic telnet
//! clients.

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

/// ECHO option code (RFC 857).
pub(super) const OPT_ECHO: u8 = 1;
/// SUPPRESS-GO-AHEAD option code (RFC 858).
pub(super) const OPT_SGA: u8 = 3;
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

/// How keyboard input is handled (`inputMode` setting).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum InputMode {
    /// Every keystroke is sent immediately; the server echoes (the default,
    /// and what every saved connection without the setting gets).
    #[default]
    Character,
    /// termiHub edits the line locally and sends it on Enter, echoing typed
    /// text itself whenever the server is not echoing.
    Line,
}

impl InputMode {
    /// `inputMode` setting value for [`InputMode::Character`].
    pub const CHARACTER: &'static str = "character";
    /// `inputMode` setting value for [`InputMode::Line`].
    pub const LINE: &'static str = "line";

    /// Parse the `inputMode` setting; absent or unknown values fall back to
    /// character mode.
    pub fn from_setting(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            Some(v) if v == Self::LINE => Self::Line,
            _ => Self::Character,
        }
    }
}

/// Negotiation state of one option.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OptState {
    No,
    WantYes,
    Yes,
}

/// Telnet option negotiator.
#[derive(Debug)]
pub(super) struct Negotiator {
    terminal_type: String,
    input_mode: InputMode,
    /// Options the client performs.
    naws: OptState,
    ttype: OptState,
    sga_us: OptState,
    /// Options the server performs.
    echo_him: OptState,
    sga_him: OptState,
    /// Whether the up-front offers were already produced.
    offered: bool,
    cols: u16,
    rows: u16,
}

impl Negotiator {
    /// Create a negotiator reporting `terminal_type` (an empty or all-blank
    /// value falls back to [`DEFAULT_TERMINAL_TYPE`]).
    pub(super) fn new(terminal_type: &str) -> Self {
        Self {
            terminal_type: sanitize_terminal_type(terminal_type),
            input_mode: InputMode::Character,
            naws: OptState::No,
            ttype: OptState::No,
            sga_us: OptState::No,
            echo_him: OptState::No,
            sga_him: OptState::No,
            offered: false,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }

    /// Use `mode` for keyboard input (builder style).
    pub(super) fn with_input_mode(mut self, mode: InputMode) -> Self {
        self.input_mode = mode;
        self
    }

    /// The configured input mode.
    #[cfg(test)]
    pub(super) fn input_mode(&self) -> InputMode {
        self.input_mode
    }

    /// Whether the server currently echoes our input (ECHO enabled).
    pub(super) fn remote_echo(&self) -> bool {
        self.echo_him == OptState::Yes
    }

    /// Whether the server suppresses go-ahead (SGA enabled on its side).
    #[cfg(test)]
    pub(super) fn remote_sga(&self) -> bool {
        self.sga_him == OptState::Yes
    }

    /// Whether input should be line-edited and echoed locally: line mode,
    /// and the server is not echoing (it takes over echo e.g. while it
    /// reads a password).
    pub(super) fn local_line_editing(&self) -> bool {
        self.input_mode == InputMode::Line && !self.remote_echo()
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

    /// Bytes to send right after the TCP connect (produced once):
    /// proactively offer `WILL NAWS` so servers that never ask (many embedded
    /// telnetds) still learn the window size, and — in character mode —
    /// request `DO SGA`. A refusing server answers `DONT NAWS` / `WONT SGA`,
    /// which quietly returns the option to `No`.
    pub(super) fn initial_offer(&mut self) -> Vec<u8> {
        if self.offered {
            return Vec::new();
        }
        self.offered = true;
        let mut out = Vec::new();
        Self::request(&mut self.naws, WILL, OPT_NAWS, &mut out);
        if self.input_mode == InputMode::Character {
            Self::request(&mut self.sga_him, DO, OPT_SGA, &mut out);
        }
        out
    }

    /// Handle `IAC <cmd> <opt>` from the server, appending any reply to `out`.
    pub(super) fn on_command(&mut self, cmd: u8, opt: u8, out: &mut Vec<u8>) {
        match (cmd, opt) {
            (DO, OPT_NAWS) => {
                if Self::accept(&mut self.naws, WILL, OPT_NAWS, out) {
                    // Newly enabled: report the current size straight away.
                    out.extend_from_slice(&naws_subnegotiation(self.cols, self.rows));
                }
            }
            (DO, OPT_TTYPE) => {
                // The type itself is only sent on `SB TTYPE SEND`.
                Self::accept(&mut self.ttype, WILL, OPT_TTYPE, out);
            }
            // We never send go-aheads, so suppressing them is free.
            (DO, OPT_SGA) => {
                Self::accept(&mut self.sga_us, WILL, OPT_SGA, out);
            }
            (DONT, OPT_NAWS) => Self::refuse(&mut self.naws, WONT, OPT_NAWS, out),
            (DONT, OPT_TTYPE) => Self::refuse(&mut self.ttype, WONT, OPT_TTYPE, out),
            (DONT, OPT_SGA) => Self::refuse(&mut self.sga_us, WONT, OPT_SGA, out),
            // Any other option we are asked to perform — including ECHO: the
            // client never echoes the server's output back — is declined.
            (DO, other) => out.extend_from_slice(&[IAC, WONT, other]),
            (WILL, OPT_ECHO) => {
                Self::accept(&mut self.echo_him, DO, OPT_ECHO, out);
            }
            (WILL, OPT_SGA) if self.input_mode == InputMode::Character => {
                Self::accept(&mut self.sga_him, DO, OPT_SGA, out);
            }
            (WONT, OPT_ECHO) => Self::refuse(&mut self.echo_him, DONT, OPT_ECHO, out),
            (WONT, OPT_SGA) => Self::refuse(&mut self.sga_him, DONT, OPT_SGA, out),
            // Other options the server offers to perform (and SGA in line
            // mode): decline. The state stays `No`, so this is RFC 1143's
            // "refuse in NO" and cannot loop.
            (WILL, other) => out.extend_from_slice(&[IAC, DONT, other]),
            // DONT for an option we never enabled, or WONT for any other
            // option: nothing to acknowledge.
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

    /// Ask for `opt` to be enabled (`WILL` for our side, `DO` for the
    /// server's) unless it is already on or pending.
    fn request(slot: &mut OptState, cmd: u8, opt: u8, out: &mut Vec<u8>) {
        if *slot == OptState::No {
            out.extend_from_slice(&[IAC, cmd, opt]);
            *slot = OptState::WantYes;
        }
    }

    /// The server asked for (`DO`) or offered (`WILL`) an option we support;
    /// `agree` is our agreeing reply (`WILL` resp. `DO`). Returns `true` when
    /// the option transitioned to enabled by this call.
    fn accept(slot: &mut OptState, agree: u8, opt: u8, out: &mut Vec<u8>) -> bool {
        match *slot {
            // Unsolicited request: agree.
            OptState::No => {
                out.extend_from_slice(&[IAC, agree, opt]);
                *slot = OptState::Yes;
                true
            }
            // Acknowledgement of our own request: no reply (that would loop).
            OptState::WantYes => {
                *slot = OptState::Yes;
                true
            }
            // Already on — a redundant `DO` is ignored.
            OptState::Yes => false,
        }
    }

    /// The server sent `DONT`/`WONT`: a refusal of our request, or a request
    /// to stop. `ack` is the acknowledging reply (`WONT` resp. `DONT`).
    fn refuse(slot: &mut OptState, ack: u8, opt: u8, out: &mut Vec<u8>) {
        match *slot {
            OptState::Yes => {
                out.extend_from_slice(&[IAC, ack, opt]);
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
