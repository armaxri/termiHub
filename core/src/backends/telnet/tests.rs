//! Unit tests for the telnet backend.

use super::*;
use crate::connection::validate_settings;
use crate::connection::{FieldType, SettingsField};
use std::io::Read;

/// Filter a single whole chunk through a fresh [`TelnetFilter`].
///
/// Preserves the original whole-chunk test surface; multi-chunk tests use a
/// persistent [`TelnetFilter`] directly to exercise cross-read state.
fn filter_telnet_commands(data: &[u8]) -> Vec<u8> {
    let (mut neg, mut resp) = test_negotiator();
    TelnetFilter::new().filter(data, &mut neg, &mut resp)
}

/// A fresh negotiator plus an empty reply buffer for filter tests.
fn test_negotiator() -> (Negotiator, Vec<u8>) {
    (Negotiator::new(DEFAULT_TERMINAL_TYPE), Vec::new())
}

#[test]
fn type_id() {
    let telnet = Telnet::new();
    assert_eq!(telnet.type_id(), "telnet");
}

#[test]
fn parse_port_setting_valid_numeric() {
    assert_eq!(parse_port_setting(Some(&serde_json::json!(2323))), 2323);
}

#[test]
fn parse_port_setting_valid_string() {
    assert_eq!(parse_port_setting(Some(&serde_json::json!("2323"))), 2323);
}

#[test]
fn parse_port_setting_missing_defaults_to_23() {
    assert_eq!(parse_port_setting(None), 23);
}

#[test]
fn parse_port_setting_max_valid_port() {
    assert_eq!(parse_port_setting(Some(&serde_json::json!(65535))), 65535);
}

#[test]
fn parse_port_setting_out_of_range_numeric_does_not_wrap() {
    // A numeric port above u16::MAX must fall back to the default, never
    // silently wrap (65536 -> 0, 70000 -> 4464) and target the wrong port.
    assert_eq!(parse_port_setting(Some(&serde_json::json!(65536))), 23);
    assert_eq!(parse_port_setting(Some(&serde_json::json!(70000))), 23);
}

#[test]
fn parse_port_setting_out_of_range_numeric_and_string_agree() {
    // The numeric and string branches must treat an out-of-range value
    // identically — both reject and fall back to the default.
    assert_eq!(
        parse_port_setting(Some(&serde_json::json!(70000))),
        parse_port_setting(Some(&serde_json::json!("70000"))),
    );
}

#[test]
fn display_name() {
    let telnet = Telnet::new();
    assert_eq!(telnet.display_name(), "Telnet");
}

#[test]
fn capabilities() {
    let telnet = Telnet::new();
    let caps = telnet.capabilities();
    // Resize is propagated via NAWS (RFC 1073, PROD-027).
    assert!(caps.resize);
    assert!(!caps.monitoring);
    assert!(!caps.file_browser);
    assert!(!caps.persistent);
}

#[test]
fn not_connected_initially() {
    let telnet = Telnet::new();
    assert!(!telnet.is_connected());
}

#[test]
fn schema_has_all_fields() {
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    assert_eq!(schema.groups.len(), 2);
    assert_eq!(schema.groups[0].key, "telnet");
    assert_eq!(schema.groups[0].label, "Telnet");
    let keys: Vec<&str> = schema.groups[0]
        .fields
        .iter()
        .map(|f| f.key.as_str())
        .collect();
    assert_eq!(
        keys,
        vec![
            "host",
            "port",
            "connectTimeoutSecs",
            "terminalType",
            "inputMode"
        ]
    );
    assert_eq!(schema.groups[1].key, "login");
    let login_keys: Vec<&str> = schema.groups[1]
        .fields
        .iter()
        .map(|f| f.key.as_str())
        .collect();
    assert_eq!(
        login_keys,
        vec![
            "authMethod",
            "username",
            "password",
            "savePassword",
            "loginPrompt",
            "passwordPrompt",
            "autoLoginTimeoutSecs",
        ]
    );
}

