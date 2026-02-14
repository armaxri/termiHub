use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use tracing::{debug, info, warn};

use crate::io::stdio::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::SerialSessionConfig;
use crate::serial::ring_buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};

/// Cached serial port configuration for reconnection.
#[derive(Clone)]
struct SerialPortSettings {
    port: String,
    baud_rate: u32,
    data_bits: serialport::DataBits,
    stop_bits: serialport::StopBits,
    parity: serialport::Parity,
    flow_control: serialport::FlowControl,
}

impl SerialPortSettings {
    fn from_config(config: &SerialSessionConfig) -> Self {
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

        Self {
            port: config.port.clone(),
            baud_rate: config.baud_rate,
            data_bits,
            stop_bits,
            parity,
            flow_control,
        }
    }

    fn open(&self) -> Result<Box<dyn serialport::SerialPort>, serialport::Error> {
        serialport::new(&self.port, self.baud_rate)
            .data_bits(self.data_bits)
            .stop_bits(self.stop_bits)
            .parity(self.parity)
            .flow_control(self.flow_control)
            .timeout(Duration::from_millis(100))
            .open()
    }
}

/// Handle to control a running serial backend.
///
/// The serial port reader runs in a dedicated OS thread (since the
/// `serialport` crate is blocking). Output is stored in a ring buffer
/// and, when attached, also sent as `session.output` notifications.
pub struct SerialBackend {
    /// Session ID for notification routing.
    session_id: String,
    /// Ring buffer for 24/7 data capture.
    buffer: Arc<Mutex<RingBuffer>>,
    /// Writer half of the serial port.
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    /// Whether a client is currently attached.
    attached: Arc<AtomicBool>,
    /// Whether the serial port is alive (connected).
    alive: Arc<AtomicBool>,
    /// Whether a close has been requested.
    closed: Arc<AtomicBool>,
    /// Channel to send notifications to the stdio loop.
    notification_tx: NotificationSender,
}

impl SerialBackend {
    /// Open a serial port and start the background reader thread.
    pub fn new(
        session_id: String,
        config: &SerialSessionConfig,
        notification_tx: NotificationSender,
    ) -> Result<Self, anyhow::Error> {
        let settings = SerialPortSettings::from_config(config);
        let port = settings
            .open()
            .map_err(|e| anyhow::anyhow!("Failed to open serial port {}: {}", config.port, e))?;

        let reader = port
            .try_clone()
            .map_err(|e| anyhow::anyhow!("Failed to clone serial port for reading: {}", e))?;

        let buffer = Arc::new(Mutex::new(RingBuffer::new(DEFAULT_BUFFER_CAPACITY)));
        let alive = Arc::new(AtomicBool::new(true));
        let closed = Arc::new(AtomicBool::new(false));
        let attached = Arc::new(AtomicBool::new(false));

        let reader_ctx = ReaderContext {
            reader,
            session_id: session_id.clone(),
            buffer: buffer.clone(),
            attached: attached.clone(),
            alive: alive.clone(),
            closed: closed.clone(),
            notification_tx: notification_tx.clone(),
            settings,
        };

        std::thread::spawn(move || reader_thread(reader_ctx));

        info!("Serial backend started for session {}", session_id);

        Ok(Self {
            session_id,
            buffer,
            writer: Arc::new(Mutex::new(port)),
            attached,
            alive,
            closed,
            notification_tx,
        })
    }

    /// Write data to the serial port.
    pub fn write_input(&self, data: &[u8]) -> Result<(), anyhow::Error> {
        let mut port = self.writer.lock().unwrap();
        port.write_all(data)
            .map_err(|e| anyhow::anyhow!("Serial write failed: {}", e))?;
        port.flush()
            .map_err(|e| anyhow::anyhow!("Serial flush failed: {}", e))?;
        Ok(())
    }

    /// Mark this session as attached and replay the buffer.
    ///
    /// Sends `session.output` notifications containing all buffered data,
    /// then starts forwarding live output as additional notifications.
    pub fn attach(&self) -> Result<(), anyhow::Error> {
        let buffered_data = {
            let rb = self.buffer.lock().unwrap();
            rb.read_all()
        };

        if !buffered_data.is_empty() {
            let b64 = base64::engine::general_purpose::STANDARD;
            // Send in chunks to stay under the 1 MiB NDJSON line limit
            for chunk in buffered_data.chunks(65536) {
                let encoded = b64.encode(chunk);
                let notification = JsonRpcNotification::new(
                    "session.output",
                    serde_json::json!({
                        "session_id": self.session_id,
                        "data": encoded,
                    }),
                );
                let _ = self.notification_tx.send(notification);
            }
        }

        // Mark as attached so the reader thread starts sending live output
        self.attached.store(true, Ordering::SeqCst);
        info!("Client attached to session {}", self.session_id);
        Ok(())
    }

