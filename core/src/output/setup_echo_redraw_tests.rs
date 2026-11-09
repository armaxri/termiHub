//! Tests for [`is_only_redrawn_echo`] (#5094). The transcripts are what
//! fish 4.6 printed over SSH when the setup line was typed at its prompt
//! (captured with the native sshd fixture), shortened where only the
//! length differed.

use super::*;

/// fish's prompt, ending with the cursor placed after it (column 4).
const PROMPT: &[u8] = b"\x1b]133;A;click_events=1\x07me> \x1b]133;B\x07\x1b[K\r\x1b[4C";

/// fish's cell-by-cell echo of `line` from column `start` at width `cols`:
/// each character, then `CR` and a move to the next cell; at the wrap the
/// last two cells are re-printed (as fish 4.6 does) — then Enter.
fn fish_echo(line: &str, start: usize, cols: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut col = start;
    let chars: Vec<char> = line.chars().collect();
    for (k, c) in chars.iter().enumerate() {
        if col == cols {
            // The first character after a wrap: it lands on the next row.
            out.extend(format!("{c}\r\x1b[1C").as_bytes());
            col = 1;
        } else if col == cols - 1 && k > 0 {
            // The last cell: `\b`, the last two cells, then down and back
            // up and the same two cells again (as fish 4.6 does).
            let prev = chars[k - 1];
            out.extend(format!("\x08{prev}{c}\r\r\n\x1b[A\x1b[{}C{prev}{c}", cols - 2).as_bytes());
            col = cols;
        } else {
            out.extend(format!("{c}\r\x1b[{}C", col + 1).as_bytes());
            col += 1;
        }
    }
    out.extend(b"\x1b[?2004l\x1b[?2031l\x1b[>4;0m\x1b>\r\n\x1b[m");
    out.extend(b"\x1b]133;C;cmdline_url=%20set\x07\x1b]0;[host]  set -gx A ~\x07\x1b[m\r");
    out
}

const LINE: &str = " set -gx A 'it\\'s'; printf '\\e]6973;termihub-setup-done\\a'";

fn find(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len())
        .position(|w| w == needle)
        .expect("in the transcript")
}

fn check(held: &[u8], cols: usize) -> bool {
    is_only_redrawn_echo(PROMPT, held, format!("{LINE}\n").as_bytes(), cols)
}

#[test]
fn fish_cell_by_cell_echo_is_recognised() {
    assert!(check(&fish_echo(LINE, 4, 200), 200));
}

#[test]
fn fish_echo_across_a_wrap_is_recognised() {
    for cols in [20, 33, 40] {
        assert!(check(&fish_echo(LINE, 4, cols), cols), "cols={cols}");
    }
}

/// The exact bytes fish 4.6 printed around a wrap at 40 columns.
#[test]
fn the_captured_fish_wrap_redraw_is_recognised() {
    let prompt = b"\x1b[92mme\x1b[m> \x1b]133;B\x07\x1b[K\r\x1b[35C";
    let held = b" \r\x1b[36Ci\r\x1b[37Ct\r\x1b[38C\\\r\x1b[39C\x08\\'\r\r\n\x1b[A\x1b[38C\\'s\r\x1b[C \r\x1b[2Ca\
\r\x1b[3C\x1b[?2004l\r\n";
    assert!(is_only_redrawn_echo(prompt, held, b" it\\'s a\n", 40));
}

#[test]
fn the_highlighted_redraw_on_enter_is_recognised() {
    let mut held = fish_echo(LINE, 4, 200);
    // On Enter fish may go back and redraw the whole line in colour.
    let at = find(&held, b"\x1b[?2004l");
    let redraw = format!(
        "\x1b[{}D\x1b[33m{LINE}\x1b[39m\r\x1b[{}C",
        LINE.len(),
        4 + LINE.len()
    );
    held.splice(at..at, redraw.bytes());
    assert!(check(&held, 200));
}

#[test]
fn any_other_text_is_not_the_echo() {
    let mut held = fish_echo(LINE, 4, 200);
    held.extend(b"fish: Unknown command\r\n");
    assert!(!check(&held, 200), "output after Enter");

    // An autosuggestion drawn past the typed text.
    let mut held = fish_echo(LINE, 4, 200);
    held.splice(0..0, b"\x1b[s\x1b[90mfoo".iter().copied());
    assert!(!check(&held, 200), "saved cursor + suggestion");
    let mut held = fish_echo(LINE, 4, 200);
    let tail = find(&held, b"\x1b[?2004l");
    held.splice(tail..tail, b"\x1b[90mgrey".iter().copied());
    assert!(!check(&held, 200), "text past the line");

    // A character on the wrong cell.
    let held = fish_echo(LINE, 5, 200);
    assert!(!check(&held, 200), "shifted by one");
}

