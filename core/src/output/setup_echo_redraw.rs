//! Recognise the echo of a typed setup line that the line editor redraws
//! cell by cell, for [`super::setup_echo`] (#5094).
//!
//! fish's editor does not echo typed text as a stream. It addresses each
//! cell (`CR`, `CSI <col> C`, the character), re-prints cells around a line
//! wrap, and redraws the whole line, highlighted, on Enter. The text-order
//! match of [`super::setup_echo`] cannot follow that, so this follows the
//! cursor instead: a small screen model replays the held output from the
//! cursor's position when the line was typed and checks where each
//! character lands.
//!
//! The held output is taken for the editor's echo only when
//!
//! - every visible character it prints lands on the cell where the typed
//!   line has that same character (a blank may land anywhere: it shows
//!   nothing),
//! - the typed line's every visible character has been drawn on its cell,
//!   and
//! - it moves the cursor and erases only in ways the model follows: no
//!   absolute positioning, no saved cursor, no erasing above the cursor.
//!
//! Anything else — output of the setup itself, a message from the shell,
//! an autosuggestion, a prompt repainted over the line — fails the check,
//! and the caller shows everything as it came. The width must be known.

use super::setup_echo::skip_escape;

/// The cursor, relative to the row it was on when the line was typed. `col`
/// is `cols` while an autowrap is pending (the terminal's deferred wrap).
#[derive(Debug, Clone, Copy)]
struct Cursor {
    row: i64,
    col: usize,
}

/// What a replayed chunk of output did that the check cares about.
enum Step {
    /// A character landed at the cursor (before it advanced).
    Glyph(Cursor, u8),
    /// The row was erased from the cursor to its end (`CSI K`), or the
    /// screen from the cursor down (`CSI J`, `true`).
    Erase(Cursor, bool),
    /// Something the model does not follow.
    Unknown,
}

/// Replay `data` from `cursor` at a terminal `cols` wide, reporting each
/// [`Step`] to `on_step`; stops early (returning `false`) when `on_step`
/// does, or at an unknown step.
fn replay(
    data: &[u8],
    cursor: &mut Cursor,
    cols: usize,
    mut on_step: impl FnMut(Step) -> bool,
) -> bool {
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        match b {
            0x1b => {
                let end = skip_escape(data, i);
                let step = escape(&data[i + 1..end.min(data.len())], cursor, cols);
                if let Some(step) = step {
                    if !on_step(step) {
                        return false;
                    }
                }
                i = end;
                continue;
            }
            b'\r' => cursor.col = 0,
            // Raw output reaches the terminal with LF as a pure line feed.
            b'\n' => {
                cursor.row += 1;
                cursor.col = cursor.col.min(cols - 1);
            }
            0x08 => cursor.col = cursor.col.min(cols - 1).saturating_sub(1),
            0x07 | 0x00 => {}
            b if b < 0x20 || b == 0x7f || b >= 0x80 => {
                // TAB and the other controls, and non-ASCII text: not
                // followed (a typed setup line is plain ASCII).
                on_step(Step::Unknown);
                return false;
            }
            b => {
                if cursor.col >= cols {
                    cursor.row += 1;
                    cursor.col = 0;
                }
                if !on_step(Step::Glyph(*cursor, b)) {
                    return false;
                }
                cursor.col += 1;
            }
        }
        i += 1;
    }
    true
}

/// Apply the escape sequence `seq` (after the ESC) to the cursor; the
/// [`Step`] it amounts to, if any.
fn escape(seq: &[u8], cursor: &mut Cursor, cols: usize) -> Option<Step> {
    match seq.first() {
        Some(b'[') => csi(&seq[1..], cursor, cols),
        // Strings (OSC, DCS, APC, PM, SOS) show nothing.
        Some(b']' | b'P' | b'_' | b'^' | b'X') => None,
        // Keypad modes, character-set designations.
        Some(b'=' | b'>' | b'(' | b')' | b'*' | b'+') => None,
        // Saved / restored cursor, index, reset... — not followed.
        _ => Some(Step::Unknown),
    }
}