#[test]
fn schema_host_field_properties() {
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    let host_field = schema.groups[0]
        .fields
        .iter()
        .find(|f| f.key == "host")
        .unwrap();
    assert!(host_field.required);
    assert!(host_field.supports_env_expansion);
    assert!(!host_field.supports_tilde_expansion);
    assert!(matches!(host_field.field_type, FieldType::Text));
    assert!(host_field.default.is_none());
    assert_eq!(host_field.placeholder, Some("192.168.1.1".to_string()));
}

#[test]
fn schema_port_field_properties() {
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    let port_field = schema.groups[0]
        .fields
        .iter()
        .find(|f| f.key == "port")
        .unwrap();
    assert!(port_field.required);
    assert!(!port_field.supports_env_expansion);
    assert!(matches!(port_field.field_type, FieldType::Port));
    assert_eq!(port_field.default, Some(serde_json::json!(23)));
}

#[test]
fn schema_connect_timeout_field_properties() {
    // Mirrors the SSH `connectTimeoutSecs` field so the connect-timeout
    // surface is consistent across backends (PARITY-006): optional, numeric,
    // no default (empty falls back to the backend default).
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    let field = schema.groups[0]
        .fields
        .iter()
        .find(|f| f.key == "connectTimeoutSecs")
        .expect("telnet schema must expose connectTimeoutSecs");
    assert!(!field.required);
    assert!(field.default.is_none());
    assert!(matches!(field.field_type, FieldType::Number { .. }));
}

#[test]
fn write_when_disconnected_errors() {
    let telnet = Telnet::new();
    let result = telnet.write(b"hello");
    assert!(result.is_err());
}

#[test]
fn resize_when_disconnected_is_ok() {
    let telnet = Telnet::new();
    let result = telnet.resize(80, 24);
    assert!(result.is_ok());
}

#[test]
fn validation_missing_host_fails() {
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    let settings = serde_json::json!({
        "port": 23,
    });
    let errors = validate_settings(&schema, &settings);
    assert!(!errors.is_empty());
    assert!(errors.iter().any(|e| e.field == "host"));
}

#[test]
fn validation_valid_settings_passes() {
    let telnet = Telnet::new();
    let schema = telnet.settings_schema();
    let settings = serde_json::json!({
        "host": "192.168.1.1",
        "port": 23,
    });
    let errors = validate_settings(&schema, &settings);
    assert!(errors.is_empty(), "errors: {errors:?}");
}

#[test]
fn default_creates_disconnected() {
    let telnet = Telnet::default();
    assert!(!telnet.is_connected());
}

// --- IAC filtering tests ---

#[test]
fn filter_plain_data_unchanged() {
    // No IAC bytes — data passes through unmodified.
    let data = b"Hello, world!";
    let result = filter_telnet_commands(data);
    assert_eq!(result, data);
}

#[test]
fn filter_escaped_iac() {
    // IAC IAC → single 0xFF byte.
    let data = [IAC, IAC, b'A'];
    let result = filter_telnet_commands(&data);
    assert_eq!(result, vec![IAC, b'A']);
}

#[test]
fn filter_do_stripped() {
    // IAC DO <option> should be stripped from output.
    let data = [b'A', IAC, DO, 1, b'B'];
    let result = filter_telnet_commands(&data);
    assert_eq!(result, vec![b'A', b'B']);
}

#[test]
fn filter_will_stripped() {
    // IAC WILL <option> should be stripped from output.
    let data = [b'A', IAC, WILL, 3, b'B'];
    let result = filter_telnet_commands(&data);
    assert_eq!(result, vec![b'A', b'B']);
}

#[test]
fn filter_dont_wont_stripped() {
    // IAC DONT/WONT should be silently acknowledged (stripped).
    let data = [IAC, DONT, 1, IAC, WONT, 2, b'X'];
    let result = filter_telnet_commands(&data);
    assert_eq!(result, vec![b'X']);
}

#[test]
fn filter_unknown_iac_command_stripped() {
    // Unknown IAC command byte should be stripped.
    let data = [IAC, 240, b'Y'];
    let result = filter_telnet_commands(&data);
    assert_eq!(result, vec![b'Y']);
}

