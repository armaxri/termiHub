//! Remote backend for connecting to a termihub-agent over SSH.
//!
//! Implements the `TerminalBackend` trait by exchanging JSON-RPC 2.0
//! messages over an SSH exec channel running `termihub-agent --stdio`.
//!
//! ## Architecture
//!
//! A single I/O thread owns the SSH `Session` + `Channel` exclusively.
//! `write_input()` and `resize()` send commands through an `mpsc` channel
//! to avoid blocking-mode toggling and `!Send`/`!Sync` issues with ssh2.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use base64::Engine;
use serde_json::Value;
use ssh2::Session;
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use crate::terminal::backend::{
    OutputSender, RemoteConfig, RemoteStateChangeEvent, TerminalBackend,
};
use crate::terminal::jsonrpc;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// Commands sent from TerminalBackend methods to the I/O thread.
enum WriteCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// Remote backend that communicates with a termihub-agent over SSH.
pub struct RemoteBackend {
    write_tx: Mutex<mpsc::Sender<WriteCommand>>,
    alive: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    #[allow(dead_code)]
    remote_session_id: String,
}

impl RemoteBackend {
    /// Connect to a remote agent, perform the handshake, and spawn the I/O thread.
    ///
    /// The constructor blocks to perform the SSH connect + agent handshake
    /// (`initialize` → `session.create` → `session.attach`) so that errors
    /// are reported immediately to `TerminalManager::create_session()`.
    pub fn new(
        config: &RemoteConfig,
        output_tx: OutputSender,
        app_handle: AppHandle,
        local_session_id: String,
    ) -> Result<Self, TerminalError> {
        let ssh_config = config.to_ssh_config();

        // 1. Connect and authenticate via SSH
        let session = connect_and_authenticate(&ssh_config)?;

        // 2. Open exec channel and launch agent
        let mut channel = session
            .channel_session()
            .map_err(|e| TerminalError::RemoteError(format!("Channel open failed: {}", e)))?;
        channel
            .exec("termihub-agent --stdio")
            .map_err(|e| TerminalError::RemoteError(format!("Exec failed: {}", e)))?;

        // 3. Blocking handshake: initialize → session.create → session.attach
        let mut request_id: u64 = 0;

        // initialize
        request_id += 1;
        jsonrpc::write_request(
            &mut channel,
            request_id,
            "initialize",
            serde_json::json!({
                "protocol_version": "0.1.0",
                "client": "termihub-desktop",
                "client_version": "0.1.0"
            }),
        )
        .map_err(|e| TerminalError::RemoteError(format!("Write initialize failed: {}", e)))?;

        let resp_line = jsonrpc::read_line_blocking(&mut channel)
            .map_err(|e| TerminalError::RemoteError(format!("Read initialize response: {}", e)))?;
        let msg = jsonrpc::parse_message(&resp_line)
            .map_err(|e| TerminalError::RemoteError(format!("Parse initialize response: {}", e)))?;
        match msg {
            jsonrpc::JsonRpcMessage::Response { .. } => {}
            jsonrpc::JsonRpcMessage::Error { message, .. } => {
                return Err(TerminalError::RemoteError(format!(
                    "Initialize rejected: {}",
                    message
                )));
            }
            _ => {
                return Err(TerminalError::RemoteError(
                    "Unexpected response to initialize".to_string(),
                ));
            }
        }

        // session.create
        request_id += 1;
        let create_params = build_create_params(config);
        jsonrpc::write_request(&mut channel, request_id, "session.create", create_params)
            .map_err(|e| TerminalError::RemoteError(format!("Write session.create: {}", e)))?;

        let resp_line = jsonrpc::read_line_blocking(&mut channel).map_err(|e| {
            TerminalError::RemoteError(format!("Read session.create response: {}", e))
        })?;
        let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
            TerminalError::RemoteError(format!("Parse session.create response: {}", e))
        })?;
        let remote_session_id = match msg {
            jsonrpc::JsonRpcMessage::Response { result, .. } => result["session_id"]
                .as_str()
                .ok_or_else(|| {
                    TerminalError::RemoteError("session.create: missing session_id".to_string())
                })?
                .to_string(),
            jsonrpc::JsonRpcMessage::Error { message, .. } => {
                return Err(TerminalError::RemoteError(format!(
                    "session.create failed: {}",
                    message
                )));
            }
            _ => {
                return Err(TerminalError::RemoteError(
                    "Unexpected response to session.create".to_string(),
                ));
            }
        };

        // session.attach
        request_id += 1;
        jsonrpc::write_request(
            &mut channel,
            request_id,
            "session.attach",
            serde_json::json!({ "session_id": remote_session_id }),
        )
        .map_err(|e| TerminalError::RemoteError(format!("Write session.attach: {}", e)))?;

        let resp_line = jsonrpc::read_line_blocking(&mut channel).map_err(|e| {
            TerminalError::RemoteError(format!("Read session.attach response: {}", e))
        })?;
        let msg = jsonrpc::parse_message(&resp_line).map_err(|e| {
            TerminalError::RemoteError(format!("Parse session.attach response: {}", e))
        })?;
        match msg {
            jsonrpc::JsonRpcMessage::Response { .. } => {}
            jsonrpc::JsonRpcMessage::Error { message, .. } => {
                return Err(TerminalError::RemoteError(format!(
                    "session.attach failed: {}",
                    message
                )));
            }
            _ => {
                return Err(TerminalError::RemoteError(
                    "Unexpected response to session.attach".to_string(),
                ));
            }
        }

        // 4. Switch to non-blocking and spawn I/O thread
        session.set_blocking(false);

        let alive = Arc::new(AtomicBool::new(true));
        let closed = Arc::new(AtomicBool::new(false));
        let (write_tx, write_rx) = mpsc::channel();

        // Emit initial connected state
        let _ = app_handle.emit(
            "remote-state-change",
            RemoteStateChangeEvent {
                session_id: local_session_id.clone(),
                state: "connected".to_string(),
            },
        );

        let alive_clone = alive.clone();
        let closed_clone = closed.clone();
        let remote_sid = remote_session_id.clone();
        let config_clone = config.clone();

        std::thread::spawn(move || {
            io_thread(
                session,
                channel,
                write_rx,
                output_tx,
                alive_clone,
                closed_clone,
                app_handle,
                local_session_id,
                remote_sid,
                config_clone,
                request_id,
            );
        });

        info!("RemoteBackend connected, session: {}", remote_session_id);

        Ok(Self {
            write_tx: Mutex::new(write_tx),
            alive,
            closed,
            remote_session_id,
        })
    }
}

