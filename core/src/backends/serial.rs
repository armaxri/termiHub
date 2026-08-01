//! Serial port backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses `serial2-tokio` for native async serial I/O. This is the canonical
//! implementation shared by both the desktop and agent crates.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tracing::{debug, info};

use crate::config::SerialConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SelectOption,
    SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::serial::{open_serial_port, parse_serial_config};

/// Channel capacity for output data from the serial reader task.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Channel capacity for write data sent to the serial writer task.
const WRITE_CHANNEL_CAPACITY: usize = 256;

/// Serial port backend using `serial2-tokio`, implementing [`ConnectionType`].
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
    /// the channel. The reader task picks up the new sender on its next send.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active serial connection.
struct ConnectedState {
    /// Send bytes to the serial port writer task.
    write_tx: mpsc::Sender<Vec<u8>>,
    /// Background task reading from the serial port.
    reader_task: tokio::task::JoinHandle<()>,
    /// Background task writing to the serial port.
    writer_task: tokio::task::JoinHandle<()>,
    /// `true` while the reader task is running (i.e. port is alive).
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

fn baud_rate_options() -> Vec<SelectOption> {
    ["9600", "19200", "38400", "57600", "115200"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

fn data_bits_options() -> Vec<SelectOption> {
    ["5", "6", "7", "8"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

fn stop_bits_options() -> Vec<SelectOption> {
    ["1", "2"]
        .iter()
        .map(|&v| SelectOption {
            value: v.to_string(),
            label: v.to_string(),
        })
        .collect()
}

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

/// Minimal async byte-source abstraction for the serial reader loop.
///
/// Extracted so [`run_serial_reader`] can be unit-tested with an injected mock
/// instead of a real serial port, which would require hardware.
#[async_trait::async_trait]
trait SerialByteReader: Send + Sync {
    /// Read available bytes into `buf`, returning the number read (`0` = EOF).
    async fn read_bytes(&self, buf: &mut [u8]) -> std::io::Result<usize>;
}

#[async_trait::async_trait]
impl SerialByteReader for serial2_tokio::SerialPort {
    async fn read_bytes(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.read(buf).await
    }
}

/// Read from the serial port until EOF or a fatal error, forwarding bytes to
/// the current output subscriber.
///
/// On exit — whether the port reported EOF (`Ok(0)`) or a fatal I/O error
/// (device removed, cable unplugged, broken pipe) — the stored output sender is
/// cleared. Dropping the sender closes the output channel, which is how the
/// desktop session manager detects the session ended and emits `terminal-exit`,
/// flipping the tab out of the connected (green) state and showing the
/// disconnect overlay. Without this drop a vanished COM/serial port left the tab
/// green forever with no notification ([#1824]).
///
/// This mirrors the local-shell backend, whose reader thread clears its sender
/// on exit for exactly the same reason. Transient `TimedOut` / `WouldBlock`
/// errors are ignored so a merely quiet port is not mistaken for a lost one.
///
/// [#1824]: https://github.com/armaxri/termiHub/issues/1824
async fn run_serial_reader<R: SerialByteReader>(
    port_reader: Arc<R>,
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    alive: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 1024];
    loop {
        match port_reader.read_bytes(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let data = buf[..n].to_vec();
                // Clone the sender out before any await — MutexGuard is not Send.
                let sender = {
                    let Ok(guard) = output_tx.lock() else {
                        break;
                    };
                    guard.clone()
                };
                match sender {
                    Some(s) => {
                        if s.send(data).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue
            }
            Err(_) => break,
        }
    }

    // Port is gone or closed: mark it dead and drop the stored output sender so
    // the session manager observes the channel close and surfaces the disconnect
    // (tab dot leaves green + disconnect overlay). See the doc comment above.
    alive.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = output_tx.lock() {
        *guard = None;
    }
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
                            "Select a detected serial port, or type a device path directly."
                                .to_string(),
                        ),
                        help_text: None,
                        field_type: FieldType::SerialPort,
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
                        help_text: None,
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
                        help_text: None,
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
                        help_text: None,
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
                        help_text: None,
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
                        help_text: None,
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
            graphical: false,
            resize: false,
            persistent: true,
            terminal: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Deserialize into the shared typed [`SerialConfig`] rather than pulling
        // fields out by hand. The numeric framing fields (`baudRate`/`dataBits`/
        // `stopBits`) accept either a JSON number — stored/agent-forwarded configs
        // and `docs/remote-protocol.md` carry them that way — or a numeric string,
        // which the schema form's `Select` widgets emit. A present but non-numeric
        // value is **rejected here** instead of silently defaulting: the previous
        // `.as_str().parse().ok().unwrap_or(default)` path dropped a JSON-number
        // baud/data-bits back to the default before the hardened
        // [`parse_serial_config`] gate ever saw it, mis-framing the port with no
        // error (#2351). `parse_serial_config` remains the final validation gate.
        let config: SerialConfig = serde_json::from_value(settings).map_err(|e| {
            SessionError::InvalidConfig(format!("invalid serial configuration: {e}"))
        })?;
        let config = config.expand();
        let parsed = parse_serial_config(&config)?;

        info!(port = %parsed.port, baud_rate = parsed.baud_rate, "Opening serial port");

        let port_handle = open_serial_port(&parsed)?;
        let port = Arc::new(port_handle);

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

        // Reader task: async reads forwarded to the output channel. On exit it
        // drops the stored output sender so a lost port surfaces as a disconnect
        // (see `run_serial_reader`).
        let reader_task = tokio::spawn(run_serial_reader(
            port.clone(),
            self.output_tx.clone(),
            alive.clone(),
        ));

        // Writer task: drains the write channel and sends to the serial port.
        let port_writer = port.clone();
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAPACITY);
        let writer_task = tokio::spawn(async move {
            while let Some(data) = write_rx.recv().await {
                if port_writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        self.state = Some(ConnectedState {
            write_tx,
            reader_task,
            writer_task,
            alive,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(state) = self.state.take() {
            state.reader_task.abort();
            state.writer_task.abort();
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
        state
            .write_tx
            .try_send(data.to_vec())
            .map_err(|e| SessionError::Io(std::io::Error::other(format!("Write failed: {e}"))))
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
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
        assert!(matches!(port_field.field_type, FieldType::SerialPort));
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
    async fn connect_rejects_malformed_baud_rate() {
        // Regression for #2351: a malformed `baudRate` must surface a config
        // error, not silently open the port at the 115200 default.
        let mut serial = Serial::new();
        let settings = serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": "fast",
            "dataBits": "8",
        });
        let err = serial
            .connect(settings)
            .await
            .expect_err("malformed baud rate must be rejected");
        assert!(
            err.to_string().contains("invalid serial configuration"),
            "expected a config-parse error, got: {err}"
        );
    }

    #[tokio::test]
    async fn connect_accepts_numeric_baud_rate() {
        // Regression for #2351: a JSON-number `baudRate`/`dataBits` (the canonical
        // wire form) must parse through rather than being dropped by `.as_str()`.
        // An empty port then makes `parse_serial_config` the point of failure,
        // proving deserialization accepted the numbers instead of erroring earlier.
        let mut serial = Serial::new();
        let settings = serde_json::json!({
            "port": "",
            "baudRate": 9600,
            "dataBits": 8,
        });
        let err = serial
            .connect(settings)
            .await
            .expect_err("empty port must still fail");
        assert!(
            err.to_string().contains("must not be empty"),
            "numeric framing should parse and fail only on the empty port, got: {err}"
        );
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut serial = Serial::new();
        serial
            .disconnect()
            .await
            .expect("disconnect should not fail");
    }

    // --- run_serial_reader / lost-port disconnect (#1824) -----------------

    use std::collections::VecDeque;
    use std::io;
    use std::time::Duration;

    /// Scripted async reader returning a queue of results, then EOF.
    struct MockSerialReader {
        results: Mutex<VecDeque<io::Result<Vec<u8>>>>,
    }

    impl MockSerialReader {
        fn new(results: Vec<io::Result<Vec<u8>>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().collect()),
            }
        }
    }

    #[async_trait::async_trait]
    impl SerialByteReader for MockSerialReader {
        async fn read_bytes(&self, buf: &mut [u8]) -> io::Result<usize> {
            let next = self.results.lock().expect("mock lock").pop_front();
            match next {
                Some(Ok(bytes)) => {
                    let n = bytes.len().min(buf.len());
                    buf[..n].copy_from_slice(&bytes[..n]);
                    Ok(n)
                }
                Some(Err(e)) => Err(e),
                None => Ok(0), // exhausted → EOF
            }
        }
    }

    fn make_output_channel() -> (
        Arc<Mutex<Option<OutputSender>>>,
        tokio::sync::mpsc::Receiver<Vec<u8>>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let output_tx = Arc::new(Mutex::new(Some(tx)));
        (output_tx, rx)
    }

    /// Regression test for #1824: when the port raises a fatal I/O error (device
    /// removed / cable unplugged), the reader must drop the stored sender so the
    /// output channel closes — that is what makes the desktop emit `terminal-exit`
    /// and flip the tab out of the green "connected" state.
    #[tokio::test]
    async fn reader_drops_sender_and_closes_channel_on_fatal_error() {
        let (output_tx, mut rx) = make_output_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let reader = Arc::new(MockSerialReader::new(vec![
            Ok(b"hello".to_vec()),
            Err(io::Error::from(io::ErrorKind::BrokenPipe)),
        ]));

        run_serial_reader(reader, output_tx.clone(), alive.clone()).await;

        assert_eq!(rx.recv().await, Some(b"hello".to_vec()));
        // The channel must close so the session manager surfaces the disconnect.
        // Bounded so a regression (sender not dropped) fails cleanly, not hangs.
        let closed = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await;
        assert_eq!(
            closed,
            Ok(None),
            "channel must close on port loss so terminal-exit fires (#1824)"
        );
        assert!(
            !alive.load(Ordering::SeqCst),
            "alive must be false after the port is lost"
        );
        assert!(
            output_tx.lock().expect("lock").is_none(),
            "stored output sender must be dropped so the channel closes"
        );
    }

    /// Transient `TimedOut` / `WouldBlock` reads must not be mistaken for a lost
    /// port; the reader keeps going and only ends on a real EOF.
    #[tokio::test]
    async fn reader_ignores_transient_errors_then_ends_on_eof() {
        let (output_tx, mut rx) = make_output_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let reader = Arc::new(MockSerialReader::new(vec![
            Err(io::Error::from(io::ErrorKind::TimedOut)),
            Ok(b"data".to_vec()),
            Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Ok(Vec::new()), // Ok(0) → clean EOF
        ]));

        run_serial_reader(reader, output_tx.clone(), alive.clone()).await;

        assert_eq!(rx.recv().await, Some(b"data".to_vec()));
        let closed = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await;
        assert_eq!(closed, Ok(None), "channel must close on EOF");
        assert!(!alive.load(Ordering::SeqCst));
        assert!(output_tx.lock().expect("lock").is_none());
    }
}
