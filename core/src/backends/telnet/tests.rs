//! Unit tests for the telnet backend.

use super::*;
use crate::connection::validate_settings;

/// Filter a single whole chunk through a fresh [`TelnetFilter`].
///
/// Preserves the original whole-chunk test surface; multi-chunk tests use a
/// persistent [`TelnetFilter`] directly to exercise cross-read state.
fn filter_telnet_commands(data: &[u8], stream: &mut TcpStream) -> Vec<u8> {
    TelnetFilter::new().filter(data, stream)
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
    assert!(!caps.resize);
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
    assert_eq!(schema.groups.len(), 1);
    assert_eq!(schema.groups[0].key, "telnet");
    assert_eq!(schema.groups[0].label, "Telnet");
    let fields = &schema.groups[0].fields;
    let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
    assert!(keys.contains(&"host"));
    assert!(keys.contains(&"port"));
    assert!(keys.contains(&"connectTimeoutSecs"));
    assert_eq!(keys.len(), 3);
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
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(data, &mut stream);
    assert_eq!(result, data);
}

#[test]
fn filter_escaped_iac() {
    // IAC IAC → single 0xFF byte.
    let data = [IAC, IAC, b'A'];
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(&data, &mut stream);
    assert_eq!(result, vec![IAC, b'A']);
}

#[test]
fn filter_do_stripped() {
    // IAC DO <option> should be stripped from output.
    let data = [b'A', IAC, DO, 1, b'B'];
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(&data, &mut stream);
    assert_eq!(result, vec![b'A', b'B']);
}

#[test]
fn filter_will_stripped() {
    // IAC WILL <option> should be stripped from output.
    let data = [b'A', IAC, WILL, 3, b'B'];
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(&data, &mut stream);
    assert_eq!(result, vec![b'A', b'B']);
}

#[test]
fn filter_dont_wont_stripped() {
    // IAC DONT/WONT should be silently acknowledged (stripped).
    let data = [IAC, DONT, 1, IAC, WONT, 2, b'X'];
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(&data, &mut stream);
    assert_eq!(result, vec![b'X']);
}

#[test]
fn filter_unknown_iac_command_stripped() {
    // Unknown IAC command byte should be stripped.
    let data = [IAC, 240, b'Y'];
    let mut stream = mock_tcp_stream();
    let result = filter_telnet_commands(&data, &mut stream);
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
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&[b'A', IAC], &mut stream);
    assert_eq!(out, vec![b'A'], "trailing IAC leaked into terminal output");
}

#[test]
fn filter_split_do_across_reads() {
    // `IAC DO <opt>` split so the option byte lands in the next read.
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC, DO], &mut stream);
    out.extend(filter.filter(&[1, b'B'], &mut stream));
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_split_iac_then_command_and_option() {
    // Worst case: IAC, then WILL, then the option each in separate reads.
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[IAC], &mut stream);
    out.extend(filter.filter(&[WILL], &mut stream));
    out.extend(filter.filter(&[3, b'Z'], &mut stream));
    assert_eq!(out, vec![b'Z']);
}

#[test]
fn filter_split_escaped_iac() {
    // Escaped `IAC IAC` split across reads yields a single 0xFF.
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC], &mut stream);
    out.extend(filter.filter(&[IAC, b'B'], &mut stream));
    assert_eq!(out, vec![b'A', IAC, b'B']);
}

// --- Subnegotiation (IAC SB ... IAC SE) tests (#2331) ---

#[test]
fn filter_subnegotiation_stripped_whole() {
    // A full subnegotiation in one chunk is discarded, surrounding data kept.
    let data = [b'A', IAC, SB, 24, 1, IAC, SE, b'B'];
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&data, &mut stream);
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_subnegotiation_split_across_reads() {
    // Subnegotiation split mid-payload and mid-terminator across three reads.
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let mut out = filter.filter(&[b'A', IAC, SB, 24], &mut stream);
    out.extend(filter.filter(&[1, 2, 3, IAC], &mut stream));
    out.extend(filter.filter(&[SE, b'B'], &mut stream));
    assert_eq!(out, vec![b'A', b'B']);
}

#[test]
fn filter_escaped_iac_inside_subnegotiation() {
    // `IAC IAC` inside a subnegotiation is escaped payload, not a terminator,
    // so the SB continues until the real `IAC SE`.
    let data = [b'A', IAC, SB, 24, IAC, IAC, 5, IAC, SE, b'B'];
    let mut stream = mock_tcp_stream();
    let mut filter = TelnetFilter::new();
    let out = filter.filter(&data, &mut stream);
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
        alive: alive.clone(),
        disconnected: true,
    };

    drop(state);

    assert!(
        alive.load(Ordering::SeqCst),
        "Drop with the disconnected flag set must be a no-op (leave alive as-is)"
    );
}

/// Create a dummy TCP stream for testing `filter_telnet_commands`.
///
/// We connect to a loopback address that won't actually be used for
/// reading — only for the `write_all` calls inside the filter function,
/// which are best-effort (`let _ = ...`) anyway. This creates a pair of
/// connected streams via a TCP listener bound to localhost.
fn mock_tcp_stream() -> TcpStream {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let stream = TcpStream::connect(addr).unwrap();
    // Accept the connection so the connect succeeds.
    let _peer = listener.accept().unwrap();
    stream
}
