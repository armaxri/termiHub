//! Connection type abstraction and settings schema.
//!
//! This module defines the unified [`ConnectionType`] trait that all
//! connection backends (local shell, SSH, serial, telnet, Docker, WSL)
//! implement. It also provides the [`SettingsSchema`] types for dynamic
//! UI form generation and a [`ConnectionTypeRegistry`] for runtime
//! discovery of available connection types.
//!
//! # Architecture
//!
//! The core crate defines only the traits and data types. Concrete
//! connection type implementations live in the desktop (`src-tauri/`)
//! and agent (`agent/`) crates, which register their backends with a
//! [`ConnectionTypeRegistry`] at startup.

pub mod schema;
pub mod validation;

pub use schema::*;
pub use validation::{validate_settings, ValidationError};

use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use serde::{Deserialize, Serialize};

/// Async receiver for terminal output bytes from a connection.
///
/// Each call to [`ConnectionType::subscribe_output()`] creates a new
/// channel; the previous subscription is replaced.
pub type OutputReceiver = tokio::sync::mpsc::Receiver<Vec<u8>>;

/// Async sender for terminal output bytes (used by backend implementations).
pub type OutputSender = tokio::sync::mpsc::Sender<Vec<u8>>;

/// Capabilities declared by a connection type.
///
/// The UI uses these flags to show or hide optional features
/// (monitoring panels, file browser tabs, resize handles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Whether this connection supports system monitoring (CPU, memory, etc.).
    pub monitoring: bool,
    /// Whether this connection supports file browsing (SFTP, local fs, etc.).
    pub file_browser: bool,
    /// Whether terminal resize is supported (false for serial/telnet).
    pub resize: bool,
    /// Whether sessions of this type can persist across agent reconnections.
    pub persistent: bool,
}

/// Unified trait for all connection backends.
///
/// Each connection type (local shell, SSH, serial, telnet, Docker, WSL)
/// implements this trait. The desktop and agent crates provide concrete
/// implementations; the core crate defines only the interface.
///
/// # Lifecycle
///
/// 1. Create via [`ConnectionTypeRegistry::create()`]
/// 2. Read metadata: [`type_id()`](Self::type_id),
///    [`display_name()`](Self::display_name),
///    [`settings_schema()`](Self::settings_schema),
///    [`capabilities()`](Self::capabilities)
/// 3. Connect: [`connect()`](Self::connect) with a settings JSON value
/// 4. Terminal I/O: [`write()`](Self::write),
///    [`resize()`](Self::resize),
///    [`subscribe_output()`](Self::subscribe_output)
/// 5. Optional capabilities: [`monitoring()`](Self::monitoring),
///    [`file_browser()`](Self::file_browser)
/// 6. Disconnect: [`disconnect()`](Self::disconnect)
#[async_trait::async_trait]
pub trait ConnectionType: Send {
    // --- Static metadata ---

    /// Machine-readable identifier (e.g., `"ssh"`, `"serial"`, `"local"`).
    fn type_id(&self) -> &str;

    /// Human-readable display name (e.g., `"SSH"`, `"Serial Port"`).
    fn display_name(&self) -> &str;

    /// Settings schema for dynamic UI form generation.
    ///
    /// The frontend uses this to render a settings form without any
    /// knowledge of the connection type's internal configuration.
    fn settings_schema(&self) -> SettingsSchema;

    /// Capabilities of this connection type.
    fn capabilities(&self) -> Capabilities;

    // --- Lifecycle ---

    /// Connect using the provided settings JSON.
    ///
    /// The `settings` value should be validated against
    /// [`settings_schema()`](Self::settings_schema) before calling this
    /// method. Each backend internally deserializes the JSON to its own
    /// typed config struct.
    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError>;

    /// Disconnect and clean up resources.
    async fn disconnect(&mut self) -> Result<(), SessionError>;

    /// Check whether the connection is currently active.
    fn is_connected(&self) -> bool;

    // --- Terminal I/O ---

    /// Write input bytes to the terminal (user keystrokes, paste data).
    fn write(&self, data: &[u8]) -> Result<(), SessionError>;

    /// Resize the terminal to the given dimensions.
    ///
    /// No-op for connection types where [`Capabilities::resize`] is `false`.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError>;

    /// Subscribe to terminal output.
    ///
    /// Returns a receiver that yields output byte chunks as they arrive.
    /// Only one subscriber is active at a time; calling this again
    /// replaces the previous subscription.
    fn subscribe_output(&self) -> OutputReceiver;

    // --- Optional capabilities ---

    /// Access the monitoring provider, if this connection type supports it.
    ///
    /// Returns `None` when [`Capabilities::monitoring`] is `false`.
    fn monitoring(&self) -> Option<&dyn MonitoringProvider>;

    /// Access the file browser, if this connection type supports it.
    ///
    /// Returns `None` when [`Capabilities::file_browser`] is `false`.
    fn file_browser(&self) -> Option<&dyn FileBrowser>;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verify ConnectionType is object-safe and Send.
    fn _assert_object_safe(_: &dyn ConnectionType) {}
    fn _assert_send<T: Send>() {}

    #[test]
    fn connection_type_is_send() {
        _assert_send::<Box<dyn ConnectionType>>();
    }

    #[test]
    fn capabilities_serde_roundtrip() {
        let caps = Capabilities {
            monitoring: true,
            file_browser: true,
            resize: true,
            persistent: false,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["monitoring"], true);
        assert_eq!(json["fileBrowser"], true);
        assert_eq!(json["resize"], true);
        assert_eq!(json["persistent"], false);

        let deserialized: Capabilities = serde_json::from_value(json).unwrap();
        assert!(deserialized.monitoring);
        assert!(deserialized.file_browser);
        assert!(deserialized.resize);
        assert!(!deserialized.persistent);
    }

    #[test]
    fn capabilities_camel_case_keys() {
        let caps = Capabilities {
            monitoring: false,
            file_browser: false,
            resize: false,
            persistent: false,
        };
        let json = serde_json::to_value(&caps).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("monitoring"));
        assert!(obj.contains_key("fileBrowser"));
        assert!(obj.contains_key("resize"));
        assert!(obj.contains_key("persistent"));
        // Ensure snake_case keys are NOT present.
        assert!(!obj.contains_key("file_browser"));
    }
}