// --- Cross-read (split IAC sequence) regression tests (#2331) ---
//
// The reader thread feeds successive TCP reads through ONE persistent
// `TelnetFilter`, so an IAC sequence split across a read boundary must be
// resumed on the next chunk instead of leaking raw bytes into the terminal.

#[test]
fn filter_trailing_iac_not_leaked() {
    // A chunk ending in a lone IAC (0xFF) is the start of a command whose
    // remaining bytes arrive later — it must NOT be emitted as raw output.
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&[b'A', IAC], &mut neg, &mut resp);
    assert_eq!(out, vec![b'A'], "trailing IAC leaked into terminal output");
}

#[test]
fn filter_split_do_across_reads() {
    // `IAC DO <opt>` split so the option byte lands in the next read.
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC, DO], &mut neg, &mut resp);
    out.extend(filter.filter(&[1, b'B'], &mut neg, &mut resp));
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_split_iac_then_command_and_option() {
    // Worst case: IAC, then WILL, then the option each in separate reads.
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[IAC], &mut neg, &mut resp);
    out.extend(filter.filter(&[WILL], &mut neg, &mut resp));
    out.extend(filter.filter(&[3, b'Z'], &mut neg, &mut resp));
    assert_eq!(out, vec![b'Z']);
}

#[test]
fn filter_split_escaped_iac() {
    // Escaped `IAC IAC` split across reads yields a single 0xFF.
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC], &mut neg, &mut resp);
    out.extend(filter.filter(&[IAC, b'B'], &mut neg, &mut resp));
    assert_eq!(out, vec![b'A', IAC, b'B']);
}

// --- Subnegotiation (IAC SB ... IAC SE) tests (#2331) ---

#[test]
fn filter_subnegotiation_stripped_whole() {
    // A full subnegotiation in one chunk is discarded, surrounding data kept.
    let data = [b'A', IAC, SB, 24, 1, IAC, SE, b'B'];
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&data, &mut neg, &mut resp);
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_subnegotiation_split_across_reads() {
    // Subnegotiation split mid-payload and mid-terminator across three reads.
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC, SB, 24], &mut neg, &mut resp);
    out.extend(filter.filter(&[1, 2, 3, IAC], &mut neg, &mut resp));
    out.extend(filter.filter(&[SE, b'B'], &mut neg, &mut resp));
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_escaped_iac_inside_subnegotiation() {
    // `IAC IAC` inside a subnegotiation is escaped payload, not a terminator,
    // so the SB continues until the real `IAC SE`.
    let data = [b'A', IAC, SB, 24, IAC, IAC, 5, IAC, SE, b'B'];
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&data, &mut neg, &mut resp);
    assert_eq!(out, vec![b'A', b'B']);
}

// --- Integration tests ---

#[tokio::test]
async fn connect_invalid_host_fails() {
    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": "192.0.2.1",
        "port": 1,
    });
    let result = telnet.connect(settings).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn connect_empty_host_fails() {
    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": "",
        "port": 23,
    });
    let result = telnet.connect(settings).await;
    assert!(result.is_err());
}

/// A pre-cancelled token aborts the (blocking) DNS-resolve + TCP-connect
/// before it is even started — no socket work happens — and surfaces the
/// shared cancellation error, leaving the backend disconnected (PARITY-007).
#[tokio::test]
async fn connect_cancellable_precancelled_aborts_before_connecting() {
    let mut telnet = Telnet::new();
    let token = CancellationToken::new();
    token.cancel();
    let result = telnet
        .connect_cancellable(
            serde_json::json!({ "host": "telnet.example.com", "port": 23 }),
            Some(token),
        )
        .await;
    assert!(
        matches!(&result, Err(SessionError::SpawnFailed(m)) if m.contains("cancelled")),
        "expected cancellation error, got {result:?}"
    );
    assert!(!telnet.is_connected());
}

