use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use termihub_core::output::coalescer::OutputCoalescer;
use termihub_core::output::screen_clear::contains_screen_clear;
use tracing::{error, info};

use crate::terminal::agent_manager::AgentConnectionManager;
use crate::terminal::backend::{
    ConnectionConfig, SessionInfo, TerminalExitEvent, TerminalOutputEvent, TerminalSession,
    OUTPUT_CHANNEL_CAPACITY,
};
use crate::terminal::docker_shell::DockerShell;
use crate::terminal::local_shell::LocalShell;
use crate::terminal::remote_session::RemoteSessionBackend;
use crate::terminal::serial::SerialConnection;
use crate::terminal::ssh::SshConnection;
use crate::terminal::telnet::TelnetConnection;
use crate::utils::errors::TerminalError;
use crate::utils::shell_detect::ssh_osc7_setup;
#[cfg(windows)]
use crate::utils::shell_detect::wsl_osc7_setup;

/// Maximum number of concurrent terminal sessions.
const MAX_SESSIONS: usize = 50;

/// Maximum coalesced output size per emit (32 KB).
const MAX_COALESCE_BYTES: usize = 32 * 1024;

/// Maximum time to wait for the screen-clear sequence before flushing
/// buffered output anyway.
const CLEAR_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Manages all active terminal sessions.
#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create a new terminal session and start streaming output.
    pub fn create_session(
        &self,
        config: ConnectionConfig,
        app_handle: AppHandle,
        agent_manager: Option<Arc<AgentConnectionManager>>,
    ) -> Result<String, TerminalError> {
        // Enforce session limit
        {
            let sessions = self.sessions.lock().map_err(|e| {
                TerminalError::SpawnFailed(format!("Failed to lock sessions: {}", e))
            })?;
            if sessions.len() >= MAX_SESSIONS {
                return Err(TerminalError::SpawnFailed(format!(
                    "Maximum number of sessions ({}) reached",
                    MAX_SESSIONS
                )));
            }
        }

        let config = config.expand();
        let session_id = uuid::Uuid::new_v4().to_string();
        let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHANNEL_CAPACITY);

        let initial_command = match &config {
            ConnectionConfig::Local(cfg) => {
                #[cfg(windows)]
                if cfg.shell_type.starts_with("wsl:") {
                    let osc7 = wsl_osc7_setup().to_string();
                    Some(match &cfg.initial_command {
                        Some(cmd) => format!("{}\n{}", osc7, cmd),
                        None => osc7,
                    })
                } else {
                    cfg.initial_command.clone()
                }
                #[cfg(not(windows))]
                cfg.initial_command.clone()
            }
            ConnectionConfig::Ssh(_) => Some(ssh_osc7_setup().to_string()),
            _ => None,
        };

        let (backend, title) = match &config {
            ConnectionConfig::Local(cfg) => {
                let shell = LocalShell::new(
                    &cfg.shell_type,
                    cfg.starting_directory.as_deref(),
                    output_tx,
                )?;
                let title = cfg.shell_type.clone();
                (
                    Box::new(shell) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
            ConnectionConfig::Serial(cfg) => {
                let conn = SerialConnection::new(cfg, output_tx)?;
                let title = format!("Serial: {}", cfg.port);
                (
                    Box::new(conn) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
            ConnectionConfig::Ssh(cfg) => {
                let conn = SshConnection::new(cfg, output_tx)?;
                let title = format!("SSH: {}@{}", cfg.username, cfg.host);
                (
                    Box::new(conn) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
            ConnectionConfig::Telnet(cfg) => {
                let conn = TelnetConnection::new(cfg, output_tx)?;
                let title = format!("Telnet: {}:{}", cfg.host, cfg.port);
                (
                    Box::new(conn) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
            ConnectionConfig::RemoteSession(cfg) => {
                let agent_mgr = agent_manager.ok_or_else(|| {
                    TerminalError::SpawnFailed("AgentConnectionManager not available".to_string())
                })?;
                let conn = RemoteSessionBackend::new(cfg, output_tx, agent_mgr)?;
                let title = cfg
                    .title
                    .clone()
                    .unwrap_or_else(|| format!("Remote: {}", cfg.agent_id));
                (
                    Box::new(conn) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
            ConnectionConfig::Docker(cfg) => {
                let shell = DockerShell::new(cfg, output_tx)?;
                let title = format!("Docker: {}", cfg.image);
                (
                    Box::new(shell) as Box<dyn crate::terminal::backend::TerminalBackend>,
                    title,
                )
            }
        };

        let connection_type = match &config {
            ConnectionConfig::Local(_) => "local",
            ConnectionConfig::Serial(_) => "serial",
            ConnectionConfig::Ssh(_) => "ssh",
            ConnectionConfig::Telnet(_) => "telnet",
            ConnectionConfig::RemoteSession(_) => "remote-session",
            ConnectionConfig::Docker(_) => "docker",
        };

        let info = SessionInfo {
            id: session_id.clone(),
            title,
            connection_type: connection_type.to_string(),
            alive: true,
        };

        let session = TerminalSession { backend, info };

        self.sessions
            .lock()
            .map_err(|e| TerminalError::SpawnFailed(format!("Failed to lock sessions: {}", e)))?
            .insert(session_id.clone(), session);

        // Spawn output streaming task. When there is an initial command
        // with a screen clear, the reader buffers output until the clear
        // sequence appears so xterm processes everything atomically.
        let wait_for_clear = initial_command.is_some();
        self.spawn_output_reader(session_id.clone(), output_rx, app_handle, wait_for_clear);

        // Send initial command after a short delay to let the shell initialize.
        if let Some(cmd) = initial_command {
            let sessions = self.sessions.clone();
            let sid = session_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                if let Ok(sessions) = sessions.lock() {
                    if let Some(session) = sessions.get(&sid) {
                        let input = format!("{}\n", cmd);
                        let _ = session.backend.write_input(input.as_bytes());
                    }
                }
            });
        }

        info!("Created terminal session: {}", session_id);
        Ok(session_id)
    }

    /// Get a clone of the sessions Arc for use by agent setup.
    pub fn sessions_arc(&self) -> Arc<Mutex<HashMap<String, TerminalSession>>> {
        self.sessions.clone()
    }

    /// Send input data to a terminal session.
    pub fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock sessions: {}", e)))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        session.backend.write_input(data)
    }

    /// Resize a terminal session.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::ResizeFailed(format!("Failed to lock sessions: {}", e)))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        session.backend.resize(cols, rows)
    }

    /// Close a terminal session.
    pub fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock sessions: {}", e)))?;
        if let Some(session) = sessions.remove(session_id) {
            let _ = session.backend.close();
            info!("Closed terminal session: {}", session_id);
        }
        Ok(())
    }

    /// List all active sessions (used in future phases).
    #[allow(dead_code)]
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        sessions
            .values()
            .map(|s| {
                let mut info = s.info.clone();
                info.alive = s.backend.is_alive();
                info
            })
            .collect()
    }

    /// Spawn a thread that reads output from a backend and emits Tauri events.
    ///
    /// When `wait_for_clear` is true the reader buffers all output until the
    /// ANSI screen-clear sequence appears (or a timeout expires), then emits
    /// the entire buffer as a single event so xterm processes the clear
    /// atomically — no visible flash of startup output.
    fn spawn_output_reader(
        &self,
        session_id: String,
        output_rx: mpsc::Receiver<Vec<u8>>,
        app_handle: AppHandle,
        wait_for_clear: bool,
    ) {
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            Self::run_output_reader(session_id, output_rx, app_handle, sessions, wait_for_clear);
        });
    }

    /// Read output from a backend channel and emit Tauri events.
    /// Coalesces pending output chunks into a single event (up to MAX_COALESCE_BYTES)
    /// to reduce IPC overhead.
    fn run_output_reader(
        session_id: String,
        output_rx: mpsc::Receiver<Vec<u8>>,
        app_handle: AppHandle,
        sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
        wait_for_clear: bool,
    ) {
        // Phase 1: optionally buffer until the screen-clear sequence appears.
        if wait_for_clear {
            let deadline = Instant::now() + CLEAR_WAIT_TIMEOUT;
            let mut buffer = Vec::new();

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match output_rx.recv_timeout(remaining) {
                    Ok(chunk) => {
                        buffer.extend_from_slice(&chunk);
                        if contains_screen_clear(&buffer) {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        // Terminal died during startup — flush whatever we have.
                        Self::emit_and_cleanup(&session_id, buffer, &app_handle, &sessions);
                        return;
                    }
                }
            }

            // Flush the buffered output as a single event.
            if !buffer.is_empty() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data: buffer,
                };
                if app_handle.emit("terminal-output", &event).is_err() {
                    return;
                }
            }
        }

        // Phase 2: normal streaming with coalescing.
        let mut coalescer = OutputCoalescer::new(MAX_COALESCE_BYTES);
        while let Ok(first_chunk) = output_rx.recv() {
            coalescer.push(&first_chunk);
            while coalescer.pending_len() < MAX_COALESCE_BYTES {
                match output_rx.try_recv() {
                    Ok(chunk) => coalescer.push(&chunk),
                    Err(_) => break,
                }
            }

            if let Some(data) = coalescer.flush() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data,
                };
                if let Err(e) = app_handle.emit("terminal-output", &event) {
                    error!("Failed to emit terminal-output event: {}", e);
                    break;
                }
            }
        }

        Self::emit_and_cleanup(&session_id, Vec::new(), &app_handle, &sessions);
    }

    /// Emit remaining data (if any), send the exit event, and remove the session.
    fn emit_and_cleanup(
        session_id: &str,
        data: Vec<u8>,
        app_handle: &AppHandle,
        sessions: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    ) {
        if !data.is_empty() {
            let event = TerminalOutputEvent {
                session_id: session_id.to_string(),
                data,
            };
            let _ = app_handle.emit("terminal-output", &event);
        }

        let exit_event = TerminalExitEvent {
            session_id: session_id.to_string(),
            exit_code: None,
        };
        let _ = app_handle.emit("terminal-exit", &exit_event);

        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(session_id);
        }

        info!("Terminal session ended: {}", session_id);
    }
}
