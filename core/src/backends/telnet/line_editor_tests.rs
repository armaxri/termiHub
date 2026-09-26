//! Tests for the line-mode local line editor and outgoing input preparation.

use super::*;
use crate::backends::telnet::negotiation::IAC;

fn feed(input: &[u8]) -> Edited {
    LineEditor::new().feed(input)
}

#[test]
fn printable_input_is_buffered_and_echoed() {
    let out = feed(b"ls -l");
    assert!(out.send.is_empty(), "nothing is sent before Enter");
    assert_eq!(out.echo, b"ls -l".to_vec());
}

#[test]
fn enter_sends_the_line_with_crlf() {
    let mut ed = LineEditor::new();
    ed.feed(b"whoami");
    let out = ed.feed(b"\r");
    assert_eq!(out.send, b"whoami\r\n".to_vec());
    assert_eq!(out.echo, b"\r\n".to_vec());
    // The buffer is cleared after sending.
    assert_eq!(ed.feed(b"\r").send, b"\r\n".to_vec());
}

#[test]
fn crlf_and_lone_lf_each_end_exactly_one_line() {
    let out = feed(b"a\r\nb\nc\r");
    assert_eq!(out.send, b"a\r\nb\r\nc\r\n".to_vec());
}

#[test]
fn cr_lf_split_across_writes_is_one_line() {
    let mut ed = LineEditor::new();
    let mut sent = ed.feed(b"a\r").send;
    sent.extend(ed.feed(b"\nb\r").send);
    assert_eq!(sent, b"a\r\nb\r\n".to_vec());
}

#[test]
fn backspace_and_delete_erase_the_last_character() {
    let mut ed = LineEditor::new();
    ed.feed(b"lsx");
    let out = ed.feed(&[0x7f]);
    assert_eq!(out.echo, b"\x08 \x08".to_vec());
    let out = ed.feed(&[0x08, b'\r']);
    assert_eq!(out.send, b"l\r\n".to_vec());
}

#[test]
fn backspace_on_empty_line_echoes_nothing() {
    let out = feed(&[0x7f, 0x08]);
    assert!(out.echo.is_empty());
    assert!(out.send.is_empty());
}

#[test]
fn backspace_removes_a_whole_utf8_character() {
    let mut ed = LineEditor::new();
    ed.feed("aé".as_bytes());
    ed.feed(&[0x7f]);
    assert_eq!(ed.feed(b"\r").send, b"a\r\n".to_vec());
}

#[test]
fn ctrl_u_kills_the_line() {
    let mut ed = LineEditor::new();
    ed.feed(b"abc");
    let out = ed.feed(&[0x15]);
    assert_eq!(out.echo, b"\x08 \x08\x08 \x08\x08 \x08".to_vec());
    assert_eq!(ed.feed(b"x\r").send, b"x\r\n".to_vec());
}

#[test]
fn control_characters_flush_the_line_and_pass_through() {
    let mut ed = LineEditor::new();
    ed.feed(b"sleep");
    let out = ed.feed(&[0x03]);
    assert_eq!(out.send, b"sleep\x03".to_vec());
    assert!(out.echo.is_empty(), "control characters are not echoed");
}

#[test]
fn escape_sequences_are_discarded() {
    // Arrow keys (CSI and SS3 forms) and Alt-x have no meaning in the local
    // line editor and must not end up in the line.
    let out = feed(b"a\x1b[A\x1bOB\x1b[1;5Cb\x1bxc\r");
    assert_eq!(out.send, b"abc\r\n".to_vec());
    assert_eq!(out.echo, b"abc\r\n".to_vec());
}

#[test]
fn escape_sequence_split_across_writes_is_discarded() {
    let mut ed = LineEditor::new();
    ed.feed(b"a\x1b");
    ed.feed(b"[");
    ed.feed(b"Db\r");
    let out = ed.feed(b"");
    assert!(out.send.is_empty());
    let mut ed = LineEditor::new();
    ed.feed(b"a\x1b[");
    assert_eq!(ed.feed(b"Db\r").send, b"ab\r\n".to_vec());
}

#[test]
fn take_pending_returns_and_clears_the_partial_line() {
    let mut ed = LineEditor::new();
    ed.feed(b"par");
    assert_eq!(ed.take_pending(), b"par".to_vec());
    assert!(ed.take_pending().is_empty());
}

