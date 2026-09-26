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
    assert!(n.initial_offer().starts_with(&[IAC, WILL, OPT_NAWS]));
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
    n.on_command(DO, 5, &mut out);
    n.on_command(WILL, 32, &mut out);
    n.on_command(WONT, 5, &mut out);
    n.on_command(DONT, 6, &mut out);
    assert_eq!(out, vec![IAC, WONT, 5, IAC, DONT, 32]);
}

#[test]
fn escape_iac_doubles_only_ff() {
    assert_eq!(escape_iac(&[1, IAC, 2]), vec![1, IAC, IAC, 2]);
    assert_eq!(escape_iac(b"abc"), b"abc".to_vec());
}

// --- ECHO (RFC 857) / SUPPRESS-GO-AHEAD (RFC 858) -----------------------

fn line() -> Negotiator {
    Negotiator::new("xterm-256color").with_input_mode(InputMode::Line)
}

#[test]
fn input_mode_defaults_to_character() {
    assert_eq!(InputMode::default(), InputMode::Character);
    assert_eq!(neg().input_mode(), InputMode::Character);
}

#[test]
fn input_mode_parses_setting_values() {
    assert_eq!(InputMode::from_setting(Some("line")), InputMode::Line);
    assert_eq!(InputMode::from_setting(Some(" Line ")), InputMode::Line);
    assert_eq!(
        InputMode::from_setting(Some("character")),
        InputMode::Character
    );
    // Absent (old saved connections) or unknown values: character mode.
    assert_eq!(InputMode::from_setting(None), InputMode::Character);
    assert_eq!(InputMode::from_setting(Some("bogus")), InputMode::Character);
}

#[test]
fn character_mode_initial_offer_also_requests_sga() {
    let mut n = neg();
    assert_eq!(
        n.initial_offer(),
        vec![IAC, WILL, OPT_NAWS, IAC, DO, OPT_SGA]
    );
    assert!(n.initial_offer().is_empty(), "offers are sent only once");
    assert!(!n.remote_sga(), "a request alone must not enable SGA");
}

#[test]
fn line_mode_initial_offer_is_naws_only() {
    let mut n = line();
    assert_eq!(n.initial_offer(), vec![IAC, WILL, OPT_NAWS]);
}

#[test]
fn unsolicited_will_echo_is_accepted_with_do() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_ECHO, &mut out);
    assert_eq!(out, vec![IAC, DO, OPT_ECHO]);
    assert!(n.remote_echo());
}

#[test]
fn unsolicited_will_sga_is_accepted_with_do() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_SGA, &mut out);
    assert_eq!(out, vec![IAC, DO, OPT_SGA]);
    assert!(n.remote_sga());
}

#[test]
fn will_sga_acknowledging_our_do_gets_no_reply() {
    let mut n = neg();
    n.initial_offer();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_SGA, &mut out);
    assert!(
        out.is_empty(),
        "an acknowledgement must not be answered: {out:?}"
    );
    assert!(n.remote_sga());
}

#[test]
fn wont_sga_refusing_our_do_is_silent() {
    let mut n = neg();
    n.initial_offer();
    let mut out = Vec::new();
    n.on_command(WONT, OPT_SGA, &mut out);
    assert!(out.is_empty(), "a refusal of our request needs no reply");
    assert!(!n.remote_sga());
}

#[test]
fn duplicate_will_echo_is_ignored() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_ECHO, &mut out);
    out.clear();
    for _ in 0..5 {
        n.on_command(WILL, OPT_ECHO, &mut out);
    }
    assert!(out.is_empty(), "a repeated WILL must not loop: {out:?}");
    assert!(n.remote_echo());
}

