//! The opt-in Command Marks hook for a cmd.exe login shell over SSH (#5109).
//!
//! A local cmd.exe gets its `PROMPT` on the command line (`/K`), so nothing is
//! typed. Over SSH the shell is already running, so the hook is typed — and a
//! typed line has two side effects the maintainer rules out (#5127): its echo
//! stays on screen, and the console records it in its command history (the
//! up-arrow / `doskey /history` list). The typed setup handles both:
//!
//! - **History.** A leading space does not keep a line out of the console's
//!   history (measured on the Windows SSH Host lane), and `doskey /reinstall`
//!   would drop the user's macros. Instead the setup line is followed by
//!   Alt+F7 ([`CMD_CLEAR_HISTORY`]), the console's own "clear command history"
//!   key. It only clears the history, not the macros, and the history of a
//!   fresh SSH session's console holds nothing but the setup at that point:
//!   the setup is typed at the first prompt and the user's input is held until
//!   it has run ([`SetupGate`](super::remote_shell::SetupGate)).
//! - **Echo.** ConPTY renders from the console's screen, so the echo cannot be
//!   filtered out of the stream. The line erases it itself, through the
//!   console ([`cmd_erase_echo`]): it moves the cursor up over the echo's rows,
//!   which follow from the first prompt's column (read from the output,
//!   [`cursor_column`]), the line's length and the terminal's width.
//!
//! The rest of the line leaves no state behind: the erase is drawn by a child
//! cmd.exe started with `/d` (no AutoRun), `(call )` puts `ERRORLEVEL` back
//! to 0, and the only
//! lasting change is the one intended — `PROMPT` gains the OSC 133 / OSC 7
//! marks around the user's own prompt.

/// Alt+F7 as the terminal sends it (`CSI 18 ; 3 ~`): the console's "clear
/// command history" key. Its cooked line editor clears the history when it
/// reads the key, before it reads the next line, so sent right after the
/// setup line it takes that line out of the history.
pub const CMD_CLEAR_HISTORY: &str = "\x1b[18;3~";

/// The `PROMPT` the hook sets, as a cmd.exe statement (no line ending): the
/// user's own prompt (`%PROMPT%`, expanded when the line runs) between an
/// OSC 133 prompt-start mark plus an OSC 7 directory report, and an OSC 133
/// input-start mark — as the local cmd.exe hook does (`cmd_osc9_command` in
/// the session shell module), but reporting the directory as OSC 7 like the
/// PowerShell hook over SSH: `file://<host>/C:\dir`, whose backslashes a
/// `file:` URL parser reads as slashes.
///
/// The quoted `set "PROMPT=..."` keeps `&`, `|`, `<`, `>` in the user's
/// prompt literal. It is the last statement of the joined line, so a `"` in
/// the user's prompt cannot open a quote over anything after it.
pub fn cmd_hook_statement() -> &'static str {
    r#"set "PROMPT=$E]133;A$E\$E]7;file://%COMPUTERNAME%/$P$E\%PROMPT%$E]133;B$E\""#
}

/// The hook as one typed line, ended with CR: the [`cmd_hook_statement`] on
/// its own, before [`join_cmd_setup`] adds the echo erase.
pub fn cmd_hook_line() -> String {
    format!("{}\r", cmd_hook_statement())
}

/// The statement that erases the typed line's echo, `rows` rows of it.
///
/// cmd.exe has no escape for ESC on its command line, but its prompt has
/// (`$E`). So a child cmd.exe draws the erase as its prompt: `/k` runs the
/// `prompt` command and then shows the prompt — a line break, then the
/// codes — and reads its input, which is `nul`, so it exits at once. Its
/// prompt moves up over the line break and the echo's `rows` rows to the row
/// the echo began on (the first prompt's row), erases from there down, and
/// moves up one more: the session shell starts its next prompt with a line
/// break, so that prompt lands where the first one was.
///
/// The child leaves nothing behind (#5109): `/d` skips the user's AutoRun,
/// it reads no console input (no history), it sets nothing in the session
/// shell, and it is started by its full path, so no `cmd` on the `PATH` or in
/// the current directory stands in for it. `(call )` puts `ERRORLEVEL` back
/// to 0.
pub fn cmd_erase_echo(rows: usize) -> String {
    format!(
        r#""%SystemRoot%\System32\cmd.exe" /d /k prompt $E[{up}A$E[J$E[A<nul&(call )"#,
        up = rows + 1
    )
}

