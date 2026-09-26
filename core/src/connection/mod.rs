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

pub mod auto_reconnect;
pub mod clipboard_image;
pub mod graphical;
pub mod graphical_resolution;
pub mod lifecycle;
pub mod plugin_type_id;
pub mod registry;
pub mod schema;
pub mod schema_defaults;
pub mod validation;

pub use auto_reconnect::{
    auto_reconnect_enabled, normalize_auto_reconnect, AUTO_RECONNECT_DEFAULT, AUTO_RECONNECT_KEY,
    LEGACY_RESILIENT_RECONNECT_KEY,
};
pub use clipboard_image::{
    check_clipboard_image_size, ClipboardImage, ClipboardImageInfo, ClipboardImageViolation,
    MAX_CLIPBOARD_IMAGE_BYTES, MAX_CLIPBOARD_IMAGE_DIMENSION,
};
pub use graphical::{
    rgba_len, shared_field_base, AuthKind, CertPrompt, CertPromptReceiver, CursorReceiver,
    CursorShape, CursorUpdate, CursorViolation, DirtyRect, FrameReceiver, FrameUpdate,
    FrameViolation, GraphicalBackend, GraphicalCapabilities, GraphicalState, InputEvent,
    RectViolation, RemoteClipboardFile, SanitizedFrame, SessionStateMachine, MAX_CURSOR_DIMENSION,
    MAX_FRAMEBUFFER_DIMENSION, MAX_RECONNECT_ATTEMPTS,
};
pub use graphical_resolution::{
    fixed_resolution_fields, fixed_resolution_requested, is_fixed_mode, normalize_fixed_size,
    RESOLUTION_MODE_KEY,
};
pub use lifecycle::SessionStatus;
pub use plugin_type_id::{
    is_plugin_type_id, parse_plugin_type_id, plugin_type_id, LegacyResolution,
    LegacyTypeIdResolver, PLUGIN_TYPE_ID_PREFIX,
};
pub use registry::{
    register_core_backends, ConnectionFactory, ConnectionTypeInfo, ConnectionTypeRegistry,
};
pub use schema::*;
pub use validation::{validate_settings, ValidationError};

use std::sync::Arc;