// --- prepare_input: IAC escaping + mode switch --------------------------

#[test]
fn character_mode_passes_input_through_unechoed() {
    let mut ed = LineEditor::new();
    let out = prepare_input(&mut ed, false, b"ls");
    assert_eq!(out.send, b"ls".to_vec());
    assert!(out.echo.is_empty());
}

#[test]
fn outgoing_iac_bytes_are_doubled_in_character_mode() {
    let mut ed = LineEditor::new();
    let out = prepare_input(&mut ed, false, &[b'a', IAC, b'b']);
    assert_eq!(out.send, vec![b'a', IAC, IAC, b'b']);
}

#[test]
fn outgoing_iac_bytes_are_doubled_in_line_mode() {
    let mut ed = LineEditor::new();
    let out = prepare_input(&mut ed, true, &[b'a', IAC, b'\r']);
    assert_eq!(out.send, vec![b'a', IAC, IAC, b'\r', b'\n']);
}

#[test]
fn switching_to_server_echo_flushes_the_partial_line_first() {
    let mut ed = LineEditor::new();
    prepare_input(&mut ed, true, b"adm");
    // The server enabled ECHO mid-line: pending text goes out before new input.
    let out = prepare_input(&mut ed, false, b"in");
    assert_eq!(out.send, b"admin".to_vec());
}

// --- character mode: NVT line endings (RFC 854) --------------------------

fn pass_through(ed: &mut LineEditor, data: &[u8]) -> Vec<u8> {
    prepare_input(ed, false, data).send
}

#[test]
fn character_mode_enter_is_sent_as_cr_nul() {
    let mut ed = LineEditor::new();
    assert_eq!(pass_through(&mut ed, b"ls\r"), b"ls\r\0".to_vec());
    assert_eq!(pass_through(&mut ed, b"\r"), b"\r\0".to_vec());
}

#[test]
fn character_mode_cr_lf_stays_cr_lf() {
    let mut ed = LineEditor::new();
    assert_eq!(pass_through(&mut ed, b"a\r\nb"), b"a\r\nb".to_vec());
}

#[test]
fn character_mode_translates_every_bare_cr_in_a_write() {
    let mut ed = LineEditor::new();
    assert_eq!(
        pass_through(&mut ed, b"\r\ra\r\n\rb\r"),
        b"\r\0\r\0a\r\n\r\0b\r\0".to_vec()
    );
}

#[test]
fn character_mode_lone_lf_and_nul_pass_through_unchanged() {
    let mut ed = LineEditor::new();
    assert_eq!(pass_through(&mut ed, b"a\nb\0c"), b"a\nb\0c".to_vec());
}

#[test]
fn character_mode_cr_ending_a_write_is_not_held_back() {
    // A CR at the end of a write goes out as CR NUL immediately; the LF of a
    // following write is sent unchanged (it may be a deliberate Ctrl-J).
    let mut ed = LineEditor::new();
    assert_eq!(pass_through(&mut ed, b"a\r"), b"a\r\0".to_vec());
    assert_eq!(pass_through(&mut ed, b"\nb"), b"\nb".to_vec());
}

#[test]
fn character_mode_cr_nul_combines_with_iac_doubling() {
    let mut ed = LineEditor::new();
    assert_eq!(
        pass_through(&mut ed, &[IAC, b'\r', IAC, b'\r', b'\n']),
        vec![IAC, IAC, b'\r', 0, IAC, IAC, b'\r', b'\n']
    );
}

#[test]
fn flushed_partial_line_is_followed_by_cr_nul() {
    let mut ed = LineEditor::new();
    prepare_input(&mut ed, true, b"adm");
    // Server took over echo mid-line (e.g. password prompt): Enter goes out
    // NVT-encoded after the flushed text.
    assert_eq!(pass_through(&mut ed, b"in\r"), b"admin\r\0".to_vec());
}

#[test]
fn line_mode_enter_still_sends_cr_lf_without_nul() {
    let mut ed = LineEditor::new();
    assert_eq!(prepare_input(&mut ed, true, b"x\r").send, b"x\r\n".to_vec());
}