    /// Mark this session as detached. Output continues to be buffered
    /// but no more notifications are sent.
    pub fn detach(&self) {
        self.attached.store(false, Ordering::SeqCst);
        info!("Client detached from session {}", self.session_id);
    }

    /// Whether the serial port is alive (connected).
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Whether a client is attached.
    pub fn is_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst)
    }

    /// Close the serial port and stop the reader thread.
    pub fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        info!("Serial backend closing for session {}", self.session_id);
    }
}

/// Context passed to the reader thread.
struct ReaderContext {
    reader: Box<dyn serialport::SerialPort>,
    session_id: String,
    buffer: Arc<Mutex<RingBuffer>>,
    attached: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    notification_tx: NotificationSender,
    settings: SerialPortSettings,
}

/// Background reader thread — reads from the serial port and buffers output.
fn reader_thread(mut ctx: ReaderContext) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut buf = [0u8; 1024];

    loop {
        if ctx.closed.load(Ordering::SeqCst) {
            break;
        }

        match ctx.reader.read(&mut buf) {
            Ok(0) => {
                // Port closed (EOF)
                info!("Serial port {} closed (EOF)", ctx.settings.port);
                break;
            }
            Ok(n) => {
                let data = &buf[..n];

                // Always store in ring buffer
                {
                    let mut rb = ctx.buffer.lock().unwrap();
                    rb.write(data);
                }

                // If attached, send notification
                if ctx.attached.load(Ordering::SeqCst) {
                    let encoded = b64.encode(data);
                    let notification = JsonRpcNotification::new(
                        "session.output",
                        serde_json::json!({
                            "session_id": ctx.session_id,
                            "data": encoded,
                        }),
                    );
                    let _ = ctx.notification_tx.send(notification);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) => {
                warn!(
                    "Serial port {} read error: {}",
                    ctx.settings.port, e
                );
                ctx.alive.store(false, Ordering::SeqCst);

                // Notify attached client
                if ctx.attached.load(Ordering::SeqCst) {
                    let notification = JsonRpcNotification::new(
                        "session.error",
                        serde_json::json!({
                            "session_id": ctx.session_id,
                            "message": format!("Serial port disconnected: {}", e),
                        }),
                    );
                    let _ = ctx.notification_tx.send(notification);
                }

                // Attempt to reconnect
                reconnect_loop(&mut ctx);

                if ctx.closed.load(Ordering::SeqCst) || !ctx.alive.load(Ordering::SeqCst) {
                    break;
                }

                // Reconnected — notify client if attached
                if ctx.attached.load(Ordering::SeqCst) {
                    let notification = JsonRpcNotification::new(
                        "session.error",
                        serde_json::json!({
                            "session_id": ctx.session_id,
                            "message": format!("Serial port {} reconnected", ctx.settings.port),
                        }),
                    );
                    let _ = ctx.notification_tx.send(notification);
                }

                continue;
            }
        }
    }

    ctx.alive.store(false, Ordering::SeqCst);
    debug!(
        "Serial reader thread exiting for session {}",
        ctx.session_id
    );
}

/// Attempt to reopen the serial port periodically.
///
/// Retries every 3 seconds until the port reappears or `closed` is set.
fn reconnect_loop(ctx: &mut ReaderContext) {
    const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

    loop {
        if ctx.closed.load(Ordering::SeqCst) {
            return;
        }

        std::thread::sleep(RECONNECT_INTERVAL);

        if ctx.closed.load(Ordering::SeqCst) {
            return;
        }

        debug!("Attempting to reconnect serial port {}", ctx.settings.port);

        match ctx.settings.open() {
            Ok(new_port) => match new_port.try_clone() {
                Ok(new_reader) => {
                    ctx.reader = new_reader;
                    ctx.alive.store(true, Ordering::SeqCst);
                    info!("Serial port {} reconnected", ctx.settings.port);
                    return;
                }
                Err(e) => {
                    warn!("Reconnect clone failed: {}", e);
                }
            },
            Err(e) => {
                debug!("Reconnect attempt failed for {}: {}", ctx.settings.port, e);
            }
        }
    }
}