#[test]
fn a_partly_drawn_line_is_not_the_echo() {
    let full = fish_echo(LINE, 4, 200);
    let half = &full[..full.len() / 2];
    assert!(!check(half, 200));
}

#[test]
fn moves_the_model_does_not_follow_are_refused() {
    for seq in [&b"\x1b[1;1H"[..], b"\x1b7", b"\x1b[2J", b"\x1b[1K", b"\t"] {
        let mut held = seq.to_vec();
        held.extend(fish_echo(LINE, 4, 200));
        assert!(!check(&held, 200), "{:?}", seq.escape_ascii().to_string());
    }
}

#[test]
fn an_erased_cell_must_be_drawn_again() {
    let mut held = fish_echo(LINE, 4, 200);
    // Clear the row from the line's start: nothing of it is left.
    held.extend(b"\r\x1b[A\x1b[4C\x1b[K");
    assert!(!check(&held, 200));
}

#[test]
fn no_width_or_a_non_ascii_line_is_never_recognised() {
    assert!(!check(&fish_echo(LINE, 4, 200), 0));
    let line = " set -gx A 'é'";
    assert!(!is_only_redrawn_echo(
        PROMPT,
        &fish_echo(line, 4, 200),
        line.as_bytes(),
        200
    ));
}

mod filter {
    //! The whole [`SetupEchoFilter`] on a fish session: the screen the user
    //! sees.
    use super::{fish_echo, LINE};
    use crate::output::setup_echo::{HideOutcome, SetupEchoFilter, REPROMPT_CAP, SETUP_DONE_MARK};
    use crate::output::test_screen::Screen;
    use std::time::{Duration, Instant};

    const COLS: usize = 40;
    const BANNER: &str = "Welcome to fish\r\n";
    const FISH_PROMPT: &str =
        "\x1b]133;A;click_events=1\x07\x1b[92mme\x1b[m@host> \x1b]133;B\x07\x1b[K\r\x1b[8C";

    /// The banner and the first prompt, then (once the line is typed) fish's
    /// echo, the setup's done mark and fish 4's next prompt.
    fn run(cell_redraw: bool) -> (Vec<u8>, SetupEchoFilter) {
        let t0 = Instant::now();
        let mut f = SetupEchoFilter::new();
        f.set_width(COLS as u16);
        f.set_cell_redraw(cell_redraw);
        let mut out = f.feed(format!("{BANNER}{FISH_PROMPT}").as_bytes(), t0);
        f.arm(format!("{LINE}\n").as_bytes(), t0);
        let mut after = fish_echo(LINE, 8, COLS);
        after.extend(SETUP_DONE_MARK);
        after.extend(b"\x1b]133;D;0\x07\x1b[2m\xe2\x8f\x8e\x1b[m      \r\xe2\x8f\x8e \r\x1b[K");
        after.extend(FISH_PROMPT.as_bytes());
        let t1 = t0 + Duration::from_millis(20);
        out.extend(f.feed(&after, t1));
        out.extend(f.poll(t1 + REPROMPT_CAP));
        (out, f)
    }

    fn screen(bytes: &[u8]) -> Vec<String> {
        let mut s = Screen::new(COLS);
        s.feed(bytes);
        s.lines()
    }

    #[test]
    fn fish_setup_is_hidden_with_cell_redraw() {
        let (out, f) = run(true);
        assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
        let text = String::from_utf8_lossy(&out);
        for leak in ["set -gx", "cmdline_url", "6973;", "]0;"] {
            assert!(!text.contains(leak), "{leak:?} shown: {text:?}");
        }
        let lines = screen(&out);
        assert_eq!(lines.first().map(String::as_str), Some(BANNER.trim_end()));
        assert!(lines.iter().all(|l| !l.contains("it\\'s")), "{lines:?}");
        assert_eq!(
            lines.iter().filter(|l| l.contains("me@host>")).count(),
            1,
            "{lines:?}"
        );
    }

    /// Without it (the behaviour before #5094) fish's wrap re-prints defeat
    /// the text match and the whole setup is shown.
    #[test]
    fn without_cell_redraw_the_fish_setup_is_shown() {
        let (out, f) = run(false);
        assert_eq!(f.outcome(), Some(HideOutcome::NotRecognised));
        assert!(String::from_utf8_lossy(&out).contains("set -gx"));
    }
}
