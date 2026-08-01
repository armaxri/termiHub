//! Telnet backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses a raw TCP socket with basic telnet protocol handling (IAC command
//! filtering). This is the canonical telnet implementation, used by both the
//! desktop and agent crates (the desktop crate previously had its own
//! implementation in `src-tauri/src/terminal/telnet.rs`).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{debug, info};

use crate::config::TelnetConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SettingsField,
    SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

/// Channel capacity for output data from the telnet reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Connection timeout for TCP connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Read timeout for the reader thread (allows periodic alive checks).
const READ_TIMEOUT: Duration = Duration::from_millis(100);

// Telnet protocol constants.
const IAC: u8 = 255;
const SE: u8 = 240;
const SB: u8 = 250;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;

/// Telnet backend using a raw TCP socket, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Telnet::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Telnet {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active telnet connection.
struct ConnectedState {
    writer: Arc<Mutex<TcpStream>>,
    alive: Arc<AtomicBool>,
}

impl Telnet {
    /// Create a new disconnected `Telnet` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for Telnet {
    fn default() -> Self {
        Self::new()
    }
}

/// Parser state for [`TelnetFilter`], persisted across TCP reads so an IAC
/// sequence split across a read boundary is resumed rather than mishandled.
enum FilterState {
    /// Ordinary data flow.
    Data,
    /// Saw an `IAC` byte; awaiting the command byte.
    Iac,
    /// Saw `IAC <cmd>` where `cmd` is DO/DONT/WILL/WONT; awaiting the option byte.
    Negotiate(u8),
    /// Inside a subnegotiation (after `IAC SB`); consuming payload until `IAC SE`.
    Subneg,
    /// Inside a subnegotiation and saw an `IAC`; the next byte is either `SE`
    /// (ends the subnegotiation) or an escaped/ignored byte that keeps it open.
    SubnegIac,
}

/// Stateful filter for telnet IAC command sequences, responding with WONT/DONT
/// to all negotiation attempts.
///
/// A single [`TelnetFilter`] is created per connection and fed successive TCP
/// reads via [`filter()`](TelnetFilter::filter). Each call returns the
/// user-visible data with all IAC sequences stripped; negotiation responses
/// (WONT for DO, DONT for WILL) are written directly to the provided stream.
///
/// Because TCP delivers arbitrary chunk sizes, an IAC command or
/// subnegotiation can straddle a read boundary. The parser is a byte-at-a-time
/// state machine whose [`FilterState`] persists between calls, so a sequence
/// split across reads is resumed on the next chunk instead of leaking raw
/// bytes (a stray `0xFF`, dropped negotiation, or leaked subnegotiation
/// payload) into the terminal (#2331).
struct TelnetFilter {
    state: FilterState,
}

impl TelnetFilter {
    /// Create a new filter in the default (data) state.
    fn new() -> Self {
        Self {
            state: FilterState::Data,
        }
    }

    /// Filter one chunk of raw telnet bytes, resuming from the state left by
    /// the previous call.
    fn filter(&mut self, data: &[u8], stream: &mut TcpStream) -> Vec<u8> {
        let mut output = Vec::with_capacity(data.len());

        for &byte in data {
            match self.state {
                FilterState::Data => {
                    if byte == IAC {
                        self.state = FilterState::Iac;
                    } else {
                        output.push(byte);
                    }
                }
                FilterState::Iac => match byte {
                    IAC => {
                        // Escaped 0xFF byte.
                        output.push(IAC);
                        self.state = FilterState::Data;
                    }
                    DO | DONT | WILL | WONT => {
                        // Await the option byte before responding.
                        self.state = FilterState::Negotiate(byte);
                    }
                    SB => {
                        self.state = FilterState::Subneg;
                    }
                    _ => {
                        // Two-byte command with no option (NOP, GA, unknown) — skip.
                        self.state = FilterState::Data;
                    }
                },
                FilterState::Negotiate(cmd) => {
                    match cmd {
                        // Refuse all DO requests.
                        DO => {
                            let _ = stream.write_all(&[IAC, WONT, byte]);
                        }
                        // Refuse all WILL offers.
                        WILL => {
                            let _ = stream.write_all(&[IAC, DONT, byte]);
                        }
                        // DONT / WONT — acknowledged, nothing to send.
                        _ => {}
                    }
                    self.state = FilterState::Data;
                }
                FilterState::Subneg => {
                    // Discard subnegotiation payload; only IAC can end/escape it.
                    if byte == IAC {
                        self.state = FilterState::SubnegIac;
                    }
                }
                FilterState::SubnegIac => {
                    // `IAC SE` ends the subnegotiation; `IAC IAC` is escaped
                    // payload and anything else is malformed — either way keep
                    // consuming the subnegotiation until a real `IAC SE`.
                    self.state = if byte == SE {
                        FilterState::Data
                    } else {
                        FilterState::Subneg
                    };
                }
            }
        }

        output
    }
}