/// Apply a CSI sequence (`params` + final byte) to the cursor.
fn csi(seq: &[u8], cursor: &mut Cursor, cols: usize) -> Option<Step> {
    let (&fin, params) = seq.split_last()?;
    // Private (`?`, `>`, `<`, `=`) sequences set modes and query the
    // terminal; none of them moves the cursor or changes a cell.
    let private = params
        .first()
        .is_some_and(|p| matches!(p, b'?' | b'>' | b'<' | b'='));
    let n = || {
        std::str::from_utf8(params)
            .ok()
            .and_then(|p| p.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1)
    };
    let mode = || {
        std::str::from_utf8(params)
            .ok()
            .and_then(|p| p.parse::<u8>().ok())
    };
    match fin {
        // SGR, modes, device and terminal queries, cursor style.
        b'm' | b'h' | b'l' | b'n' | b'c' | b'q' | b't' => None,
        _ if private => None,
        b'A' => {
            cursor.row -= n() as i64;
            cursor.col = cursor.col.min(cols - 1);
            None
        }
        b'B' => {
            cursor.row += n() as i64;
            cursor.col = cursor.col.min(cols - 1);
            None
        }
        b'C' => {
            cursor.col = (cursor.col + n()).min(cols - 1);
            None
        }
        b'D' => {
            cursor.col = cursor.col.min(cols - 1).saturating_sub(n());
            None
        }
        b'G' => {
            cursor.col = (n() - 1).min(cols - 1);
            None
        }
        b'K' if params.is_empty() || mode() == Some(0) => Some(Step::Erase(*cursor, false)),
        b'J' if params.is_empty() || mode() == Some(0) => Some(Step::Erase(*cursor, true)),
        // Absolute positioning, erasing above or around the cursor, saved
        // cursors, scrolling regions, inserted or deleted cells...
        _ => Some(Step::Unknown),
    }
}

/// The column the cursor is in after `before` — the output that was shown
/// before the line was typed — at a terminal `cols` wide.
fn column_after(before: &[u8], cols: usize) -> Option<usize> {
    // Only the last row matters, and only from its last CR (or LF) on is
    // the column known. Unknown steps before that do not matter.
    let start = before
        .iter()
        .rposition(|&b| b == b'\r' || b == b'\n')
        .map_or(0, |p| p + 1);
    let mut cursor = Cursor { row: 0, col: 0 };
    replay(&before[start..], &mut cursor, cols, |step| {
        !matches!(step, Step::Unknown)
    })
    .then_some(cursor.col)
}

/// Whether `held` — the output since `line` was typed, up to the setup's
/// end mark — is only the line editor drawing `line` cell by cell (see the
/// module docs). `before` is the output shown before it (it ends with the
/// prompt the line was typed at), `cols` the terminal's width.
pub(crate) fn is_only_redrawn_echo(before: &[u8], held: &[u8], line: &[u8], cols: usize) -> bool {
    let line: &[u8] = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if cols == 0 || line.is_empty() || !line.iter().all(|b| (0x20..0x7f).contains(b)) {
        return false;
    }
    let Some(start) = column_after(before, cols) else {
        return false;
    };
    let width = cols as i64;
    // The offset into the line of the cell under a cursor position.
    let offset = |c: Cursor| c.row * width + c.col.min(cols - 1) as i64 - start as i64;
    let cell = |c: Cursor| usize::try_from(offset(c)).ok().filter(|&k| k < line.len());
    let mut drawn = vec![false; line.len()];
    let mut cursor = Cursor { row: 0, col: start };
    let followed = replay(held, &mut cursor, cols, |step| match step {
        Step::Glyph(_, b' ') => true,
        Step::Glyph(at, b) => match cell(at) {
            Some(k) if line[k] == b => {
                drawn[k] = true;
                true
            }
            _ => false,
        },
        Step::Erase(at, below) => {
            // Cells from the cursor to the row's end (and, for `J`, every
            // cell after it) are blank again.
            let from = offset(at);
            let to = if below {
                i64::MAX
            } else {
                (at.row + 1) * width - 1 - start as i64
            };
            for (k, d) in drawn.iter_mut().enumerate() {
                if (from..=to).contains(&(k as i64)) {
                    *d = false;
                }
            }
            true
        }
        Step::Unknown => false,
    });
    followed && line.iter().zip(&drawn).all(|(&b, &d)| b == b' ' || d)
}

#[cfg(test)]
#[path = "setup_echo_redraw_tests.rs"]
mod tests;
