//! Local line editing for telnet **line mode** (`inputMode: "line"`).
//!
//! In line mode termiHub behaves like a classic NVT line-mode client: typed
//! text is echoed locally and buffered, simple editing keys work on the local
//! buffer, and the line is sent (terminated by `CR LF`, RFC 854) on Enter.
//! While the server has ECHO enabled (typically around a password prompt) the
//! backend bypasses the editor and passes keystrokes straight through — see
//! [`prepare_input`].
//!
//! Like the negotiator this is a pure state machine: it never touches a
//! socket or channel, so every byte is unit-testable.

use super::negotiation::escape_iac;

const BS: u8 = 0x08;
const LF: u8 = b'\n';
const CR: u8 = b'\r';
const CTRL_U: u8 = 0x15;
const ESC: u8 = 0x1b;
const DEL: u8 = 0x7f;

/// Visual erase of one character on the local terminal.
const ERASE: &[u8] = b"\x08 \x08";

/// Upper bound on a buffered line. Anything beyond is dropped (not echoed)
/// so a runaway paste cannot grow memory without bound.
const MAX_LINE_LEN: usize = 4096;

/// Bytes produced by one input chunk.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Edited {
    /// Bytes to send to the server.
    pub send: Vec<u8>,
    /// Bytes to show on the local terminal (local echo).
    pub echo: Vec<u8>,
}

/// Progress through a terminal escape sequence (arrow keys etc.), which is
/// discarded — the local editor has no cursor movement or history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Escape {
    None,
    /// Saw `ESC`.
    Start,
    /// Inside `ESC [` / `ESC O`; ends at a final byte `0x40..=0x7e`.
    Body,
}

/// Line-mode editor state, persisted across writes.
#[derive(Debug)]
pub(super) struct LineEditor {
    line: Vec<u8>,
    escape: Escape,
    /// The previous byte ended a line with `CR`, so a directly following
    /// `LF` belongs to the same line ending.
    after_cr: bool,
}

impl LineEditor {
    pub(super) fn new() -> Self {
        Self {
            line: Vec::new(),
            escape: Escape::None,
            after_cr: false,
        }
    }

    /// Feed one chunk of keyboard input. `send` is NOT yet IAC-escaped.
    pub(super) fn feed(&mut self, input: &[u8]) -> Edited {
        let mut out = Edited::default();
        for &byte in input {
            let after_cr = std::mem::take(&mut self.after_cr);
            if self.skip_escape(byte) {
                continue;
            }
            match byte {
                CR => {
                    self.end_line(&mut out);
                    self.after_cr = true;
                }
                LF if after_cr => {}
                LF => self.end_line(&mut out),
                BS | DEL => {
                    if self.erase_char() {
                        out.echo.extend_from_slice(ERASE);
                    }
                }
                CTRL_U => {
                    while self.erase_char() {
                        out.echo.extend_from_slice(ERASE);
                    }
                }
                ESC => self.escape = Escape::Start,
                // Tab is ordinary line content.
                b'\t' => self.push(byte, &mut out),
                // Other control characters (Ctrl-C, Ctrl-D, …) take effect on
                // the server immediately: flush the line and pass them on.
                0x00..=0x1f => {
                    out.send.append(&mut self.line);
                    out.send.push(byte);
                }
                _ => self.push(byte, &mut out),
            }
        }
        out
    }

    /// Take the partially typed line (e.g. when the server takes over echo
    /// mid-line and input switches to pass-through).
    pub(super) fn take_pending(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.line)
    }

    /// Advance the escape-sequence skipper; `true` when `byte` was consumed.
    fn skip_escape(&mut self, byte: u8) -> bool {
        match self.escape {
            Escape::None => false,
            Escape::Start => {
                self.escape = if byte == b'[' || byte == b'O' {
                    Escape::Body
                } else {
                    // `ESC x` (Alt-x): two-byte sequence, done.
                    Escape::None
                };
                true
            }
            Escape::Body => {
                if (0x40..=0x7e).contains(&byte) {
                    self.escape = Escape::None;
                }
                true
            }
        }
    }

    fn push(&mut self, byte: u8, out: &mut Edited) {
        if self.line.len() < MAX_LINE_LEN {
            self.line.push(byte);
            out.echo.push(byte);
        }
    }

    fn end_line(&mut self, out: &mut Edited) {
        out.send.append(&mut self.line);
        out.send.extend_from_slice(b"\r\n");
        out.echo.extend_from_slice(b"\r\n");
    }

    /// Remove the last (UTF-8) character; `false` when the line was empty.
    fn erase_char(&mut self) -> bool {
        let Some(mut last) = self.line.pop() else {
            return false;
        };
        // Pop continuation bytes until the lead byte of the character.
        while last & 0xC0 == 0x80 {
            match self.line.pop() {
                Some(b) => last = b,
                None => break,
            }
        }
        true
    }
}

/// Turn a chunk of keyboard input into the bytes to send (IAC-escaped, RFC
/// 854) and the bytes to echo locally. With `local_editing` off (character
/// mode, or line mode while the server echoes) the input passes straight
/// through, preceded by any line left half-typed in the editor.
pub(super) fn prepare_input(editor: &mut LineEditor, local_editing: bool, data: &[u8]) -> Edited {
    let raw = if local_editing {
        editor.feed(data)
    } else {
        let mut send = editor.take_pending();
        send.extend_from_slice(data);
        Edited {
            send,
            echo: Vec::new(),
        }
    };
    Edited {
        send: escape_iac(&raw.send),
        echo: raw.echo,
    }
}

#[cfg(test)]
#[path = "line_editor_tests.rs"]
mod tests;