/// With no token the cancellable path behaves exactly as `connect`: an empty
/// host fails the same way, before any TCP work.
#[tokio::test]
async fn connect_cancellable_none_matches_connect() {
    let settings = serde_json::json!({ "host": "", "port": 23 });
    let plain = Telnet::new().connect(settings.clone()).await;
    let cancellable = Telnet::new().connect_cancellable(settings, None).await;
    assert!(plain.is_err());
    assert!(cancellable.is_err());
    assert!(!Telnet::new().is_connected());
}

#[tokio::test]
async fn disconnect_when_not_connected_is_noop() {
    let mut telnet = Telnet::new();
    telnet
        .disconnect()
        .await
        .expect("disconnect should not fail");
}

/// Regression test for #1123: a half-open telnet connection (peer vanishes
/// with no FIN/RST) must eventually be torn down instead of hanging in
/// "Connected" forever. The mechanism is TCP keepalive on the socket — the
/// OS probes the dead peer, the read fails, the reader thread breaks, and
/// the session emits `terminal-exit`. Without keepalive the socket never
/// fails and the read loop spins on `TimedOut` indefinitely.
///
/// We assert the observable precondition: after a successful connect, the
/// underlying socket has keepalive enabled.
#[tokio::test]
async fn connect_enables_tcp_keepalive() {
    // Local listener stands in for a telnet server; accept and hold the
    // peer so the connection stays established for the assertion.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || listener.accept());

    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": addr.ip().to_string(),
        "port": addr.port(),
    });
    telnet
        .connect(settings)
        .await
        .expect("connect should succeed");
    let _peer = accept.join().expect("accept thread").expect("accept");

    let state = telnet.state.as_ref().expect("connected state");
    let writer = state.writer.lock().expect("lock writer");
    let keepalive = socket2::SockRef::from(&*writer)
        .keepalive()
        .expect("read keepalive flag");
    assert!(
        keepalive,
        "telnet socket must have TCP keepalive enabled to detect half-open connections (#1123)"
    );
}

/// Regression test for CORE-015: connecting by **hostname** (not a bare IP
/// literal) must succeed. The old path parsed `host:port` straight into a
/// `SocketAddr`, which only accepts numeric IPs, so any hostname failed with
/// "Invalid address". The connect path now resolves via DNS first.
#[tokio::test]
async fn connect_by_hostname_resolves_and_succeeds() {
    // Local listener stands in for a telnet server; accept and hold the peer
    // so the connection stays established for the assertion.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("local_addr").port();
    let accept = std::thread::spawn(move || listener.accept());

    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        // A hostname, not an IP literal — this is what the old code rejected.
        "host": "localhost",
        "port": port,
    });
    telnet
        .connect(settings)
        .await
        .expect("connecting to a hostname should resolve and succeed");
    let _peer = accept.join().expect("accept thread").expect("accept");

    assert!(telnet.is_connected());
}

// --- Drop guard (CORE-020) --------------------------------------------

/// Bind a loopback listener, connect a client stream, and accept the peer.
/// Returns `(client, peer)` — a genuinely connected TCP pair for exercising
/// the Drop guard's socket teardown.
fn connected_pair() -> (TcpStream, TcpStream) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let accept = std::thread::spawn(move || listener.accept());
    let client = TcpStream::connect(addr).expect("connect");
    let (peer, _) = accept.join().expect("accept thread").expect("accept");
    (client, peer)
}

/// Regression for CORE-020. Dropping a connected telnet state WITHOUT a
/// graceful `disconnect()` must still mark the session dead (so the reader
/// thread — which owns its own cloned socket — stops instead of leaking) and
/// shut the socket down, via the `Drop` guard.
#[tokio::test]
async fn drop_without_disconnect_marks_dead_and_closes_socket() {
    let (client, mut peer) = connected_pair();
    let alive = Arc::new(AtomicBool::new(true));
    let state = ConnectedState {
        writer: Arc::new(Mutex::new(client)),
        negotiator: Arc::new(Mutex::new(Negotiator::new(DEFAULT_TERMINAL_TYPE))),
        alive: alive.clone(),
        disconnected: false,
    };

    // Drop the state without ever calling disconnect().
    drop(state);

    assert!(
        !alive.load(Ordering::SeqCst),
        "Drop must mark the session dead so the reader thread stops (CORE-020)"
    );
    // The peer observes EOF now that the socket has been shut down/closed —
    // the OS-level resource was released rather than left dangling.
    let mut buf = [0u8; 1];
    let n = peer.read(&mut buf).expect("peer read after teardown");
    assert_eq!(n, 0, "peer must see EOF once the socket is torn down");
}

