//! Tests for [`SetupEchoFilter`] (#5009).
//!
//! The transcripts are the raw bytes real shells printed in a PTY when the
//! setup line was typed at their first prompt (captured on macOS with bash
//! 5.3 and zsh 5.9), shortened where only the length differed. A small screen
//! model renders what the user would see, so the tests check the screen, not
//! the byte stream.

use super::*;

const T0_MS: u64 = 0;

fn at(ms: u64) -> Instant {
    // A fixed origin keeps the arithmetic readable.
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *ORIGIN.get_or_init(Instant::now) + Duration::from_millis(ms)
}

/// The setup line as typed (shortened; the filter only needs the echo to
/// match what was typed).
const TYPED: &str =
    " __termihub_osc7(){ printf '\\e]133;A\\a'; }; printf '\\e]6973;termihub-setup-done\\a'\n";

fn done() -> String {
    String::from_utf8(SETUP_DONE_MARK.to_vec()).unwrap()
}

/// What bash prints: the rc output and first prompt, then (from the moment
/// the line is typed) readline's echo, the setup's own output and the next,
/// integrated prompt.
fn bash_before() -> String {
    "USER-RC: hello from bash_profile\r\n\x1b[?2004h$ ".to_string()
}

fn bash_after() -> String {
    format!(
        "{}\r\n\x1b[?2004l\r{}\x1b]133;D;0\x07\x1b]7;file:///tmp\x07\x1b]133;A\x07\x1b[?2004h$ \x1b]133;B\x07",
        TYPED.trim_end(),
        done()
    )
}

/// A minimal VT screen: printable text, CR, LF, BS, `CSI K`, `CSI A`, `CSI J`,
/// autowrap. Everything else is ignored.
struct Screen {
    cols: usize,
    rows: Vec<Vec<char>>,
    r: usize,
    c: usize,
}

impl Screen {
    fn new(cols: usize) -> Self {
        Self {
            cols,
            rows: vec![Vec::new()],
            r: 0,
            c: 0,
        }
    }

    fn row(&mut self) -> &mut Vec<char> {
        while self.rows.len() <= self.r {
            self.rows.push(Vec::new());
        }
        &mut self.rows[self.r]
    }

    fn feed(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data).to_string();
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => self.c = 0,
                '\n' => self.r += 1,
                '\x08' => self.c = self.c.saturating_sub(1),
                '\x1b' => match chars.next() {
                    Some('[') => {
                        let mut params = String::new();
                        let mut fin = ' ';
                        for n in chars.by_ref() {
                            if ('@'..='~').contains(&n) {
                                fin = n;
                                break;
                            }
                            params.push(n);
                        }
                        let n: usize = params.trim_start_matches('?').parse().unwrap_or(0);
                        match fin {
                            'K' if n == 2 => self.row().clear(),
                            'K' => {
                                let c = self.c;
                                self.row().truncate(c);
                            }
                            'A' => self.r = self.r.saturating_sub(n.max(1)),
                            'J' => {
                                let (r, c) = (self.r, self.c);
                                self.row().truncate(c);
                                self.rows.truncate(r + 1);
                            }
                            _ => {}
                        }
                    }
                    Some(']') => {
                        let mut prev = ' ';
                        for n in chars.by_ref() {
                            if n == '\x07' || (prev == '\x1b' && n == '\\') {
                                break;
                            }
                            prev = n;
                        }
                    }
                    _ => {}
                },
                c if c.is_control() => {}
                c => {
                    if self.c >= self.cols {
                        self.r += 1;
                        self.c = 0;
                    }
                    let col = self.c;
                    let row = self.row();
                    while row.len() < col {
                        row.push(' ');
                    }
                    if col < row.len() {
                        row[col] = c;
                    } else {
                        row.push(c);
                    }
                    self.c += 1;
                }
            }
        }
    }

    fn lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .rows
            .iter()
            .map(|r| r.iter().collect::<String>().trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines
    }
}

/// Feed `before`, arm, feed `after` in `chunk`-byte pieces, then run the
/// timers out; returns everything emitted.
fn run(before: &str, after: &str, chunk: usize) -> (Vec<u8>, SetupEchoFilter) {
    let mut f = SetupEchoFilter::new();
    let mut out = f.feed(before.as_bytes(), at(T0_MS));
    f.arm(TYPED.as_bytes(), at(10));
    for piece in after.as_bytes().chunks(chunk.max(1)) {
        out.extend(f.feed(piece, at(20)));
    }
    out.extend(f.poll(at(20) + REPROMPT_CAP));
    (out, f)
}

fn screen(bytes: &[u8]) -> Vec<String> {
    let mut s = Screen::new(80);
    s.feed(bytes);
    s.lines()
}

