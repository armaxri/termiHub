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

/// Filter telnet IAC commands from raw data, responding with WONT/DONT to
/// all negotiation attempts.
///
/// Returns a `Vec<u8>` containing only the user-visible data with all IAC
/// sequences stripped. Negotiation responses (WONT for DO, DONT for WILL)
/// are written directly to the provided stream.
fn filter_telnet_commands(data: &[u8], stream: &mut TcpStream) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if data[i] == IAC && i + 1 < data.len() {
            match data[i + 1] {
                DO if i + 2 < data.len() => {
                    // Refuse all DO requests.
                    let _ = stream.write_all(&[IAC, WONT, data[i + 2]]);
                    i += 3;
                }
                WILL if i + 2 < data.len() => {
                    // Refuse all WILL offers.
                    let _ = stream.write_all(&[IAC, DONT, data[i + 2]]);
                    i += 3;
                }
                DONT | WONT if i + 2 < data.len() => {
                    // Acknowledge — just skip.
                    i += 3;
                }
                IAC => {
                    // Escaped 0xFF byte.
                    output.push(IAC);
                    i += 2;
                }
                _ => {
                    // Skip unknown IAC sequences.
                    i += 2;
                }
            }
        } else {
            output.push(data[i]);
            i += 1;
        }
    }

    output
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
            resize: false,
            persistent: false,
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

        // Expand ${env:VAR} placeholders.
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
            while alive_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let filtered = filter_telnet_commands(&buf[..n], &mut reader);
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