/// Double-teardown guard for CORE-020. A graceful `disconnect()` already
/// shut the socket down and set `disconnected = true`; the subsequent drop of
/// the taken state must be a pure no-op — it must not touch `alive` or the
/// socket again.
#[tokio::test]
async fn drop_after_disconnect_flag_is_noop() {
    let (client, _peer) = connected_pair();
    let alive = Arc::new(AtomicBool::new(true));
    let state = ConnectedState {
        writer: Arc::new(Mutex::new(client)),
        negotiator: Arc::new(Mutex::new(Negotiator::new(DEFAULT_TERMINAL_TYPE))),
        alive: alive.clone(),
        disconnected: true,
    };

    drop(state);

    assert!(
        alive.load(Ordering::SeqCst),
        "Drop with the disconnected flag set must be a no-op (leave alive as-is)"
    );
}

// --- Schema: terminal type + auto-login (PROD-025) ---------------------

fn schema_field(key: &str) -> SettingsField {
    Telnet::new()
        .settings_schema()
        .groups
        .into_iter()
        .flat_map(|g| g.fields)
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("telnet schema must expose {key}"))
}

#[test]
fn schema_terminal_type_defaults_to_xterm_256color() {
    let field = schema_field("terminalType");
    assert!(!field.required);
    assert_eq!(field.default, Some(serde_json::json!("xterm-256color")));
}

#[test]
fn schema_auto_login_is_off_by_default() {
    let field = schema_field("authMethod");
    assert_eq!(field.default, Some(serde_json::json!("none")));
    match field.field_type {
        FieldType::Select { options } => {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["none", "password"]);
        }
        other => panic!("authMethod must be a select, got {other:?}"),
    }
}

#[test]
fn schema_credential_fields_only_visible_with_auto_login() {
    for key in [
        "username",
        "password",
        "savePassword",
        "loginPrompt",
        "passwordPrompt",
        "autoLoginTimeoutSecs",
    ] {
        let field = schema_field(key);
        let cond = field
            .visible_when
            .unwrap_or_else(|| panic!("{key} must be gated on authMethod"));
        assert_eq!(cond.field, "authMethod", "{key}");
        assert_eq!(cond.equals, serde_json::json!("password"), "{key}");
    }
    assert!(matches!(
        schema_field("password").field_type,
        FieldType::Password
    ));
}

#[test]
fn schema_auto_login_help_warns_about_cleartext() {
    for key in ["authMethod", "username", "password"] {
        let help = schema_field(key).help_text.unwrap_or_default();
        assert!(help.contains("cleartext"), "{key} help must warn: {help}");
    }
}

#[test]
fn password_prompt_info_found_only_with_auto_login() {
    use crate::connection::schema_defaults::find_password_prompt_info;
    let schema = Telnet::new().settings_schema();
    let manual = serde_json::json!({"host": "h", "authMethod": "none"});
    assert!(
        find_password_prompt_info(&schema, manual.as_object().unwrap_or(&Default::default()))
            .is_none()
    );
    let auto = serde_json::json!({"host": "h", "authMethod": "password", "username": "u"});
    let info = find_password_prompt_info(&schema, auto.as_object().unwrap_or(&Default::default()))
        .expect("auto-login without a password must prompt at connect");
    assert_eq!(info.password_key, "password");
    assert_eq!(info.username_key, "username");
}

