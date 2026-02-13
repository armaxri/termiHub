use std::sync::mpsc;

use serde::{Deserialize, Serialize};

use crate::utils::expand::expand_env_placeholders;

/// Trait for all terminal backends (PTY, serial, SSH, telnet).
pub trait TerminalBackend: Send {
    /// Write user input to the terminal.
    fn write_input(&self, data: &[u8]) -> Result<(), crate::utils::errors::TerminalError>;

    /// Resize the terminal (no-op for serial/telnet).
    fn resize(&self, cols: u16, rows: u16) -> Result<(), crate::utils::errors::TerminalError>;

    /// Close the terminal session.
    fn close(&self) -> Result<(), crate::utils::errors::TerminalError>;

    /// Check if the terminal is still alive.
    fn is_alive(&self) -> bool;
}

/// A live terminal session with its backend and output channel.
pub struct TerminalSession {
    pub backend: Box<dyn TerminalBackend>,
    pub info: SessionInfo,
}

/// Information about an active session.
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub connection_type: String,
    pub alive: bool,
}

/// Output event emitted via Tauri events.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// Exit event emitted when a terminal process exits.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

/// Connection configuration matching the frontend TypeScript types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "config")]
pub enum ConnectionConfig {
    #[serde(rename = "local")]
    Local(LocalShellConfig),
    #[serde(rename = "ssh")]
    Ssh(SshConfig),
    #[serde(rename = "telnet")]
    Telnet(TelnetConfig),
    #[serde(rename = "serial")]
    Serial(SerialConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    pub shell_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    #[serde(default)]
    pub enable_x11_forwarding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

impl ConnectionConfig {
    /// Return a copy with all `${env:...}` placeholders expanded.
    pub fn expand(self) -> Self {
        match self {
            Self::Local(cfg) => Self::Local(cfg.expand()),
            Self::Ssh(cfg) => Self::Ssh(cfg.expand()),
            Self::Telnet(cfg) => Self::Telnet(cfg.expand()),
            Self::Serial(cfg) => Self::Serial(cfg.expand()),
        }
    }
}

impl LocalShellConfig {
    pub fn expand(mut self) -> Self {
        self.initial_command = self.initial_command.map(|s| expand_env_placeholders(&s));
        self
    }
}

impl SshConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self.username = expand_env_placeholders(&self.username);
        self.key_path = self.key_path.map(|s| expand_env_placeholders(&s));
        self.password = self.password.map(|s| expand_env_placeholders(&s));
        self
    }
}

impl TelnetConfig {
    pub fn expand(mut self) -> Self {
        self.host = expand_env_placeholders(&self.host);
        self
    }
}

impl SerialConfig {
    pub fn expand(mut self) -> Self {
        self.port = expand_env_placeholders(&self.port);
        self
    }
}

/// Channel sender type for output data from backends.
pub type OutputSender = mpsc::Sender<Vec<u8>>;
/// Channel receiver type for output data from backends (used in future phases).
#[allow(dead_code)]
pub type OutputReceiver = mpsc::Receiver<Vec<u8>>;