use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::{MonitoringProvider, ProcessManager};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

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
/// Serde default for [`Capabilities::terminal`]: terminal-capable.
///
/// Ensures capabilities serialized before the `terminal` field existed
/// (older agents/configs) deserialize as `terminal: true`, preserving the
/// pre-existing behaviour where every connection type opened a terminal tab.
fn default_terminal() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Whether this connection supports system monitoring (CPU, memory, etc.).
    pub monitoring: bool,
    /// Whether this connection supports file browsing (SFTP, local fs, etc.).
    pub file_browser: bool,
    /// Whether this connection is a graphical remote-desktop session.
    ///
    /// Defaults to `false` (via `#[serde(default)]`) so capabilities serialized
    /// before this field existed deserialize as non-graphical. A graphical type
    /// (VNC, RDP) sets `graphical: true` **and** `terminal: false`; the desktop
    /// routes it through the [`GraphicalSessionManager`] and opens it straight
    /// into a `remote-desktop` canvas tab, the same way `terminal: false` opens
    /// FTP into a browser-only tab. Access the framebuffer surface via
    /// [`ConnectionType::graphical()`].
    #[serde(default)]
    pub graphical: bool,
    /// Whether terminal resize is supported (false for serial; telnet
    /// propagates it via NAWS).
    pub resize: bool,
    /// Whether sessions of this type can persist across agent reconnections.
    pub persistent: bool,
    /// Whether this connection type has an interactive terminal.
    ///
    /// Defaults to `true` for backward compatibility: capabilities serialized
    /// before this field existed (older agents/configs) deserialize as
    /// terminal-capable, and every pre-existing connection type is. Terminal-less
    /// types — FTP, which browses files with no shell — set this to `false`, and
    /// the desktop opens them straight into a browser-only tab with no terminal
    /// session (no `create_connection`). Any future terminal-less type inherits
    /// this without per-type special-casing.
    #[serde(default = "default_terminal")]
    pub terminal: bool,
    /// Whether this connection type can host SSH-style port forwards (tunnels).
    ///
    /// Replaces the old hardcoded `type_id == "ssh"` gate in the tunnel manager
    /// (PARITY-001): a backend that can build a port forward advertises this, so
    /// the gate is capability-driven rather than a brittle name comparison. Only
    /// SSH sets it today — the forward is built on an SSH session, and agent-hosted
    /// tunnels relocate *where* that SSH forward runs but still require an SSH
    /// connection. Backends with no forwarding mechanism (serial, telnet, docker,
    /// VNC, RDP, FTP, local, WSL) leave it `false`.
    ///
    /// Defaults to `false` (via `#[serde(default)]`) so capabilities serialized
    /// before this field existed deserialize as non-tunnel-capable.
    #[serde(default)]
    pub tunneling: bool,
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

    /// Connect, abortable via an optional cancellation token.
    ///
    /// Cancelling the token aborts an in-flight connect (TCP / handshake / each
    /// jump-host hop) promptly instead of waiting out the connect timeout — used
    /// to cancel a session that is still *connecting* (#952). The default
    /// implementation ignores the token and delegates to
    /// [`connect`](Self::connect); backends that support mid-connect cancellation
    /// (SSH) override it.
    async fn connect_cancellable(
        &mut self,
        settings: serde_json::Value,
        _cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        self.connect(settings).await
    }

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

    /// An owned, shareable handle to this connection's monitoring provider —
    /// the [`Arc`] analogue of [`monitoring`](Self::monitoring).
    ///
    /// Returned as an `Arc` so a caller can `await` a provider method (the
    /// network `subscribe` / `unsubscribe` / `set_interval`) **without** holding
    /// the lock that guards this connection. The session manager clones the
    /// handle out from under its `sessions` map lock, releases the lock, then
    /// performs the network call (CONC-007): holding a map-wide lock across a
    /// provider network call would stall every other session operation for the
    /// call's duration and risks a lock-ordering deadlock.
    ///
    /// **Contract:** a backend that returns `Some` from
    /// [`monitoring`](Self::monitoring) MUST return `Some` here too — the same
    /// provider — so preferring the handle never loses a monitoring capability.
    /// The default returns `None`, matching a backend with no monitoring
    /// capability; only backends whose provider does real network I/O override
    /// it.
    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        None
    }

    /// Access the file browser, if this connection type supports it.
    ///
    /// Returns `None` when [`Capabilities::file_browser`] is `false`.
    fn file_browser(&self) -> Option<&dyn FileBrowser>;

    /// An owned, shareable handle to this connection's process manager
    /// (PROD-0028), if the type supports listing / terminating processes.
    ///
    /// Returned as an [`Arc`] — the analogue of
    /// [`monitoring_handle`](Self::monitoring_handle) — so the session manager
    /// can clone it out from under its `sessions` lock and `await` a possibly
    /// slow `list_processes` / `kill_process` (an exec / SSH round-trip) without
    /// holding that lock (CONC-007). The default returns `None`, matching a
    /// backend with no process capability (serial, telnet, graphical); the
    /// local-shell, SSH, Docker, and WSL backends override it. A backend that
    /// returns `None` here has no process capability and the desktop surfaces
    /// [`ProcessError::NotSupported`](crate::monitoring::ProcessError::NotSupported).
    fn process_manager(&self) -> Option<Arc<dyn ProcessManager + Send + Sync>> {
        None
    }

    /// Access the graphical (framebuffer) surface, if this is a remote-desktop
    /// connection type.
    ///
    /// Returns `None` for every terminal / file-browser type; graphical
    /// backends (VNC, RDP, the mock) override this to return
    /// `Some(&dyn GraphicalBackend)` once connected. Default `None` so existing
    /// backends need no change. Mirrors [`file_browser()`](Self::file_browser).
    fn graphical(&self) -> Option<&dyn GraphicalBackend> {
        None
    }
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
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            tunneling: true,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["monitoring"], true);
        assert_eq!(json["fileBrowser"], true);
        assert_eq!(json["graphical"], false);
        assert_eq!(json["resize"], true);
        assert_eq!(json["persistent"], false);
        assert_eq!(json["terminal"], true);
        assert_eq!(json["tunneling"], true);

        let deserialized: Capabilities = serde_json::from_value(json).unwrap();
        assert!(deserialized.monitoring);
        assert!(deserialized.file_browser);
        assert!(!deserialized.graphical);
        assert!(deserialized.resize);
        assert!(!deserialized.persistent);
        assert!(deserialized.terminal);
        assert!(deserialized.tunneling);
    }

    #[test]
    fn capabilities_tunneling_defaults_false_when_absent() {
        // Backward compatibility: capabilities serialized before the `tunneling`
        // field existed omit it on the wire. Such payloads must deserialize as
        // non-tunnel-capable so an older agent never appears able to host a
        // port forward it cannot build.
        let legacy = serde_json::json!({
            "monitoring": false,
            "fileBrowser": false,
            "resize": true,
            "persistent": false,
            "terminal": true,
        });
        let deserialized: Capabilities = serde_json::from_value(legacy).unwrap();
        assert!(
            !deserialized.tunneling,
            "missing `tunneling` must default to false (not tunnel-capable)"
        );
    }

    #[test]
    fn capabilities_terminal_defaults_true_when_absent() {
        // Backward compatibility: capabilities serialized by an older agent or
        // config predate the `terminal` field, so the wire form omits it. Such
        // payloads must deserialize as terminal-capable, preserving the prior
        // behaviour where every connection type opened a terminal tab.
        let legacy = serde_json::json!({
            "monitoring": false,
            "fileBrowser": true,
            "resize": false,
            "persistent": false,
        });
        let deserialized: Capabilities = serde_json::from_value(legacy).unwrap();
        assert!(
            deserialized.terminal,
            "missing `terminal` must default to true (terminal-capable)"
        );
    }

    #[test]
    fn capabilities_terminal_false_round_trips() {
        // A terminal-less type (e.g. FTP) reports terminal: false, and that
        // must survive a serialize → deserialize round trip unchanged.
        let caps = Capabilities {
            monitoring: false,
            file_browser: true,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: false,
            tunneling: false,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["terminal"], false);
        let deserialized: Capabilities = serde_json::from_value(json).unwrap();
        assert!(!deserialized.terminal);
    }

    #[test]
    fn capabilities_camel_case_keys() {
        let caps = Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        };
        let json = serde_json::to_value(&caps).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("graphical"));
        assert!(obj.contains_key("monitoring"));
        assert!(obj.contains_key("fileBrowser"));
        assert!(obj.contains_key("resize"));
        assert!(obj.contains_key("persistent"));
        assert!(obj.contains_key("terminal"));
        assert!(obj.contains_key("tunneling"));
        // Ensure snake_case keys are NOT present.
        assert!(!obj.contains_key("file_browser"));
    }
}
