use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{debug, info};

use crate::terminal::backend::{OutputSender, SerialConfig, TerminalBackend};
use crate::utils::errors::TerminalError;

/// Serial port connection backend.
pub struct SerialConnection {
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    alive: Arc<AtomicBool>,
}

impl SerialConnection {
    /// Open a serial port with the given configuration.
    pub fn new(config: &SerialConfig, output_tx: OutputSender) -> Result<Self, TerminalError> {
        info!(
            port = %config.port,
            baud_rate = config.baud_rate,
            "Opening serial port"
        );
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

        let port = serialport::new(&config.port, config.baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .flow_control(flow_control)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| TerminalError::SerialError(e.to_string()))?;

        let alive = Arc::new(AtomicBool::new(true));

        // Clone port for reading
        let mut reader = port
            .try_clone()
            .map_err(|e| TerminalError::SerialError(e.to_string()))?;

        let alive_clone = alive.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while alive_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        Ok(Self {
            port: Arc::new(Mutex::new(port)),
            alive,
        })
    }
}

impl TerminalBackend for SerialConnection {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut port = self
            .port
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock port: {}", e)))?;
        port.write_all(data)
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        port.flush()
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), TerminalError> {
        // Serial ports don't have a terminal size concept
        Ok(())
    }

    fn close(&self) -> Result<(), TerminalError> {
        debug!("Closing serial port");
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// List available serial ports on the system.
pub fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}