#[async_trait::async_trait]
impl ConnectionType for Telnet {
    fn type_id(&self) -> &str {
        "telnet"
    }

    fn display_name(&self) -> &str {
        "Telnet"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "telnet".to_string(),
                label: "Telnet".to_string(),
                fields: vec![
                    SettingsField {
                        key: "host".to_string(),
                        label: "Host".to_string(),
                        description: Some(
                            "Hostname or IP address of the telnet server".to_string(),
                        ),
                        help_text: None,
                        field_type: FieldType::Text,
                        required: true,
                        default: None,
                        placeholder: Some("192.168.1.1".to_string()),
                        supports_env_expansion: true,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "port".to_string(),
                        label: "Port".to_string(),
                        description: Some("TCP port number".to_string()),
                        help_text: None,
                        field_type: FieldType::Port,
                        required: true,
                        default: Some(serde_json::json!(23)),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                ],
            }],
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings JSON into TelnetConfig.
        let host = settings
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let port: u16 = settings
            .get("port")
            .and_then(|v| {
                v.as_u64()
                    .map(|n| n as u16)
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(23);

        let config = TelnetConfig { host, port };

        // Expand ${VAR} placeholders.
        let config = config.expand();

        if config.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Host must not be empty".to_string(),
            ));
        }

        let addr = format!("{}:{}", config.host, config.port);
        info!(host = %config.host, port = config.port, "Connecting telnet session");

        let socket_addr = addr.parse().map_err(|e: std::net::AddrParseError| {
            SessionError::InvalidConfig(format!("Invalid address: {e}"))
        })?;

        let stream = TcpStream::connect_timeout(&socket_addr, CONNECT_TIMEOUT)
            .map_err(|e| SessionError::SpawnFailed(format!("TCP connect failed: {e}")))?;

        // Enable TCP keepalive so a half-open connection (peer vanishes with no
        // FIN/RST — cable pull, NAT timeout, crashed host) is eventually torn
        // down by the OS instead of hanging in "Connected" forever. The dead
        // socket surfaces as a read error, the reader thread breaks, and the
        // session emits `terminal-exit` (#1123).
        crate::net::enable_tcp_keepalive(&stream);

        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to set read timeout: {e}")))?;

        // Clone for the reader thread.
        let mut reader = stream
            .try_clone()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to clone TCP stream: {e}")))?;

        let alive = Arc::new(AtomicBool::new(true));

        // Set up output channel.
        let (tx, _rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        {
            let mut guard = self
                .output_tx
                .lock()
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock output_tx: {e}")))?;
            *guard = Some(tx);
        }

        // Spawn reader thread: bridges sync TCP reads to async tokio channel.
        let alive_clone = alive.clone();
        let output_tx_clone = self.output_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut filter = TelnetFilter::new();
            while alive_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let filtered = filter.filter(&buf[..n], &mut reader);
                        if filtered.is_empty() {
                            continue;
                        }
                        let guard = output_tx_clone.lock().ok();
                        if let Some(ref guard) = guard {
                            if let Some(ref sender) = **guard {
                                let _ = sender.blocking_send(filtered);
                            } else {
                                // No sender — disconnected.
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        self.state = Some(ConnectedState {
            writer: Arc::new(Mutex::new(stream)),
            alive,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);
            // Shut down the socket to unblock the reader thread.
            if let Ok(writer) = state.writer.lock() {
                let _ = writer.shutdown(std::net::Shutdown::Both);
            }
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            debug!("Telnet session disconnected");
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|s| s.alive.load(Ordering::SeqCst))
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        let mut writer = state.writer.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!("Failed to lock writer: {e}")))
        })?;
        writer.write_all(data).map_err(SessionError::Io)?;
        writer.flush().map_err(SessionError::Io)?;
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // Basic telnet doesn't support terminal resize.
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        if let Ok(mut guard) = self.output_tx.lock() {
            *guard = Some(tx);
        }
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

#[cfg(test)]
mod tests {
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
        assert_eq!(keys.len(), 2);
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
}
