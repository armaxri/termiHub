//! How many screen rows the first prompt spans, for [`super::setup_echo`]
//! to replace it with the next one (#5054).
//!
//! A prompt wider than the terminal wraps onto more rows than it has line
//! breaks. The rows are counted by following the cursor through the output
//! at the terminal's width: printable characters (with the terminal's
//! deferred autowrap), CR, LF, BS, TAB and the relative cursor moves. That is
//! only as exact as the width it is given; without one, the caller counts
//! line breaks only.

use super::setup_echo::skip_escape;

/// The cursor's path through `before`: where each line (split at LF) starts
/// and the row each visible character landed on.
struct Walk {
    /// The byte offset and screen row each LF-separated line starts at.
    lines: Vec<(usize, i64)>,
    /// The byte offset, row and byte of each visible character.
    glyphs: Vec<(usize, i64, u8)>,
    /// The cursor's row at the end.
    row: i64,
}

fn walk(data: &[u8], cols: usize) -> Walk {
    let mut w = Walk {
        lines: vec![(0, 0)],
        glyphs: Vec::new(),
        row: 0,
    };
    let mut col = 0usize;
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        match b {
            0x1b => {
                let end = skip_escape(data, i);
                if data.get(i + 1) == Some(&b'[') {
                    cursor_move(&data[i + 2..end], &mut w.row, &mut col, cols);
                }
                i = end;
                continue;
            }
            b'\r' => col = 0,
            b'\n' => {
                w.row += 1;
                col = 0;
                w.lines.push((i + 1, w.row));
            }
            0x08 => col = col.min(cols - 1).saturating_sub(1),
            b'\t' => col = ((col / 8 + 1) * 8).min(cols - 1),
            // UTF-8 continuation bytes share their lead byte's cell.
            b if b.is_ascii_control() || (b & 0xc0) == 0x80 => {}
            b => {
                if col >= cols {
                    w.row += 1;
                    col = 0;
                }
                if !b.is_ascii_whitespace() {
                    w.glyphs.push((i, w.row, b));
                }
                col += 1;
            }
        }
        i += 1;
    }
    w
}

/// Apply a CSI cursor move (`params` and final byte) to the cursor.
fn cursor_move(seq: &[u8], row: &mut i64, col: &mut usize, cols: usize) {
    let Some((&fin, params)) = seq.split_last() else {
        return;
    };
    let n = std::str::from_utf8(params)
        .ok()
        .and_then(|p| p.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    match fin {
        b'A' => *row -= n as i64,
        b'B' => *row += n as i64,
        b'C' => *col = (*col + n).min(cols - 1),
        b'D' => *col = (*col).min(cols - 1).saturating_sub(n),
        b'G' => *col = (n - 1).min(cols - 1),
        b'E' => {
            *row += n as i64;
            *col = 0;
        }
        b'F' => {
            *row -= n as i64;
            *col = 0;
        }
        _ => {}
    }
}

/// How many rows above the cursor the first prompt starts, at a terminal
/// `cols` wide. `before` is the output up to the cursor (the first prompt
/// last), `next` the next prompt (drawn in its place) and `lines_above` how
/// many line breaks the prompt has.
///
/// The first prompt starts where its top line shows the same characters as
/// the next prompt's top line. Anything earlier on that line — a partial
/// line of output the shell moved past — keeps its rows; when the two
/// prompts differ, the whole line goes. `None` without a width or when
/// `before` has too few lines.
pub(crate) fn rows_above_prompt(
    before: &[u8],
    next: &[u8],
    lines_above: usize,
    cols: usize,
) -> Option<usize> {
    if cols == 0 {
        return None;
    }
    let first = walk(before, cols);
    let top = walk(next, cols);
    let line = first.lines.len().checked_sub(lines_above + 1)?;
    let mut start_row = first.lines[line].1;
    let shown = line_glyphs(&first, line, before.len());
    let top_line = top.lines.len().saturating_sub(lines_above + 1);
    let want: Vec<u8> = line_glyphs(&top, top_line, next.len())
        .iter()
        .map(|g| g.2)
        .collect();
    if let Some(at) = (0..shown.len())
        .find(|&k| !want.is_empty() && shown[k..].iter().map(|g| g.2).eq(want.iter().copied()))
    {
        start_row = shown[at].1;
    }
    usize::try_from(first.row - start_row).ok()
}

/// The visible characters on LF-separated line `line` of a walk over
/// `len` bytes.
fn line_glyphs(w: &Walk, line: usize, len: usize) -> Vec<(usize, i64, u8)> {
    let Some(&(start, _)) = w.lines.get(line) else {
        return Vec::new();
    };
    let end = w.lines.get(line + 1).map_or(len, |&(o, _)| o);
    w.glyphs
        .iter()
        .copied()
        .filter(|(o, _, _)| (start..end).contains(o))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_prompt_is_on_the_cursors_row() {
        assert_eq!(rows_above_prompt(b"rc\r\n$ ", b"$ ", 0, 80), Some(0));
    }

    #[test]
    fn a_wrapped_prompt_counts_its_wrapped_rows() {
        let prompt = format!("{}$ ", "x".repeat(50));
        let before = format!("rc\r\n{prompt}");
        let rows = |cols| rows_above_prompt(before.as_bytes(), prompt.as_bytes(), 0, cols);
        assert_eq!(rows(40), Some(1));
        assert_eq!(rows(80), Some(0));
    }

    #[test]
    fn a_two_line_prompt_counts_both_lines() {
        let prompt = "~/dir on main\r\n> ";
        let before = format!("rc\r\n{prompt}");
        assert_eq!(
            rows_above_prompt(before.as_bytes(), prompt.as_bytes(), 1, 80),
            Some(1)
        );
    }

    #[test]
    fn a_prompt_that_fills_the_row_exactly_stays_on_it() {
        // Deferred autowrap: the cursor waits at the edge until more comes.
        let prompt = "x".repeat(40);
        let before = format!("rc\r\n{prompt}");
        assert_eq!(
            rows_above_prompt(before.as_bytes(), prompt.as_bytes(), 0, 40),
            Some(0)
        );
    }

    #[test]
    fn a_different_next_prompt_takes_the_whole_line() {
        let before = format!("rc\r\n{}$ ", "x".repeat(50));
        let next = format!("{}$ ", "y".repeat(50));
        assert_eq!(
            rows_above_prompt(before.as_bytes(), next.as_bytes(), 0, 40),
            Some(1)
        );
    }

    #[test]
    fn no_width_or_too_few_lines_is_unknown() {
        assert_eq!(rows_above_prompt(b"$ ", b"$ ", 0, 0), None);
        assert_eq!(rows_above_prompt(b"$ ", b"> \r\n$ ", 1, 80), None);
    }
}
