//! Adapter that presents a loaded plugin backend as a
//! [`ConnectionType`](crate::connection::ConnectionType).
//!
//! The host loader ([`super::host`]) produces an
//! [`Arc<LoadedLibrary>`](super::host::LoadedLibrary) that can create backend
//! sessions over the stable plugin ABI. [`PluginConnectionType`] wraps one such
//! library so a plugin-provided terminal backend slots into the same
//! [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry) and
//! session machinery as the built-in backends (local shell, SSH, telnet, …).
//!
//! # Output bridging
//!
//! The plugin ABI delivers terminal output through a
//! [`PluginOutputSender`](termihub_plugin_api::PluginOutputSender), which the
//! host builds over a synchronous `std::sync::mpsc` channel. The
//! [`ConnectionType`](crate::connection::ConnectionType) contract instead exposes
//! an async `tokio::sync::mpsc` receiver via
//! [`subscribe_output`](crate::connection::ConnectionType::subscribe_output). A
//! small forwarding thread bridges the two — the same pattern the telnet and
//! serial backends use to move a blocking reader onto the async channel.
//!
//! # Scope
//!
//! This is the *load-and-register* adapter (#1995). Deriving a real
//! [`SettingsSchema`](crate::connection::SettingsSchema) from the plugin's
//! declared `configSchema`, and wiring the type through the connection editor and
//! session-creation flow, is connection-type wiring left to #1999; until then the
//! schema is empty and the raw settings JSON is forwarded to the plugin verbatim.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use termihub_plugin_api::{LoadedBackend, PluginError, PluginOutputSender};

use crate::connection::{
    Capabilities, ConnectionType, OutputReceiver, OutputSender, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use super::host::LoadedLibrary;
use super::security::{PermissionError, PermissionSet};
use super::PluginPermission;

/// Channel capacity for output forwarded from the plugin to the terminal.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// A [`ConnectionType`] backed by a dynamically-loaded plugin library.
///
/// Holds an [`Arc<LoadedLibrary>`] so the plugin's code stays mapped for as long
/// as this session (and hence any [`LoadedBackend`] it created) is alive.
pub struct PluginConnectionType {
    library: Arc<LoadedLibrary>,
    connection_type: String,
    display_name: String,
    /// The permissions this plugin was granted, carried so host-mediated
    /// capabilities (filesystem path resolution, network, …) can enforce them
    /// per session (concept §13).
    permissions: PermissionSet,
    /// The active session backend, `None` until [`connect`](ConnectionType::connect).
    backend: Option<LoadedBackend>,
    /// Current output sink; swapped by
    /// [`subscribe_output`](ConnectionType::subscribe_output). The forwarding
    /// thread reads the latest value each iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

impl PluginConnectionType {
    /// Build a fresh, unconnected connection of the given plugin type, scoped to
    /// the plugin's granted `permissions`.
    #[must_use]
    pub fn new(
        library: Arc<LoadedLibrary>,
        connection_type: String,
        display_name: String,
        permissions: PermissionSet,
    ) -> Self {
        Self {
            library,
            connection_type,
            display_name,
            permissions,
            backend: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }

    /// The permission set this plugin session was granted.
    #[must_use]
    pub fn permissions(&self) -> &PermissionSet {
        &self.permissions
    }

    /// Require that this plugin holds `permission` before a host-mediated
    /// capability acts on its behalf. Returns [`PermissionError::Denied`]
    /// otherwise (e.g. a backend without `network` cannot open connections).
    pub fn require_permission(&self, permission: PluginPermission) -> Result<(), PermissionError> {
        self.permissions.require(permission)
    }

    /// Resolve and authorize a plugin-supplied filesystem path against this
    /// plugin's declared scope, rejecting paths outside it (concept §13). This is
    /// the guard a host-mediated filesystem bridge routes plugin paths through.
    pub fn resolve_scoped_path(&self, requested: &Path) -> Result<PathBuf, PermissionError> {
        self.permissions.check_path(requested)
    }
}

/// Map a plugin-side error to the session-error the terminal layer understands.
fn map_plugin_error(err: PluginError) -> SessionError {
    match err {
        PluginError::ChannelClosed | PluginError::NotAlive => {
            SessionError::NotRunning(err.to_string())
        }
        PluginError::InvalidConfig(_) => SessionError::InvalidConfig(err.to_string()),
        other => SessionError::SpawnFailed(other.to_string()),
    }
}

#[async_trait::async_trait]
impl ConnectionType for PluginConnectionType {
    fn type_id(&self) -> &str {
        &self.connection_type
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn settings_schema(&self) -> SettingsSchema {
        // Deriving a form schema from the plugin's declared `configSchema` is
        // #1999; the raw settings JSON is forwarded to the plugin as-is for now.
        SettingsSchema { groups: vec![] }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.backend.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        let config_json = serde_json::to_string(&settings)
            .map_err(|e| SessionError::InvalidConfig(format!("settings not serializable: {e}")))?;

        // Bridge the plugin's synchronous output channel onto the async terminal
        // channel. The plugin sends `Vec<u8>` on `std_tx`; the forwarding thread
        // relays each chunk to whichever `OutputSender` is currently subscribed.
        let (std_tx, std_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let output = PluginOutputSender::from_sender(std_tx);

        let backend = self
            .library
            .create_backend(&config_json, output)
            .map_err(map_plugin_error)?;

        let output_tx = Arc::clone(&self.output_tx);
        std::thread::spawn(move || {
            while let Ok(chunk) = std_rx.recv() {
                let guard = output_tx.lock().unwrap_or_else(|e| e.into_inner());
                // Deliver to the current subscriber if any; a dropped receiver or
                // no active subscription (output before the first
                // `subscribe_output`) simply drops the chunk, matching the other
                // backends. Keep draining so the plugin's sender never blocks.
                if let Some(sender) = guard.as_ref() {
                    let _ = sender.blocking_send(chunk);
                }
            }
        });

        self.backend = Some(backend);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(backend) = self.backend.take() {
            // Best-effort graceful close; the backend drops (running its FFI
            // destructor) at the end of this scope regardless.
            let _ = backend.close();
        }
        // Dropping the sender lets the forwarding thread's `recv` end once the
        // plugin's own sender is gone.
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.backend.as_ref().is_some_and(LoadedBackend::is_alive)
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        backend.write_input(data).map_err(map_plugin_error)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        backend.resize(cols, rows).map_err(map_plugin_error)
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}