#[test]
fn unarmed_filter_passes_everything() {
    let mut f = SetupEchoFilter::new();
    assert_eq!(f.feed(b"hello", at(0)), b"hello");
    assert!(!f.is_active());
    assert_eq!(f.next_deadline(), None);
}

#[test]
fn bash_echo_is_removed_and_rc_output_kept() {
    let (out, f) = run(&bash_before(), &bash_after(), 4096);
    assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
    assert_eq!(screen(&out), vec!["USER-RC: hello from bash_profile", "$"]);
    let text = String::from_utf8_lossy(&out);
    assert!(!text.contains("__termihub"), "setup leaked: {text:?}");
    // The integrated prompt's marks reach the terminal; our own mark does not.
    assert!(text.contains("\x1b]133;A\x07") && text.contains("\x1b]7;file:///tmp"));
    assert!(!text.contains("6973"));
}

#[test]
fn old_behaviour_shows_the_setup_line() {
    // Without the filter (what the terminal got before #5009) the line is
    // on screen — the regression the tests above guard against.
    let mut raw = bash_before().into_bytes();
    raw.extend(bash_after().into_bytes());
    assert!(screen(&raw).iter().any(|l| l.contains("__termihub_osc7")));
}

#[test]
fn every_chunking_gives_the_same_screen() {
    let want = screen(&run(&bash_before(), &bash_after(), 4096).0);
    for chunk in [1, 2, 3, 7, 16, 64] {
        let (out, f) = run(&bash_before(), &bash_after(), chunk);
        assert_eq!(f.outcome(), Some(HideOutcome::Hidden), "chunk {chunk}");
        assert_eq!(screen(&out), want, "chunk {chunk}");
    }
}

#[test]
fn zsh_echo_with_wrap_redraws_is_removed() {
    // ZLE draws typeahead after `space BS`, and at a line wrap prints the
    // last cell, ` \r ESC[K`, then redraws the first character of the row.
    let before = "USER-RC: hello from zshrc\r\n\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                                                                               \r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jarne@host dir % \x1b[K\x1b[?2004h";
    let typed = TYPED.trim();
    let (head, tail) = typed.split_at(40);
    let (first, rest) = tail.split_at(1);
    let echo = format!(" \x08 {head}{first} \r\x1b[K{first}\r{first}{rest}");
    let after = format!(
        "{echo}\x1b[?2004l\r\r\n{}\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                                                                               \r \r\x1b]133;D;0\x07\x1b]7;file:///tmp\x07\x1b]133;A\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jarne@host dir % \x1b]133;B\x07\x1b[K\x1b[?2004h",
        done()
    );
    let (out, f) = run(before, &after, 4096);
    assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
    assert_eq!(
        screen(&out),
        vec!["USER-RC: hello from zshrc", "arne@host dir %"]
    );
}

#[test]
fn a_tty_echo_before_the_rc_output_is_never_hidden_with_it() {
    // Typed while the shell was still starting: the tty echoes the line at
    // once, then the rc output, the prompt and readline's own echo follow.
    // Only readline's echo may go; the rc output must stay.
    let before = "";
    let after = format!(
        "{typed}\r\nUSER-RC: start\r\nUSER-RC: end\r\n$ {typed}\r\n{done}\x1b]133;A\x07$ \x1b]133;B\x07",
        typed = TYPED.trim_end(),
        done = done()
    );
    let (out, f) = run(before, &after, 4096);
    assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
    let lines = screen(&out);
    assert!(lines.contains(&"USER-RC: start".to_string()), "{lines:?}");
    assert!(lines.contains(&"USER-RC: end".to_string()), "{lines:?}");
}

#[test]
fn other_output_in_the_echo_region_shows_everything() {
    // An error from the setup (or anything else) after the echo: nothing is
    // hidden, the user sees it all.
    let after = format!(
        "{}\r\nbash: syntax error near unexpected token\r\n{}$ ",
        TYPED.trim_end(),
        done()
    );
    let (out, f) = run(&bash_before(), &after, 4096);
    assert_eq!(f.outcome(), Some(HideOutcome::NotRecognised));
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("syntax error") && text.contains("__termihub_osc7"));
    assert!(text.starts_with("USER-RC"));
}

#[test]
fn no_end_mark_releases_everything_at_the_cap() {
    let mut f = SetupEchoFilter::new();
    f.arm(TYPED.as_bytes(), at(0));
    assert!(
        f.feed(b"MOTD line\r\n", at(5)).is_empty(),
        "held while waiting"
    );
    assert_eq!(f.next_deadline(), Some(at(0) + SETUP_HIDE_CAP));
    assert!(f.poll(at(100)).is_empty());
    assert_eq!(f.poll(at(0) + SETUP_HIDE_CAP), b"MOTD line\r\n");
    assert_eq!(f.outcome(), Some(HideOutcome::TimedOut));
    assert!(f.take_finished());
    assert!(!f.take_finished(), "reported once");
    assert_eq!(f.feed(b"x", at(9000)), b"x", "passes through afterwards");
}