/// The cmd.exe session setup as one typed line (#5109): the env / X11 lines
/// (each CR-ended), the echo erase and the hook's `PROMPT`, joined with `&`,
/// ended with CR and then [`CMD_CLEAR_HISTORY`].
///
/// `prompt_col` is the column the first prompt left the cursor in (where the
/// echo starts) and `cols` the terminal's width: the echo then spans
/// `ceil((prompt_col + len) / cols)` rows. When that is an exact multiple the
/// console's wrap could go either way, so the line gets a trailing space to
/// stay clear of it. The row count's digits change the length, so it is
/// solved as a fixed point.
pub fn join_cmd_setup(lines: &[String], prompt_col: usize, cols: usize) -> String {
    let cols = cols.max(1);
    let prompt_col = prompt_col.min(cols);
    let statements: Vec<&str> = lines
        .iter()
        .map(|l| l.trim_end_matches(['\r', '\n']).trim())
        .filter(|l| !l.is_empty() && *l != cmd_hook_statement())
        .collect();
    let mut rows = 1;
    loop {
        let erase = cmd_erase_echo(rows);
        let mut all = statements.clone();
        all.push(&erase);
        all.push(cmd_hook_statement());
        let mut body = all.join("&");
        let mut len = body.chars().count();
        if (prompt_col + len).is_multiple_of(cols) {
            body.push(' ');
            len += 1;
        }
        let needed = (prompt_col + len).div_ceil(cols);
        if needed == rows {
            return format!("{body}\r{CMD_CLEAR_HISTORY}");
        }
        rows = needed;
    }
}

