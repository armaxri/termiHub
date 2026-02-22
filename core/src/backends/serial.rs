//! Serial port backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses the `serialport` crate for cross-platform serial port access. This is
//! the canonical serial implementation, used by both the desktop and agent
//! crates (the desktop crate previously had its own implementation in
//! `src-tauri/src/terminal/serial.rs`).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tracing::{debug, info};

use crate::config::SerialConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SelectOption,
    SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::serial::parse_serial_config;

/// Channel capacity for output data from the serial reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Serial port backend using the `serialport` crate, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Serial::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Serial {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active serial connection.
struct ConnectedState {
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    alive: Arc<AtomicBool>,
}

impl Serial {
    /// Create a new disconnected `Serial` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for Serial {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper to build baud rate select options.
fn baud_rate_options() -> Vec<SelectOption> {
    ["9600", "19200", "38400", "57600", "115200"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

/// Helper to build data bits select options.
fn data_bits_options() -> Vec<SelectOption> {
    ["5", "6", "7", "8"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

/// Helper to build stop bits select options.
fn stop_bits_options() -> Vec<SelectOption> {
    ["1", "2"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

/// Helper to build parity select options.
fn parity_options() -> Vec<SelectOption> {
    vec![
        SelectOption {
            value: "none".to_string(),
            label: "None".to_string(),
        },
        SelectOption {
            value: "odd".to_string(),
            label: "Odd".to_string(),
        },
        SelectOption {
            value: "even".to_string(),
            label: "Even".to_string(),
        },
    ]
}

/// Helper to build flow control select options.
fn flow_control_options() -> Vec<SelectOption> {
    vec![
        SelectOption {
            value: "none".to_string(),
            label: "None".to_string(),
        },
        SelectOption {
            value: "hardware".to_string(),
            label: "Hardware (RTS/CTS)".to_string(),
        },
        SelectOption {
            value: "software".to_string(),
            label: "Software (XON/XOFF)".to_string(),
        },
    ]
}

#[async_trait::async_trait]
impl ConnectionType for Serial {
    fn type_id(&self) -> &str {
        "serial"
    }

    fn display_name(&self) -> &str {
        "Serial Port"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "serial".to_string(),
                label: "Serial Port".to_string(),
                fields: vec![
                    SettingsField {
                        key: "port".to_string(),
                        label: "Port".to_string(),
                        description: Some(
                            "Serial port device name (e.g., COM3, /dev/ttyUSB0)".to_string(),
                        ),
                        field_type: FieldType::Text,
                        required: true,
                        default: None,
                        placeholder: if cfg!(windows) {
                            Some("COM3".to_string())
                        } else {
                            Some("/dev/ttyUSB0".to_string())
                        },
                        supports_env_expansion: true,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "baudRate".to_string(),
                        label: "Baud Rate".to_string(),
                        description: Some("Communication speed".to_string()),
                        field_type: FieldType::Select {
                            options: baud_rate_options(),
                        },
                        required: true,
                        default: Some(serde_json::json!("115200")),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "dataBits".to_string(),
                        label: "Data Bits".to_string(),
                        description: None,
                        field_type: FieldType::Select {
                            options: data_bits_options(),
                        },
                        required: true,
                        default: Some(serde_json::json!("8")),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "stopBits".to_string(),
                        label: "Stop Bits".to_string(),
                        description: None,
                        field_type: FieldType::Select {
                            options: stop_bits_options(),
                        },
                        required: true,
                        default: Some(serde_json::json!("1")),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "parity".to_string(),
                        label: "Parity".to_string(),
                        description: None,
                        field_type: FieldType::Select {
                            options: parity_options(),
                        },
                        required: true,
                        default: Some(serde_json::json!("none")),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "flowControl".to_string(),
                        label: "Flow Control".to_string(),
                        description: None,
                        field_type: FieldType::Select {
                            options: flow_control_options(),
                        },
                        required: true,
                        default: Some(serde_json::json!("none")),
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
            persistent: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings JSON into SerialConfig.
        let port = settings
            .get("port")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let baud_rate: u32 = settings
            .get("baudRate")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(115200);
        let data_bits: u8 = settings
            .get("dataBits")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(8);
        let stop_bits: u8 = settings
            .get("stopBits")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let parity = settings
            .get("parity")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string();
        let flow_control = settings
            .get("flowControl")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string();

        let config = SerialConfig {
            port,
            baud_rate,
            data_bits,
            stop_bits,
            parity,
            flow_control,
        };

        // Expand ${env:VAR} placeholders in port name.
        let config = config.expand();

        let parsed = parse_serial_config(&config)?;

        info!(
            port = %parsed.port,
            baud_rate = parsed.baud_rate,
            "Opening serial port"
        );

        // Open the serial port.
        let port_handle = crate::session::serial::open_serial_port(&parsed)?;

        // Clone for the reader thread.
        let mut reader = port_handle
            .try_clone()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to clone serial port: {e}")))?;

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

        // Spawn reader thread: bridges sync serial reads to async tokio channel.
        let alive_clone = alive.clone();
        let output_tx_clone = self.output_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let guard = output_tx_clone.lock().ok();
                        if let Some(ref guard) = guard {
                            if let Some(ref sender) = **guard {
                                let _ = sender.blocking_send(data);
                            } else {
                                // No sender — disconnected.
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        self.state = Some(ConnectedState {
            writer: Arc::new(Mutex::new(port_handle)),
            alive,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            debug!("Serial port disconnected");
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
        // Serial ports don't have a terminal size concept.
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
        let serial = Serial::new();
        assert_eq!(serial.type_id(), "serial");
    }

    #[test]
    fn display_name() {
        let serial = Serial::new();
        assert_eq!(serial.display_name(), "Serial Port");
    }

    #[test]
    fn capabilities() {
        let serial = Serial::new();
        let caps = serial.capabilities();
        assert!(!caps.resize);
        assert!(!caps.monitoring);
        assert!(!caps.file_browser);
        assert!(caps.persistent);
    }

    #[test]
    fn not_connected_initially() {
        let serial = Serial::new();
        assert!(!serial.is_connected());
    }

    #[test]
    fn schema_has_all_fields() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        assert_eq!(schema.groups.len(), 1);
        let fields = &schema.groups[0].fields;
        let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
        assert!(keys.contains(&"port"));
        assert!(keys.contains(&"baudRate"));
        assert!(keys.contains(&"dataBits"));
        assert!(keys.contains(&"stopBits"));
        assert!(keys.contains(&"parity"));
        assert!(keys.contains(&"flowControl"));
        assert_eq!(keys.len(), 6);
    }

    #[test]
    fn schema_port_field_properties() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let port_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "port")
            .unwrap();
        assert!(port_field.required);
        assert!(port_field.supports_env_expansion);
        assert!(!port_field.supports_tilde_expansion);
        assert!(matches!(port_field.field_type, FieldType::Text));
    }

    #[test]
    fn schema_baud_rate_has_options() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let baud_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "baudRate")
            .unwrap();
        if let FieldType::Select { options } = &baud_field.field_type {
            assert!(options.iter().any(|o| o.value == "9600"));
            assert!(options.iter().any(|o| o.value == "115200"));
        } else {
            panic!("expected Select field type for baudRate");
        }
        assert_eq!(baud_field.default, Some(serde_json::json!("115200")));
    }

    #[test]
    fn schema_data_bits_has_correct_options() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "dataBits")
            .unwrap();
        if let FieldType::Select { options } = &field.field_type {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["5", "6", "7", "8"]);
        } else {
            panic!("expected Select field type for dataBits");
        }
        assert_eq!(field.default, Some(serde_json::json!("8")));
    }

    #[test]
    fn schema_parity_has_correct_options() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "parity")
            .unwrap();
        if let FieldType::Select { options } = &field.field_type {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["none", "odd", "even"]);
        } else {
            panic!("expected Select field type for parity");
        }
        assert_eq!(field.default, Some(serde_json::json!("none")));
    }

    #[test]
    fn schema_flow_control_has_correct_options() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "flowControl")
            .unwrap();
        if let FieldType::Select { options } = &field.field_type {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["none", "hardware", "software"]);
        } else {
            panic!("expected Select field type for flowControl");
        }
        assert_eq!(field.default, Some(serde_json::json!("none")));
    }

    #[test]
    fn write_when_disconnected_errors() {
        let serial = Serial::new();
        let result = serial.write(b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn resize_when_disconnected_is_ok() {
        let serial = Serial::new();
        let result = serial.resize(80, 24);
        assert!(result.is_ok());
    }

    #[test]
    fn validation_missing_port_fails() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let settings = serde_json::json!({
            "baudRate": "115200",
            "dataBits": "8",
            "stopBits": "1",
            "parity": "none",
            "flowControl": "none",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "port"));
    }

    #[test]
    fn validation_valid_settings_passes() {
        let serial = Serial::new();
        let schema = serial.settings_schema();
        let settings = serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": "115200",
            "dataBits": "8",
            "stopBits": "1",
            "parity": "none",
            "flowControl": "none",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn default_creates_disconnected() {
        let serial = Serial::default();
        assert!(!serial.is_connected());
    }

    // -----------------------------------------------------------------------
    // Integration tests (no real hardware required)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn connect_invalid_port_fails() {
        let mut serial = Serial::new();
        let settings = serde_json::json!({
            "port": "/dev/__nonexistent_serial_port__",
            "baudRate": "115200",
            "dataBits": "8",
            "stopBits": "1",
            "parity": "none",
            "flowControl": "none",
        });
        let result = serial.connect(settings).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connect_empty_port_fails() {
        let mut serial = Serial::new();
        let settings = serde_json::json!({
            "port": "",
            "baudRate": "115200",
            "dataBits": "8",
            "stopBits": "1",
            "parity": "none",
            "flowControl": "none",
        });
        let result = serial.connect(settings).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut serial = Serial::new();
        serial
            .disconnect()
            .await
            .expect("disconnect should not fail");
    }
}