#[test]
fn a_flood_without_end_mark_is_released_at_the_byte_cap() {
    let mut f = SetupEchoFilter::new();
    f.arm(TYPED.as_bytes(), at(0));
    let big = vec![b'y'; SETUP_HIDE_MAX_BYTES + 1];
    assert_eq!(f.feed(&big, at(1)).len(), big.len());
    assert!(!f.is_active());
}

#[test]
fn two_line_prompt_is_replaced_as_a_whole() {
    let before = "USER-RC: hi\r\n~/dir on main\r\n> ";
    let after = format!(
        "{}\r\n{}\x1b]133;A\x07~/dir on main\r\n> \x1b]133;B\x07",
        TYPED.trim_end(),
        done()
    );
    let (out, f) = run(before, &after, 4096);
    assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
    assert_eq!(screen(&out), vec!["USER-RC: hi", "~/dir on main", ">"]);
}

#[test]
fn prompt_without_input_mark_is_measured_once_quiet() {
    // A framework that rebuilds PS1 drops the B mark; the prompt counts as
    // drawn once output stays quiet.
    let mut f = SetupEchoFilter::new();
    let mut out = f.feed(b"top\r\n$ ", at(0));
    f.arm(TYPED.as_bytes(), at(1));
    let after = format!("{}\r\n{}\x1b]133;A\x07$ ", TYPED.trim_end(), done());
    out.extend(f.feed(after.as_bytes(), at(2)));
    assert!(f.is_active(), "next prompt held until measured");
    assert!(f.poll(at(2) + REPROMPT_QUIET / 2).is_empty());
    out.extend(f.poll(at(2) + REPROMPT_QUIET));
    assert!(!f.is_active());
    assert_eq!(screen(&out), vec!["top", "$"]);
}

#[test]
fn shell_that_never_prompts_again_is_released_at_the_reprompt_cap() {
    let mut f = SetupEchoFilter::new();
    let mut out = f.feed(b"$ ", at(0));
    f.arm(TYPED.as_bytes(), at(1));
    let after = format!("{}\r\n{}", TYPED.trim_end(), done());
    out.extend(f.feed(after.as_bytes(), at(2)));
    assert!(f.is_active());
    out.extend(f.poll(at(2) + REPROMPT_CAP));
    assert!(!f.is_active());
    assert!(!String::from_utf8_lossy(&out).contains("__termihub"));
}

#[test]
fn a_combined_setup_line_is_removed_whole() {
    // SSH joins the env fallback and the integration into one typed line.
    let typed = format!("export FOO='bar'; {}", TYPED.trim_start());
    let mut f = SetupEchoFilter::new();
    let mut out = f.feed(b"$ ", at(0));
    f.arm(typed.as_bytes(), at(1));
    let after = format!(
        "{}\r\n{}\x1b]133;A\x07$ \x1b]133;B\x07",
        typed.trim_end(),
        done()
    );
    out.extend(f.feed(after.as_bytes(), at(2)));
    assert_eq!(f.outcome(), Some(HideOutcome::Hidden));
    assert_eq!(screen(&out), vec!["$"]);
}

#[test]
fn a_prompt_between_two_typed_lines_is_not_hidden() {
    // Two separate lines put a prompt between the echoes: that is not only
    // our text, so everything is shown.
    let mut f = SetupEchoFilter::new();
    f.feed(b"$ ", at(0));
    f.arm(b"export FOO='bar'\n", at(1));
    f.arm(TYPED.as_bytes(), at(1));
    let after = format!("export FOO='bar'\r\n$ {}\r\n{}", TYPED.trim_end(), done());
    f.feed(after.as_bytes(), at(2));
    assert_eq!(f.outcome(), Some(HideOutcome::NotRecognised));
}

#[test]
fn only_one_hide_per_session() {
    let (_, mut f) = run(&bash_before(), &bash_after(), 4096);
    f.arm(TYPED.as_bytes(), at(5000));
    assert!(!f.is_active(), "a second setup is shown as typed");
}

#[test]
fn visible_skips_escape_sequences() {
    let vis: Vec<u8> = visible(b"\x1b[93mif\x1b[0m \x1b]0;t\x07(x\x1bP+q\x1b\\)")
        .into_iter()
        .map(|(_, b)| b)
        .collect();
    assert_eq!(vis, b"if(x)");
}
