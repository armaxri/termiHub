//! Serial port session helpers shared between desktop and agent.
//!
//! Provides config parsing (string → `serialport` enums), port opening,
//! port listing, and a reconnect-capable reader loop. Both the desktop
//! backend (`src-tauri/src/terminal/serial.rs`) and the agent backend
//! (`agent/src/serial/backend.rs`) delegate to these helpers so the
//! logic lives in one place.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::buffer::RingBuffer;
use crate::config::SerialConfig;
use crate::errors::SessionError;

/// Pre-parsed serial port configuration cached for reconnection.
///
/// Holds `serialport` enum values so they don't need to be re-parsed
/// on every reconnect attempt. Constructed via [`parse_serial_config`].
#[derive(Debug, Clone)]
pub struct ParsedSerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: serialport::DataBits,
    pub stop_bits: serialport::StopBits,
    pub parity: serialport::Parity,
    pub flow_control: serialport::FlowControl,
}

/// Parse a [`SerialConfig`] into a [`ParsedSerialConfig`] with validated
/// `serialport` enum values.
///
/// # Mapping rules
///
/// | Field          | Input                      | Output                          |
/// |----------------|----------------------------|---------------------------------|
/// | `data_bits`    | 5, 6, 7, 8 (default 8)    | `DataBits::{Five..Eight}`       |
/// | `stop_bits`    | 1, 2 (default 1)           | `StopBits::{One,Two}`           |
/// | `parity`       | "none","odd","even" (def.) | `Parity::{None,Odd,Even}`       |
/// | `flow_control` | "none","hardware","software" (def.) | `FlowControl::{None,Hardware,Software}` |
///
/// Returns [`SessionError::InvalidConfig`] if the port name is empty.
pub fn parse_serial_config(config: &SerialConfig) -> Result<ParsedSerialConfig, SessionError> {
    if config.port.is_empty() {
        return Err(SessionError::InvalidConfig(
            "serial port name must not be empty".into(),
        ));
    }

    let data_bits = match config.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };

    let stop_bits = match config.stop_bits {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    };

    let parity = match config.parity.as_str() {
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    };

    let flow_control = match config.flow_control.as_str() {
        "hardware" => serialport::FlowControl::Hardware,
        "software" => serialport::FlowControl::Software,
        _ => serialport::FlowControl::None,
    };

    Ok(ParsedSerialConfig {
        port: config.port.clone(),
        baud_rate: config.baud_rate,
        data_bits,
        stop_bits,
        parity,
        flow_control,
    })
}

/// Open a serial port using a pre-parsed configuration.
///
/// The port is opened with a 100 ms read timeout, matching both
/// the desktop and agent implementations.
pub fn open_serial_port(
    config: &ParsedSerialConfig,
) -> Result<Box<dyn serialport::SerialPort>, SessionError> {
    serialport::new(&config.port, config.baud_rate)
        .data_bits(config.data_bits)
        .stop_bits(config.stop_bits)
        .parity(config.parity)
        .flow_control(config.flow_control)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to open serial port: {}", e)))
}

/// List available serial port names on the system.
///
/// Returns an empty vector if enumeration fails (e.g. on platforms
/// where no serial driver is loaded).
pub fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

/// Status of a serial port connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SerialStatus {
    Connected,
    Disconnected,
    Reconnecting,
    Error(String),
}

