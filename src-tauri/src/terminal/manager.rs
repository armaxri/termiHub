use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tracing::{error, info};

use crate::terminal::backend::{
    ConnectionConfig, SessionInfo, TerminalExitEvent, TerminalOutputEvent, TerminalSession,
};
use crate::terminal::local_shell::LocalShell;
use crate::terminal::serial::SerialConnection;
use crate::terminal::ssh::SshConnection;
use crate::terminal::telnet::TelnetConnection;
use crate::utils::errors::TerminalError;

/// Manages all active terminal sessions.
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
    ) -> Result<String, TerminalError> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>();

        let initial_command = match &config {
            ConnectionConfig::Local(cfg) => cfg.initial_command.clone(),
            _ => None,
        };

        let (backend, title) = match &config {
            ConnectionConfig::Local(cfg) => {
                let shell = LocalShell::new(&cfg.shell_type, output_tx)?;
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
        };

        let connection_type = match &config {
            ConnectionConfig::Local(_) => "local",
            ConnectionConfig::Serial(_) => "serial",
            ConnectionConfig::Ssh(_) => "ssh",
            ConnectionConfig::Telnet(_) => "telnet",
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
            .unwrap()
            .insert(session_id.clone(), session);

        // Spawn output streaming task
        self.spawn_output_reader(session_id.clone(), output_rx, app_handle);

        // Send initial command after a short delay to let the shell initialize
        if let Some(cmd) = initial_command {
            let sessions = self.sessions.clone();
            let sid = session_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
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

    /// Send input data to a terminal session.
    pub fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        session.backend.write_input(data)
    }

    /// Resize a terminal session.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        session.backend.resize(cols, rows)
    }

    /// Close a terminal session.
    pub fn close_session(&self, session_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            let _ = session.backend.close();
            info!("Closed terminal session: {}", session_id);
        }
        Ok(())
    }

    /// List all active sessions (used in future phases).
    #[allow(dead_code)]
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().unwrap();
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
    fn spawn_output_reader(
        &self,
        session_id: String,
        output_rx: mpsc::Receiver<Vec<u8>>,
        app_handle: AppHandle,
    ) {
        let sessions = self.sessions.clone();

        std::thread::spawn(move || {
            while let Ok(data) = output_rx.recv() {
                let event = TerminalOutputEvent {
                    session_id: session_id.clone(),
                    data,
                };
                if let Err(e) = app_handle.emit("terminal-output", &event) {
                    error!("Failed to emit terminal-output event: {}", e);
                    break;
                }
            }

            // Channel closed — terminal exited
            let exit_event = TerminalExitEvent {
                session_id: session_id.clone(),
                exit_code: None,
            };
            let _ = app_handle.emit("terminal-exit", &exit_event);

            // Clean up session
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&session_id);
            }

            info!("Terminal session ended: {}", session_id);
        });
    }
}