impl TerminalBackend for RemoteBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        let tx = self.write_tx.lock().unwrap();
        tx.send(WriteCommand::Input(data.to_vec()))
            .map_err(|_| TerminalError::WriteFailed("Remote I/O thread gone".to_string()))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let tx = self.write_tx.lock().unwrap();
        tx.send(WriteCommand::Resize { cols, rows })
            .map_err(|_| TerminalError::ResizeFailed("Remote I/O thread gone".to_string()))
    }

    fn close(&self) -> Result<(), TerminalError> {
        self.closed.store(true, Ordering::SeqCst);
        let tx = self.write_tx.lock().unwrap();
        let _ = tx.send(WriteCommand::Close);
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Build the `session.create` params from a `RemoteConfig`.
fn build_create_params(config: &RemoteConfig) -> Value {
    match config.session_type.as_str() {
        "serial" => {
            let mut serial_config = serde_json::json!({
                "port": config.serial_port.as_deref().unwrap_or("/dev/ttyUSB0"),
                "baud_rate": config.baud_rate.unwrap_or(115200),
                "data_bits": config.data_bits.unwrap_or(8),
                "stop_bits": config.stop_bits.unwrap_or(1),
                "parity": config.parity.as_deref().unwrap_or("none"),
                "flow_control": config.flow_control.as_deref().unwrap_or("none"),
            });
            let mut params = serde_json::json!({
                "type": "serial",
                "config": serial_config,
            });
            if let Some(ref title) = config.title {
                params["title"] = Value::String(title.clone());
            }
            // Merge serial_config into params.config
            if let Some(obj) = serial_config.as_object_mut() {
                params["config"] = Value::Object(obj.clone());
            }
            params
        }
        _ => {
            // Default to shell
            let mut params = serde_json::json!({
                "type": "shell",
                "config": {
                    "shell": config.shell.as_deref().unwrap_or("/bin/bash"),
                    "cols": 80,
                    "rows": 24,
                    "env": { "TERM": "xterm-256color" }
                }
            });
            if let Some(ref title) = config.title {
                params["title"] = Value::String(title.clone());
            }
            params
        }
    }
}

/// Main I/O thread loop — owns the SSH Session + Channel.
#[allow(clippy::too_many_arguments)]
fn io_thread(
    _session: Session,
    mut channel: ssh2::Channel,
    write_rx: mpsc::Receiver<WriteCommand>,
    output_tx: OutputSender,
    alive: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    _app_handle: AppHandle,
    _local_session_id: String,
    remote_session_id: String,
    _config: RemoteConfig,
    mut request_id: u64,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut line_buf = String::new();
    let mut read_buf = [0u8; 4096];

    loop {
        // Check if we've been asked to close
        if closed.load(Ordering::SeqCst) {
            break;
        }

        // 1. Process all pending write commands (non-blocking)
        while let Ok(cmd) = write_rx.try_recv() {
            match cmd {
                WriteCommand::Input(data) => {
                    request_id += 1;
                    let encoded = b64.encode(&data);
                    let _ = jsonrpc::write_request(
                        &mut channel,
                        request_id,
                        "session.input",
                        serde_json::json!({
                            "session_id": remote_session_id,
                            "data": encoded,
                        }),
                    );
                }
                WriteCommand::Resize { cols, rows } => {
                    request_id += 1;
                    let _ = jsonrpc::write_request(
                        &mut channel,
                        request_id,
                        "session.resize",
                        serde_json::json!({
                            "session_id": remote_session_id,
                            "cols": cols,
                            "rows": rows,
                        }),
                    );
                }
                WriteCommand::Close => {
                    request_id += 1;
                    let _ = jsonrpc::write_request(
                        &mut channel,
                        request_id,
                        "session.close",
                        serde_json::json!({ "session_id": remote_session_id }),
                    );
                    alive.store(false, Ordering::SeqCst);
                    return;
                }
            }
        }

        // 2. Non-blocking read from SSH channel
        match channel.read(&mut read_buf) {
            Ok(0) => {
                // EOF — channel closed
                break;
            }
            Ok(n) => {
                let chunk =
                    String::from_utf8_lossy(&read_buf[..n]).to_string();
                line_buf.push_str(&chunk);

                // Extract complete NDJSON lines
                while let Some(newline_pos) = line_buf.find('\n') {
                    let line: String = line_buf.drain(..=newline_pos).collect();
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }

                    match jsonrpc::parse_message(line) {
                        Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) => {
                            handle_notification(
                                &method,
                                &params,
                                &remote_session_id,
                                &output_tx,
                                &alive,
                                &b64,
                            );
                        }
                        Ok(jsonrpc::JsonRpcMessage::Response { .. }) => {
                            // Responses to fire-and-forget requests — ignore
                        }
                        Ok(jsonrpc::JsonRpcMessage::Error {
                            message, ..
                        }) => {
                            warn!("Remote agent error response: {}", message);
                        }
                        Err(e) => {
                            warn!("Failed to parse agent message: {}", e);
                        }
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No data available — sleep briefly to avoid busy-waiting
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => {
                error!("SSH channel read error: {}", e);
                break;
            }
        }
    }

    // Connection lost or EOF
    alive.store(false, Ordering::SeqCst);
    info!("Remote I/O thread exiting for session {}", remote_session_id);
}

/// Handle an incoming JSON-RPC notification from the agent.
fn handle_notification(
    method: &str,
    params: &Value,
    remote_session_id: &str,
    output_tx: &OutputSender,
    alive: &Arc<AtomicBool>,
    b64: &base64::engine::GeneralPurpose,
) {
    // Only process notifications for our session
    let notif_sid = params["session_id"].as_str().unwrap_or("");
    if notif_sid != remote_session_id {
        return;
    }

    match method {
        "session.output" => {
            if let Some(data_str) = params["data"].as_str() {
                match b64.decode(data_str) {
                    Ok(bytes) => {
                        let _ = output_tx.send(bytes);
                    }
                    Err(e) => {
                        warn!("Failed to decode session.output data: {}", e);
                    }
                }
            }
        }
        "session.exit" => {
            let exit_code = params.get("exit_code").cloned().unwrap_or(Value::Null);
            info!(
                "Remote session {} exited (code: {})",
                remote_session_id, exit_code
            );
            alive.store(false, Ordering::SeqCst);
        }
        "session.error" => {
            let msg = params["message"].as_str().unwrap_or("unknown error");
            warn!("Remote session error: {}", msg);
        }
        _ => {
            warn!("Unknown notification method: {}", method);
        }
    }
}