#[test]
fn validation_auto_login_settings_pass() {
    let schema = Telnet::new().settings_schema();
    let settings = serde_json::json!({
        "host": "10.0.0.1",
        "port": 23,
        "terminalType": "vt100",
        "authMethod": "password",
        "username": "admin",
        "savePassword": true,
        "loginPrompt": "login:",
        "passwordPrompt": "password:",
        "autoLoginTimeoutSecs": 5,
    });
    let errors = validate_settings(&schema, &settings);
    assert!(errors.is_empty(), "errors: {errors:?}");
}

// --- Session option parsing --------------------------------------------

#[test]
fn parse_options_defaults() {
    let opts = parse_session_options(&serde_json::json!({"host": "h"}));
    assert_eq!(opts.terminal_type, "xterm-256color");
    assert!(opts.auto_login.is_none(), "auto-login must be opt-in");
}

#[test]
fn parse_options_manual_ignores_credentials() {
    let opts = parse_session_options(&serde_json::json!({
        "authMethod": "none", "username": "u", "password": "p",
    }));
    assert!(opts.auto_login.is_none());
}

#[test]
fn parse_options_auto_login() {
    let opts = parse_session_options(&serde_json::json!({
        "terminalType": "vt220",
        "authMethod": "password",
        "username": " admin ",
        "password": "hunter2",
        "autoLoginTimeoutSecs": "7",
    }));
    assert_eq!(opts.terminal_type, "vt220");
    let cfg = opts.auto_login.expect("auto-login enabled");
    assert_eq!(cfg.username, "admin");
    assert_eq!(cfg.password.as_deref(), Some("hunter2"));
    assert_eq!(cfg.timeout, Duration::from_secs(7));
    assert!(!format!("{cfg:?}").contains("hunter2"));
}

#[test]
fn parse_options_zero_timeout_uses_default() {
    let opts = parse_session_options(&serde_json::json!({
        "authMethod": "password", "username": "u", "autoLoginTimeoutSecs": 0,
    }));
    let cfg = opts.auto_login.expect("auto-login enabled");
    assert_eq!(
        cfg.timeout,
        Duration::from_secs(DEFAULT_AUTO_LOGIN_TIMEOUT_SECS)
    );
}

// --- Filter → negotiator wiring ----------------------------------------

#[test]
fn filter_do_naws_replies_will_and_size() {
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&[b'A', IAC, DO, 31, b'B'], &mut neg, &mut resp);
    assert_eq!(out, vec![b'A', b'B']);
    assert_eq!(
        resp,
        vec![IAC, WILL, 31, IAC, SB, 31, 0, 80, 0, 24, IAC, SE]
    );
}

#[test]
fn filter_ttype_send_split_across_reads_replies_is() {
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    filter.filter(&[IAC, DO, 24], &mut neg, &mut resp);
    resp.clear();
    let mut out = filter.filter(&[b'x', IAC, SB, 24], &mut neg, &mut resp);
    out.extend(filter.filter(&[1, IAC], &mut neg, &mut resp));
    out.extend(filter.filter(&[SE, b'y'], &mut neg, &mut resp));
    assert_eq!(out, vec![b'x', b'y']);
    let mut expected = vec![IAC, SB, 24, 0];
    expected.extend_from_slice(b"xterm-256color");
    expected.extend_from_slice(&[IAC, SE]);
    assert_eq!(resp, expected);
}

#[test]
fn filter_runaway_subnegotiation_is_bounded() {
    let (mut neg, mut resp) = test_negotiator();
    let mut filter = TelnetFilter::new();
    let mut data = vec![IAC, SB, 24];
    data.extend(std::iter::repeat_n(7u8, 10_000));
    let out = filter.filter(&data, &mut neg, &mut resp);
    assert!(out.is_empty());
    assert!(filter.subneg.len() <= MAX_SUBNEG_LEN);
}

// --- End-to-end against an in-process fake telnet server ---------------

/// Read from `peer` until `expected` appears in the accumulated bytes (or the
/// 5 s read timeout fires). Returns everything read.
pub(super) fn read_until(peer: &mut TcpStream, expected: &[u8]) -> Vec<u8> {
    peer.set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set timeout");
    let mut acc = Vec::new();
    let mut buf = [0u8; 256];
    while !acc.windows(expected.len()).any(|w| w == expected) {
        let n = peer.read(&mut buf).expect("fake server read");
        assert!(
            n > 0,
            "client closed before sending {expected:?}; got {acc:?}"
        );
        acc.extend_from_slice(&buf[..n]);
    }
    acc
}

