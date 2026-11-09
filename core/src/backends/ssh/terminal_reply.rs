//! Tell the terminal's answers to a shell's queries from the user's input,
//! for the [`SetupGate`](super::remote_shell::SetupGate) (#5094).
//!
//! fish 4 asks the terminal a few questions before it draws its first
//! prompt and waits for the Primary Device Attributes answer (up to
//! seconds) before it reads anything else. The gate holds the user's input
//! until the setup has run — so it held that answer too, and fish sat on
//! its queries while the setup it could not yet read waited for its prompt.
//! A write that is nothing but such answers is not the user's input, and a
//! fish gate lets it through.
//!
//! Only answers no key ever produces count: Device Attributes (`CSI ? … c`,
//! `CSI > … c`), the kitty keyboard flags (`CSI ? … u`), a mode report
//! (`CSI ? … $ y`), XTVERSION (`DCS > | … ST`), XTGETTCAP (`DCS 1 + r … ST`,
//! `DCS 0 + r ST`) and the colour answers (`OSC 4/10/11/12 ; …`). A cursor
//! position report (`CSI row ; col R`) is not among them: xterm sends
//! Shift+F3 as `CSI 1 ; 2 R`, and fish does not wait for one.

use crate::output::setup_echo::skip_escape;

/// Whether `data` is one or more terminal answers to queries, and nothing
/// else (see the module docs).
pub fn is_terminal_reply(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        if data[i] != 0x1b {
            return false;
        }
        let end = skip_escape(data, i).min(data.len());
        if !is_one_reply(&data[i + 1..end]) {
            return false;
        }
        i = end;
    }
    !data.is_empty()
}

/// Whether `seq` (one escape sequence, after its ESC) is a query answer.
fn is_one_reply(seq: &[u8]) -> bool {
    match seq.first() {
        Some(b'[') => {
            let Some((&fin, params)) = seq[1..].split_last() else {
                return false;
            };
            match (params.first(), fin) {
                (Some(b'?' | b'>'), b'c') | (Some(b'?'), b'u') => digits(&params[1..]),
                (Some(b'?'), b'y') => params.strip_suffix(b"$").is_some_and(|p| digits(&p[1..])),
                _ => false,
            }
        }
        Some(b'P') => {
            let body = strip_st(&seq[1..]);
            body.is_some_and(|b| b.starts_with(b">|") || b.starts_with(b"1+r") || b == b"0+r")
        }
        Some(b']') => {
            let body = strip_st(&seq[1..]);
            body.is_some_and(|b| {
                [&b"4;"[..], b"10;", b"11;", b"12;"]
                    .iter()
                    .any(|p| b.starts_with(p))
                    && b.windows(4).any(|w| w == b"rgb:")
            })
        }
        _ => false,
    }
}

/// `body` without its string terminator (ST or BEL), if it has one.
fn strip_st(body: &[u8]) -> Option<&[u8]> {
    body.strip_suffix(b"\x1b\\")
        .or_else(|| body.strip_suffix(b"\x07"))
}

/// Digits and `;` only (an empty parameter list too).
fn digits(params: &[u8]) -> bool {
    params.iter().all(|b| b.is_ascii_digit() || *b == b';')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_answers_are_replies() {
        for reply in [
            &b"\x1b[?62;22c"[..],
            b"\x1b[?1;2c",
            b"\x1b[>0;276;0c",
            b"\x1b[?0u",
            b"\x1b[?2026;2$y",
            b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
            b"\x1b]10;rgb:ffff/ffff/ffff\x07",
            b"\x1bP>|xterm.js(5.5.0)\x1b\\",
            b"\x1bP1+r696e646e=5e5b5b3270\x1b\\",
            b"\x1bP0+r\x1b\\",
            // Several in one write.
            b"\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?62;22c",
        ] {
            assert!(is_terminal_reply(reply), "{}", reply.escape_ascii());
        }
    }

    #[test]
    fn keys_and_text_are_not_replies() {
        for input in [
            &b""[..],
            b"ls\r",
            b"\x1b[A",
            b"\x1b[1;2R", // Shift+F3 — and a cursor position report
            b"\x1b[1;1R",
            b"\x1b[97u", // a kitty key report
            b"\x1b[200~paste\x1b[201~",
            b"\x1b[?62;22cls\r", // an answer with typing glued on
            b"\x1b]11;?\x07",    // a query, not an answer
            b"\x1b",
            b"\x1bOP",
        ] {
            assert!(!is_terminal_reply(input), "{}", input.escape_ascii());
        }
    }
}