/// The column the cursor is left in after `data`, at a terminal `cols` wide:
/// where the first prompt ends, so where the typed setup's echo starts.
///
/// Follows what ConPTY sends for a screen: printable characters (with
/// deferred autowrap: a full row leaves the cursor at `cols`), CR, LF, BS,
/// TAB, and the CSI moves that set the column (`H`/`f`, `G`/`` ` ``, `C`,
/// `D`, `E`, `F`). Other escapes and OSC strings move nothing.
pub fn cursor_column(data: &[u8], cols: usize) -> usize {
    let cols = cols.max(1);
    let text = String::from_utf8_lossy(data);
    let mut chars = text.chars().peekable();
    let mut col = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    let mut params = String::new();
                    let mut fin = None;
                    for p in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&p) {
                            fin = Some(p);
                            break;
                        }
                        params.push(p);
                    }
                    if params.starts_with(['?', '>', '=', '<']) {
                        continue;
                    }
                    let nums: Vec<usize> =
                        params.split(';').map(|p| p.parse().unwrap_or(0)).collect();
                    let n = |i: usize| nums.get(i).copied().filter(|&v| v > 0).unwrap_or(1);
                    match fin {
                        Some('H' | 'f') => col = (n(1) - 1).min(cols - 1),
                        Some('G' | '`') => col = (n(0) - 1).min(cols - 1),
                        Some('C') => col = (col + n(0)).min(cols - 1),
                        Some('D') => col = col.min(cols - 1).saturating_sub(n(0)),
                        Some('E' | 'F') => col = 0,
                        _ => {}
                    }
                }
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(s) = chars.next() {
                        if s == '\x07' || (s == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                Some('(' | ')' | '#' | '%') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' => col = 0,
            '\x08' => col = col.min(cols - 1).saturating_sub(1),
            '\t' => col = ((col / 8 + 1) * 8).min(cols - 1),
            c if c < ' ' || c == '\x7f' => {}
            _ => {
                if col >= cols {
                    col = 0;
                }
                col += 1;
            }
        }
    }
    col
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_keeps_the_users_prompt_between_the_marks() {
        let s = cmd_hook_statement();
        assert!(s.starts_with(r#"set "PROMPT=$E]133;A$E\"#), "{s}");
        assert!(s.contains(r"$E]7;file://%COMPUTERNAME%/$P$E\"), "{s}");
        assert!(s.contains(r"%PROMPT%$E]133;B$E\"), "{s}");
        assert!(s.ends_with('"'), "{s}");
        assert_eq!(cmd_hook_line(), format!("{s}\r"));
    }

    #[test]
    fn alt_f7_is_the_vt_key() {
        assert_eq!(CMD_CLEAR_HISTORY, "\x1b[18;3~");
    }

    #[test]
    fn the_erase_moves_up_the_echo_rows_and_one_more() {
        let e = cmd_erase_echo(3);
        // Up over the child's line break and the 3 echo rows, then one more.
        assert!(e.contains("prompt $E[4A$E[J$E[A<nul"), "{e}");
        // No AutoRun, no `cmd` lookup, no `for /f` (whose child runs AutoRun).
        assert!(
            e.starts_with(r#""%SystemRoot%\System32\cmd.exe" /d /k "#),
            "{e}"
        );
        assert!(!e.contains("for /f"), "{e}");
        assert!(e.ends_with("&(call )"), "{e}");
    }

    /// The row count in the line matches the line's own length.
    fn rows_in(line: &str) -> usize {
        let at = line.find("prompt $E[").expect("erase") + 10;
        line[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap()
    }

    #[test]
    fn the_joined_line_ends_with_the_prompt_then_cr_then_alt_f7() {
        let lines = vec!["set \"A=1\"\r".to_string(), cmd_hook_line()];
        let line = join_cmd_setup(&lines, 21, 80);
        let (body, tail) = line.split_once('\r').unwrap();
        assert_eq!(tail, CMD_CLEAR_HISTORY);
        assert!(body.starts_with("set \"A=1\"&\"%SystemRoot%"), "{body}");
        assert!(body.trim_end().ends_with(cmd_hook_statement()), "{body}");
        // The hook statement appears once, even when passed in.
        assert_eq!(body.matches("set \"PROMPT=").count(), 1, "{body}");
        let len = body.chars().count();
        assert_eq!(rows_in(&line), (21 + len).div_ceil(80) + 1);
        assert_ne!((21 + len) % 80, 0);
    }

    #[test]
    fn the_row_count_follows_the_prompt_column_and_width() {
        for cols in [40, 80, 100, 120, 200, 400] {
            for col in [0, 1, 21, 39, 79, 150] {
                let line = join_cmd_setup(&[], col, cols);
                let body = line.split('\r').next().unwrap();
                let len = body.chars().count();
                let col = col.min(cols);
                assert_eq!(
                    rows_in(&line),
                    (col + len).div_ceil(cols) + 1,
                    "{cols} {col}"
                );
                assert_ne!((col + len) % cols, 0, "{cols} {col}");
            }
        }
    }

    #[test]
    fn cursor_column_follows_conpty_output() {
        let start = b"\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\
            Microsoft Windows [Version 10.0.26100.1]\r\n(c) Microsoft Corporation.\r\n\
            \x1b[4;1HC:\\Users\\me>\x1b]0;cmd\x07\x1b[?25h";
        assert_eq!(cursor_column(start, 120), "C:\\Users\\me>".len());
        assert_eq!(cursor_column(b"abc\x1b[1;7H", 80), 6);
        assert_eq!(cursor_column(b"abc\x1b[2D", 80), 1);
        assert_eq!(cursor_column(b"abcdef\x1b[3G", 80), 2);
        assert_eq!(cursor_column(b"ab\r\ncd\te", 80), 9);
        // A full row leaves the cursor past its last column (deferred wrap).
        assert_eq!(cursor_column(b"abcd", 4), 4);
        assert_eq!(cursor_column(b"abcde", 4), 1);
        // OSC strings print nothing.
        assert_eq!(
            cursor_column(b"\x1b]133;A\x1b\\x\x1b]7;file://h/C:\x07>", 80),
            2
        );
    }
}
