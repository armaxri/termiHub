use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use tracing::info;

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::SerialSessionConfig;
use termihub_core::buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};
use termihub_core::session::serial::{
    open_serial_port, parse_serial_config, serial_reader_loop, SerialStatus,
};

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
    #[allow(dead_code)]
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
        let parsed = parse_serial_config(config)
            .map_err(|e| anyhow::anyhow!("Invalid serial config: {e}"))?;

        let port = open_serial_port(&parsed)
            .map_err(|e| anyhow::anyhow!("Failed to open serial port {}: {e}", config.port))?;

        let buffer = Arc::new(Mutex::new(RingBuffer::new(DEFAULT_BUFFER_CAPACITY)));
        let alive = Arc::new(AtomicBool::new(true));
        let closed = Arc::new(AtomicBool::new(false));
        let attached = Arc::new(AtomicBool::new(false));

        // Clone shared state for the reader thread closures
        let reader_buffer = buffer.clone();
        let reader_alive = alive.clone();
        let reader_closed = closed.clone();
        let reader_attached = attached.clone();
        let reader_notification_tx = notification_tx.clone();
        let reader_session_id = session_id.clone();
        let status_notification_tx = notification_tx.clone();
        let status_session_id = session_id.clone();

        std::thread::spawn(move || {
            let b64 = base64::engine::general_purpose::STANDARD;

            serial_reader_loop(
                &parsed,
                reader_buffer,
                reader_alive,
                reader_closed,
                move |data: &[u8]| {
                    // Only send notifications when attached
                    if reader_attached.load(Ordering::SeqCst) {
                        let encoded = b64.encode(data);
                        let notification = JsonRpcNotification::new(
                            "session.output",
                            serde_json::json!({
                                "session_id": reader_session_id,
                                "data": encoded,
                            }),
                        );
                        let _ = reader_notification_tx.send(notification);
                    }
                },
                move |status: SerialStatus| {
                    let message = match status {
                        SerialStatus::Connected => "Serial port reconnected".to_string(),
                        SerialStatus::Disconnected => "Serial port disconnected".to_string(),
                        SerialStatus::Reconnecting => return,
                        SerialStatus::Error(ref e) => format!("Serial port error: {e}"),
                    };
                    let notification = JsonRpcNotification::new(
                        "session.error",
                        serde_json::json!({
                            "session_id": status_session_id,
                            "message": message,
                        }),
                    );
                    let _ = status_notification_tx.send(notification);
                },
            );
        });

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
    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Whether a client is attached.
    #[allow(dead_code)]
    pub fn is_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst)
    }

    /// Close the serial port and stop the reader thread.
    pub fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        info!("Serial backend closing for session {}", self.session_id);
    }
}
