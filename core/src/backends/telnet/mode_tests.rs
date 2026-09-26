//! Tests for the ECHO / SUPPRESS-GO-AHEAD negotiation and the input-mode
//! (character vs line) setting, end to end through the backend.

use super::negotiation::{InputMode, OPT_ECHO, OPT_SGA};
use super::tests::{connect_fake, read_until};
use super::*;
use crate::connection::{FieldType, SettingsField};

fn schema_field(key: &str) -> SettingsField {
    Telnet::new()
        .settings_schema()
        .groups
        .into_iter()
        .flat_map(|g| g.fields)
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("telnet schema must expose {key}"))
}

// --- Schema / settings --------------------------------------------------

#[test]
fn schema_input_mode_defaults_to_character() {
    let field = schema_field("inputMode");
    assert!(!field.required);
    assert_eq!(field.default, Some(serde_json::json!("character")));
    match field.field_type {
        FieldType::Select { options } => {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["character", "line"]);
        }
        other => panic!("inputMode must be a select, got {other:?}"),
    }
}

#[test]
fn old_config_without_input_mode_uses_character_mode() {
    // A connection saved before the option existed has no `inputMode` key.
    let opts = parse_session_options(&serde_json::json!({"host": "h", "port": 23}));
    assert_eq!(opts.input_mode, InputMode::Character);
}

#[test]
fn input_mode_line_is_parsed() {
    let opts = parse_session_options(&serde_json::json!({"host": "h", "inputMode": "line"}));
    assert_eq!(opts.input_mode, InputMode::Line);
}

#[test]
fn validation_accepts_input_mode_values() {
    let schema = Telnet::new().settings_schema();
    for mode in ["character", "line"] {
        let settings = serde_json::json!({"host": "h", "port": 23, "inputMode": mode});
        let errors = crate::connection::validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "{mode}: {errors:?}");
    }
}

// --- Filter → negotiator wiring ----------------------------------------

#[test]
fn filter_will_echo_and_sga_are_accepted() {
    let mut neg = negotiation::Negotiator::new(DEFAULT_TERMINAL_TYPE);
    let mut resp = Vec::new();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(
        &[b'A', IAC, WILL, OPT_ECHO, IAC, WILL],
        &mut neg,
        &mut resp,
    );
    let out2 = filter.filter(&[OPT_SGA, b'B'], &mut neg, &mut resp);
    assert_eq!([out, out2].concat(), b"AB".to_vec());
    assert_eq!(resp, vec![IAC, DO, OPT_ECHO, IAC, DO, OPT_SGA]);
}

// --- End to end against the in-process fake server ---------------------

#[tokio::test(flavor = "multi_thread")]
async fn e2e_character_mode_accepts_echo_and_sga() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({})).await;
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, OPT_SGA]);
    // Server acknowledges our DO SGA and offers ECHO.
    peer.write_all(&[IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO])
        .expect("write");
    // Only ECHO is answered — the WILL SGA was the acknowledgement.
    let got = read_until(&mut peer, &[IAC, DO, OPT_ECHO]);
    assert_eq!(got, vec![IAC, DO, OPT_ECHO]);
    // Keystrokes go out unbuffered and with 0xFF doubled.
    telnet.write(&[b'x', IAC]).expect("write");
    assert_eq!(read_until(&mut peer, &[b'x', IAC, IAC]), vec![b'x', IAC, IAC]);
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_line_mode_buffers_and_echoes_locally() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({"inputMode": "line"})).await;
    let mut rx = telnet.subscribe_output();
    read_until(&mut peer, &[IAC, WILL, 31]);
    // Server offers SGA: declined in line mode.
    peer.write_all(&[IAC, WILL, OPT_SGA]).expect("write");
    assert_eq!(
        read_until(&mut peer, &[IAC, DONT, OPT_SGA]),
        vec![IAC, DONT, OPT_SGA]
    );
    telnet.write(b"ls").expect("write");
    telnet.write(b"\r").expect("write");
    assert_eq!(read_until(&mut peer, b"ls\r\n"), b"ls\r\n".to_vec());
    // The typed text was echoed locally to the terminal.
    let mut seen = Vec::new();
    while !seen.windows(4).any(|w| w == b"ls\r\n") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("echo in time")
            .expect("channel open");
        seen.extend(chunk);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_line_mode_hands_echo_to_server_while_it_echoes() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({"inputMode": "line"})).await;
    read_until(&mut peer, &[IAC, WILL, 31]);
    // Password prompt: the server takes over echo (and will not echo).
    peer.write_all(&[IAC, WILL, OPT_ECHO]).expect("write");
    read_until(&mut peer, &[IAC, DO, OPT_ECHO]);
    // Now keystrokes pass straight through (no local buffering).
    telnet.write(b"p").expect("write");
    assert_eq!(read_until(&mut peer, b"p"), b"p".to_vec());
}
