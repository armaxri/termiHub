use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::terminal::backend::{OutputSender, TelnetConfig, TerminalBackend};
use crate::utils::errors::TerminalError;

// Telnet protocol constants
const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;

/// Telnet connection backend.
pub struct TelnetConnection {
    stream: Arc<Mutex<TcpStream>>,
    alive: Arc<AtomicBool>,
}

impl TelnetConnection {
    /// Connect to a telnet server.
    pub fn new(config: &TelnetConfig, output_tx: OutputSender) -> Result<Self, TerminalError> {
        let addr = format!("{}:{}", config.host, config.port);
        let stream = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e: std::net::AddrParseError| TerminalError::TelnetError(e.to_string()))?,
            Duration::from_secs(10),
        )
        .map_err(|e| TerminalError::TelnetError(e.to_string()))?;

        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|e| TerminalError::TelnetError(e.to_string()))?;

        let alive = Arc::new(AtomicBool::new(true));

        let mut reader = stream
            .try_clone()
            .map_err(|e| TerminalError::TelnetError(e.to_string()))?;

        let alive_clone = alive.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while alive_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Basic telnet IAC filtering
                        let filtered = filter_telnet_commands(&buf[..n], &mut reader);
                        if !filtered.is_empty() && output_tx.send(filtered).is_err() {
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

        Ok(Self {
            stream: Arc::new(Mutex::new(stream)),
            alive,
        })
    }
}

/// Filter telnet IAC commands, responding with WONT/DONT to negotiations.
fn filter_telnet_commands(data: &[u8], stream: &mut TcpStream) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if data[i] == IAC && i + 1 < data.len() {
            match data[i + 1] {
                DO if i + 2 < data.len() => {
                    // Refuse all DO requests
                    let _ = stream.write_all(&[IAC, WONT, data[i + 2]]);
                    i += 3;
                }
                WILL if i + 2 < data.len() => {
                    // Refuse all WILL offers
                    let _ = stream.write_all(&[IAC, DONT, data[i + 2]]);
                    i += 3;
                }
                DONT | WONT if i + 2 < data.len() => {
                    // Acknowledge
                    i += 3;
                }
                IAC => {
                    // Escaped 0xFF
                    output.push(IAC);
                    i += 2;
                }
                _ => {
                    // Skip unknown IAC sequences
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

impl TerminalBackend for TelnetConnection {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut stream = self.stream.lock().unwrap();
        stream
            .write_all(data)
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        stream
            .flush()
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), TerminalError> {
        // Basic telnet doesn't support resize
        Ok(())
    }

    fn close(&self) -> Result<(), TerminalError> {
        self.alive.store(false, Ordering::SeqCst);
        let stream = self.stream.lock().unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Both);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}