#[test]
fn wont_echo_when_enabled_is_acknowledged_once() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_ECHO, &mut out);
    out.clear();
    n.on_command(WONT, OPT_ECHO, &mut out);
    assert_eq!(out, vec![IAC, DONT, OPT_ECHO]);
    assert!(!n.remote_echo());
    // A second WONT for a disabled option is not answered again.
    out.clear();
    n.on_command(WONT, OPT_ECHO, &mut out);
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn echo_can_be_toggled_repeatedly_for_password_prompts() {
    // Devices turn server echo off/on around the password prompt.
    let mut n = line();
    let mut out = Vec::new();
    for _ in 0..3 {
        n.on_command(WILL, OPT_ECHO, &mut out);
        assert!(n.remote_echo());
        n.on_command(WONT, OPT_ECHO, &mut out);
        assert!(!n.remote_echo());
    }
    let mut expected = Vec::new();
    for _ in 0..3 {
        expected.extend_from_slice(&[IAC, DO, OPT_ECHO, IAC, DONT, OPT_ECHO]);
    }
    assert_eq!(out, expected);
}

#[test]
fn do_echo_is_refused_client_never_echoes_server_data() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_ECHO, &mut out);
    assert_eq!(out, vec![IAC, WONT, OPT_ECHO]);
}

#[test]
fn do_sga_is_accepted_once() {
    let mut n = neg();
    let mut out = Vec::new();
    n.on_command(DO, OPT_SGA, &mut out);
    assert_eq!(out, vec![IAC, WILL, OPT_SGA]);
    out.clear();
    n.on_command(DO, OPT_SGA, &mut out);
    assert!(out.is_empty(), "a repeated DO must not loop: {out:?}");
    n.on_command(DONT, OPT_SGA, &mut out);
    assert_eq!(out, vec![IAC, WONT, OPT_SGA]);
}

#[test]
fn line_mode_declines_will_sga_but_accepts_will_echo() {
    let mut n = line();
    let mut out = Vec::new();
    n.on_command(WILL, OPT_SGA, &mut out);
    assert_eq!(out, vec![IAC, DONT, OPT_SGA]);
    assert!(!n.remote_sga());
    out.clear();
    n.on_command(WILL, OPT_ECHO, &mut out);
    assert_eq!(out, vec![IAC, DO, OPT_ECHO]);
}

#[test]
fn local_line_editing_only_in_line_mode_without_server_echo() {
    let mut out = Vec::new();
    let mut c = neg();
    assert!(
        !c.local_line_editing(),
        "character mode never edits locally"
    );
    c.on_command(WONT, OPT_ECHO, &mut out);
    assert!(!c.local_line_editing());

    let mut l = line();
    assert!(l.local_line_editing());
    l.on_command(WILL, OPT_ECHO, &mut out);
    assert!(
        !l.local_line_editing(),
        "server echo takes over (password prompts)"
    );
    l.on_command(WONT, OPT_ECHO, &mut out);
    assert!(l.local_line_editing());
}

#[test]
fn ping_pong_server_cannot_induce_a_loop() {
    // A misbehaving server that answers every reply with the opposite command
    // must see at most one reply per state change, never an echo of its own
    // acknowledgement. Replay each client reply back as the server's answer.
    let mut n = neg();
    let mut pending = n.initial_offer();
    pending.extend_from_slice(&[IAC, WILL, OPT_ECHO]); // simulated server kick-off
    let mut total_replies = 0;
    for _ in 0..10 {
        let mut out = Vec::new();
        let commands = option_commands(&pending);
        for &(cmd, opt) in &commands {
            let answer = match cmd {
                DO => WILL,
                DONT => WONT,
                WILL => DO,
                _ => DONT,
            };
            n.on_command(answer, opt, &mut out);
        }
        let replies = option_commands(&out);
        total_replies += replies.len();
        if replies.is_empty() {
            break;
        }
        pending = out;
    }
    assert!(
        total_replies <= 4,
        "negotiation did not settle: {total_replies}"
    );
}

/// Extract the `IAC <WILL|WONT|DO|DONT> <opt>` commands from a reply buffer,
/// skipping subnegotiations (e.g. the NAWS size report).
fn option_commands(bytes: &[u8]) -> Vec<(u8, u8)> {
    let mut cmds = Vec::new();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == IAC && matches!(bytes[i + 1], WILL | WONT | DO | DONT) {
            cmds.push((bytes[i + 1], bytes[i + 2]));
            i += 3;
        } else {
            i += 1;
        }
    }
    cmds
}
