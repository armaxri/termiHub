use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

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
#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellConfig {
    pub shell_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

/// Channel sender type for output data from backends.
pub type OutputSender = mpsc::UnboundedSender<Vec<u8>>;
/// Channel receiver type for output data from backends.
pub type OutputReceiver = mpsc::UnboundedReceiver<Vec<u8>>;