/// Reconnect interval used by [`serial_reader_loop`].
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// Background serial port reader loop with automatic reconnection.
///
/// Opens the port via [`open_serial_port`], reads data into a ring
/// buffer, and calls `output_fn` for every chunk received. On read
/// errors (other than timeout), enters a reconnect loop that retries
/// every 3 seconds until the port reappears or `closed` is set.
///
/// # Arguments
///
/// * `config` — Pre-parsed serial config (used for initial open and reconnects).
/// * `ring_buffer` — Shared ring buffer for 24/7 data capture.
/// * `alive` — Set to `true` while the port is connected, `false`
///   during disconnect/reconnect.
/// * `closed` — Set to `true` by the caller to request shutdown.
/// * `output_fn` — Called with each chunk of received bytes. Consumers
///   decide whether to forward (e.g., only when attached).
/// * `status_fn` — Called on connection state changes.
pub fn serial_reader_loop(
    config: &ParsedSerialConfig,
    ring_buffer: Arc<Mutex<RingBuffer>>,
    alive: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    output_fn: impl Fn(&[u8]) + Send,
    status_fn: impl Fn(SerialStatus) + Send,
) {
    // --- Initial open ---------------------------------------------------
    let port = match open_serial_port(config) {
        Ok(p) => p,
        Err(e) => {
            status_fn(SerialStatus::Error(e.to_string()));
            alive.store(false, Ordering::SeqCst);
            // Fall directly into the reconnect loop
            reconnect_loop_inner(
                config,
                &ring_buffer,
                &alive,
                &closed,
                &output_fn,
                &status_fn,
            );
            return;
        }
    };

    let mut reader = match port.try_clone() {
        Ok(r) => r,
        Err(e) => {
            status_fn(SerialStatus::Error(format!(
                "Failed to clone serial port: {}",
                e
            )));
            alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    alive.store(true, Ordering::SeqCst);
    status_fn(SerialStatus::Connected);

    read_loop(
        config,
        &mut reader,
        &ring_buffer,
        &alive,
        &closed,
        &output_fn,
        &status_fn,
    );

    alive.store(false, Ordering::SeqCst);
}

/// Core read loop — extracted so it can be re-entered after reconnection.
fn read_loop(
    config: &ParsedSerialConfig,
    reader: &mut Box<dyn serialport::SerialPort>,
    ring_buffer: &Arc<Mutex<RingBuffer>>,
    alive: &Arc<AtomicBool>,
    closed: &Arc<AtomicBool>,
    output_fn: &(impl Fn(&[u8]) + Send),
    status_fn: &(impl Fn(SerialStatus) + Send),
) {
    let mut buf = [0u8; 1024];

    loop {
        if closed.load(Ordering::SeqCst) {
            return;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — port closed
                return;
            }
            Ok(n) => {
                let data = &buf[..n];

                // Always store in ring buffer
                {
                    let mut rb = ring_buffer.lock().unwrap();
                    rb.write(data);
                }

                output_fn(data);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) => {
                alive.store(false, Ordering::SeqCst);
                status_fn(SerialStatus::Disconnected);
                status_fn(SerialStatus::Error(e.to_string()));

                // Attempt reconnection
                reconnect_loop_inner(config, ring_buffer, alive, closed, output_fn, status_fn);
                return;
            }
        }
    }
}

/// Retry opening the serial port every [`RECONNECT_INTERVAL`] until
/// success or `closed` is set. On success, enters the read loop.
fn reconnect_loop_inner(
    config: &ParsedSerialConfig,
    ring_buffer: &Arc<Mutex<RingBuffer>>,
    alive: &Arc<AtomicBool>,
    closed: &Arc<AtomicBool>,
    output_fn: &(impl Fn(&[u8]) + Send),
    status_fn: &(impl Fn(SerialStatus) + Send),
) {
    loop {
        if closed.load(Ordering::SeqCst) {
            return;
        }

        std::thread::sleep(RECONNECT_INTERVAL);

        if closed.load(Ordering::SeqCst) {
            return;
        }

        status_fn(SerialStatus::Reconnecting);

        match open_serial_port(config) {
            Ok(new_port) => match new_port.try_clone() {
                Ok(mut new_reader) => {
                    alive.store(true, Ordering::SeqCst);
                    status_fn(SerialStatus::Connected);

                    read_loop(
                        config,
                        &mut new_reader,
                        ring_buffer,
                        alive,
                        closed,
                        output_fn,
                        status_fn,
                    );
                    return;
                }
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_serial_config tests ---------------------------------------

    fn make_config(port: &str) -> SerialConfig {
        SerialConfig {
            port: port.to_string(),
            ..SerialConfig::default()
        }
    }

    #[test]
    fn parse_defaults() {
        let cfg = make_config("/dev/ttyUSB0");
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.port, "/dev/ttyUSB0");
        assert_eq!(parsed.baud_rate, 115200);
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
        assert_eq!(parsed.parity, serialport::Parity::None);
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_data_bits_five() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 5,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Five);
    }

    #[test]
    fn parse_data_bits_six() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 6,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Six);
    }

    #[test]
    fn parse_data_bits_seven() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 7,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Seven);
    }

    #[test]
    fn parse_data_bits_eight() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 8,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
    }

    #[test]
    fn parse_data_bits_unknown_defaults_to_eight() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 99,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
    }

    #[test]
    fn parse_stop_bits_one() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 1,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
    }

    #[test]
    fn parse_stop_bits_two() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 2,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::Two);
    }

    #[test]
    fn parse_stop_bits_unknown_defaults_to_one() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 42,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
    }

    #[test]
    fn parse_parity_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::None);
    }

    #[test]
    fn parse_parity_odd() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "odd".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::Odd);
    }

    #[test]
    fn parse_parity_even() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "even".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::Even);
    }

    #[test]
    fn parse_parity_unknown_defaults_to_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "mark".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::None);
    }

    #[test]
    fn parse_flow_control_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_flow_control_hardware() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "hardware".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::Hardware);
    }

    #[test]
    fn parse_flow_control_software() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "software".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::Software);
    }

    #[test]
    fn parse_flow_control_unknown_defaults_to_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "xonxoff".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_empty_port_returns_error() {
        let cfg = SerialConfig::default(); // port is empty
        let result = parse_serial_config(&cfg);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, SessionError::InvalidConfig(_)),
            "expected InvalidConfig, got: {:?}",
            err
        );
    }

    #[test]
    fn parse_custom_baud_rate() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            baud_rate: 9600,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.baud_rate, 9600);
    }

    #[test]
    fn parse_full_custom_config() {
        let cfg = SerialConfig {
            port: "/dev/ttyS0".into(),
            baud_rate: 9600,
            data_bits: 7,
            stop_bits: 2,
            parity: "even".into(),
            flow_control: "hardware".into(),
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.port, "/dev/ttyS0");
        assert_eq!(parsed.baud_rate, 9600);
        assert_eq!(parsed.data_bits, serialport::DataBits::Seven);
        assert_eq!(parsed.stop_bits, serialport::StopBits::Two);
        assert_eq!(parsed.parity, serialport::Parity::Even);
        assert_eq!(parsed.flow_control, serialport::FlowControl::Hardware);
    }

    // --- list_serial_ports tests -----------------------------------------

    #[test]
    fn list_serial_ports_returns_vec() {
        // Hardware-dependent — just verify it returns without panicking.
        let ports = list_serial_ports();
        // ports may be empty on CI; that's fine.
        assert!(ports.len() < 10_000, "sanity check on port count");
    }

    // --- open_serial_port tests ------------------------------------------

    #[test]
    fn open_invalid_port_returns_spawn_failed() {
        let parsed = ParsedSerialConfig {
            port: "/dev/__nonexistent_serial_port__".into(),
            baud_rate: 115200,
            data_bits: serialport::DataBits::Eight,
            stop_bits: serialport::StopBits::One,
            parity: serialport::Parity::None,
            flow_control: serialport::FlowControl::None,
        };
        let result = open_serial_port(&parsed);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, SessionError::SpawnFailed(_)),
            "expected SpawnFailed, got: {:?}",
            err
        );
    }

    // --- SerialStatus tests ----------------------------------------------

    #[test]
    fn serial_status_equality() {
        assert_eq!(SerialStatus::Connected, SerialStatus::Connected);
        assert_eq!(SerialStatus::Disconnected, SerialStatus::Disconnected);
        assert_eq!(SerialStatus::Reconnecting, SerialStatus::Reconnecting);
        assert_eq!(
            SerialStatus::Error("oops".into()),
            SerialStatus::Error("oops".into())
        );
        assert_ne!(SerialStatus::Connected, SerialStatus::Disconnected);
        assert_ne!(
            SerialStatus::Error("a".into()),
            SerialStatus::Error("b".into())
        );
    }

    #[test]
    fn serial_status_clone() {
        let s = SerialStatus::Error("test".into());
        let cloned = s.clone();
        assert_eq!(s, cloned);
    }

    #[test]
    fn serial_status_debug() {
        let s = SerialStatus::Connected;
        let debug = format!("{:?}", s);
        assert!(debug.contains("Connected"));
    }
}