/// Connect a [`Telnet`] to a local fake server and return both ends.
pub(super) async fn connect_fake(extra: serde_json::Value) -> (Telnet, TcpStream) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("local_addr").port();
    let accept = std::thread::spawn(move || listener.accept());
    let mut settings = serde_json::json!({"host": "127.0.0.1", "port": port});
    if let (Some(s), Some(e)) = (settings.as_object_mut(), extra.as_object()) {
        s.extend(e.clone());
    }
    let mut telnet = Telnet::new();
    telnet.connect(settings).await.expect("connect");
    let (peer, _) = accept.join().expect("accept thread").expect("accept");
    (telnet, peer)
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_naws_offer_accept_and_resize() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({})).await;
    // The client proactively offers NAWS.
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, 3]);
    // Server agrees; client reports the default size without re-sending WILL.
    peer.write_all(&[IAC, DO, 31]).expect("write");
    let got = read_until(&mut peer, &[IAC, SE]);
    assert_eq!(got, vec![IAC, SB, 31, 0, 80, 0, 24, IAC, SE]);
    // A resize sends a fresh SB NAWS — 255 columns exercises IAC escaping.
    telnet.resize(255, 50).expect("resize");
    let got = read_until(&mut peer, &[IAC, SE]);
    assert_eq!(got, vec![IAC, SB, 31, 0, IAC, IAC, 0, 50, IAC, SE]);
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_naws_refused_resize_sends_nothing() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({})).await;
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, 3]);
    peer.write_all(&[IAC, DONT, 31]).expect("write");
    // Give the reader thread time to process the refusal.
    std::thread::sleep(Duration::from_millis(300));
    telnet
        .resize(100, 40)
        .expect("resize must not error when refused");
    telnet.write(b"!").expect("write marker");
    // The next byte the server sees is the marker, not an SB NAWS.
    let got = read_until(&mut peer, b"!");
    assert_eq!(got, b"!".to_vec());
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_ttype_reports_configured_type() {
    let (_telnet, mut peer) = connect_fake(serde_json::json!({"terminalType": "vt100"})).await;
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, 3]);
    peer.write_all(&[IAC, DO, 24]).expect("write");
    read_until(&mut peer, &[IAC, WILL, 24]);
    peer.write_all(&[IAC, SB, 24, 1, IAC, SE]).expect("write");
    let got = read_until(&mut peer, &[IAC, SE]);
    let mut expected = vec![IAC, SB, 24, 0];
    expected.extend_from_slice(b"vt100");
    expected.extend_from_slice(&[IAC, SE]);
    assert_eq!(got, expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_auto_login_sends_username_and_password() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({
        "authMethod": "password",
        "username": "admin",
        "password": "hunter2",
    }))
    .await;
    let mut rx = telnet.subscribe_output();
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, 3]);
    peer.write_all(b"Welcome\r\nrouter login: ").expect("write");
    read_until(&mut peer, b"admin\r\n");
    peer.write_all(b"Password: ").expect("write");
    read_until(&mut peer, b"hunter2\r\n");
    // The prompts still reach the terminal.
    let mut seen = Vec::new();
    while !seen.windows(9).any(|w| w == b"Password:") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("output in time")
            .expect("channel open");
        seen.extend(chunk);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_manual_login_sends_nothing_at_prompt() {
    let (telnet, mut peer) = connect_fake(serde_json::json!({
        "authMethod": "none",
        "username": "admin",
        "password": "hunter2",
    }))
    .await;
    read_until(&mut peer, &[IAC, WILL, 31, IAC, DO, 3]);
    peer.write_all(b"login: ").expect("write");
    std::thread::sleep(Duration::from_millis(300));
    telnet.write(b"!").expect("write marker");
    assert_eq!(read_until(&mut peer, b"!"), b"!".to_vec());
}
