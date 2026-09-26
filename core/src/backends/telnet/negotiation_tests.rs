//! Byte-level tests for NAWS (RFC 1073) and TERMINAL-TYPE (RFC 1091)
//! negotiation.

use super::*;

fn neg() -> Negotiator {
    Negotiator::new("xterm-256color")
}

// --- NAWS ---------------------------------------------------------------

#[test]
fn initial_offer_is_will_naws_once() {
    let mut n = neg();
    assert_eq!(n.initial_offer(), vec![IAC, WILL, OPT_NAWS]);
    // A second call must not re-offer (the option is already pending).
    assert!(n.initial_offer().is_empty());
    assert!(!n.naws_enabled(), "offer alone must not enable NAWS");
}

#[test]
fn do_naws_after_offer_enables_and_sends_size_without_reply_will() {
    let mut n = neg();
    n.initial_offer();
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    assert!(n.naws_enabled());
    // Acknowledgement of our WILL: no second WILL, just the size report.
    assert_eq!(out, vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
}

#[test]
fn unsolicited_do_naws_answers_will_then_size() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    assert!(n.naws_enabled());
    let mut expected = vec![IAC, WILL, OPT_NAWS];
    expected.extend_from_slice(&[IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
    assert_eq!(out, expected);
}

#[test]
fn redundant_do_naws_is_ignored() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    out.clear();
    n.on_command(DO, OPT_NAWS, &mut out);
    assert!(out.is_empty(), "a repeated DO must not loop: {out:?}");
}

#[test]
fn dont_naws_refusal_of_offer_is_silent_and_disables() {
    let mut n = neg();
    n.initial_offer();
    let mut out = Vec::new();
    n.on_command(DONT, OPT_NAWS, &mut out);
    assert!(out.is_empty(), "refusing our offer needs no reply");
    assert!(!n.naws_enabled());
    // Resizes are remembered but not sent while refused.
    assert_eq!(n.resize(100, 40), None);
}

#[test]
fn dont_naws_when_enabled_answers_wont() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    out.clear();
    n.on_command(DONT, OPT_NAWS, &mut out);
    assert_eq!(out, vec![IAC, WONT, OPT_NAWS]);
    assert!(!n.naws_enabled());
}

#[test]
fn resize_sends_sb_naws_when_enabled() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    assert_eq!(
        n.resize(132, 50),
        Some(vec![IAC, SB, OPT_NAWS, 0, 132, 0, 50, IAC, SE])
    );
    // Same size again: nothing new to report.
    assert_eq!(n.resize(132, 50), None);
}

#[test]
fn resize_before_enable_is_reported_on_enable() {
    let mut n = neg();
    n.initial_offer();
    assert_eq!(n.resize(120, 40), None, "not enabled yet");
    let mut out = Vec::new();
    n.on_command(DO, OPT_NAWS, &mut out);
    assert_eq!(out, vec![IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE]);
}

#[test]
fn naws_size_bytes_equal_to_iac_are_escaped() {
    // 255 columns = 0x00FF, 511 rows = 0x01FF — each 0xFF byte is doubled.
    assert_eq!(
        naws_subnegotiation(255, 511),
        vec![IAC, SB, OPT_NAWS, 0x00, IAC, IAC, 0x01, IAC, IAC, IAC, SE]
    );
    // 0xFFFF in both halves.
    assert_eq!(
        naws_subnegotiation(u16::MAX, 0x0100),
        vec![IAC, SB, OPT_NAWS, IAC, IAC, IAC, IAC, 0x01, 0x00, IAC, SE]
    );
}

#[test]
fn naws_large_sizes_are_big_endian() {
    assert_eq!(
        naws_subnegotiation(300, 1000),
        vec![IAC, SB, OPT_NAWS, 0x01, 0x2C, 0x03, 0xE8, IAC, SE]
    );
}

// --- TERMINAL-TYPE ------------------------------------------------------

#[test]
fn do_ttype_answers_will() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_TTYPE, &mut out);
    assert_eq!(out, vec![IAC, WILL, OPT_TTYPE]);
}

#[test]
fn ttype_send_answers_is_with_configured_type() {
    let mut n = Negotiator::new("vt100");
    let mut out = Vec::new();
    n.on_command(DO, OPT_TTYPE, &mut out);
    out.clear();
    n.on_subnegotiation(&[OPT_TTYPE, TTYPE_SEND], &mut out);
    let mut expected = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
    expected.extend_from_slice(b"vt100");
    expected.extend_from_slice(&[IAC, SE]);
    assert_eq!(out, expected);
}

#[test]
fn ttype_send_before_do_is_ignored() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_subnegotiation(&[OPT_TTYPE, TTYPE_SEND], &mut out);
    assert!(out.is_empty());
}

#[test]
fn ttype_dont_after_enable_answers_wont_and_stops_answering() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_TTYPE, &mut out);
    out.clear();
    n.on_command(DONT, OPT_TTYPE, &mut out);
    assert_eq!(out, vec![IAC, WONT, OPT_TTYPE]);
    out.clear();
    n.on_subnegotiation(&[OPT_TTYPE, TTYPE_SEND], &mut out);
    assert!(out.is_empty());
}

#[test]
fn default_terminal_type_is_xterm_256color() {
    assert_eq!(DEFAULT_TERMINAL_TYPE, "xterm-256color");
    assert_eq!(Negotiator::new("").terminal_type(), "xterm-256color");
    assert_eq!(Negotiator::new("   ").terminal_type(), "xterm-256color");
}

#[test]
fn terminal_type_is_sanitized() {
    assert_eq!(sanitize_terminal_type("  vt220 "), "vt220");
    assert_eq!(sanitize_terminal_type("xt\u{e9}rm\r\n"), "xtrm");
    assert_eq!(sanitize_terminal_type(&"a".repeat(100)).len(), 40);
}

#[test]
fn other_options_are_declined() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, 1, &mut out);
    n.on_command(WILL, 3, &mut out);
    n.on_command(WONT, 5, &mut out);
    n.on_command(DONT, 6, &mut out);
    assert_eq!(out, vec![IAC, WONT, 1, IAC, DONT, 3]);
}

#[test]
fn escape_iac_doubles_only_ff() {
    assert_eq!(escape_iac(&[1, IAC, 2]), vec![1, IAC, IAC, 2]);
    assert_eq!(escape_iac(b"abc"), b"abc".to_vec());
}
